// Funding an identity from external DASH, all over DAPI (PLAN 4.4, Dash Bridge's flow without Insight):
//   1. a one-time key at the DIP-13 funding path (registration m/9'/c'/5'/1'/i', top-up m/9'/c'/5'/2'/i'/n)
//   2. watchAddressForDeposit subscribes BEFORE the address is shown (IS-locks are never replayed)
//   3. type-8 asset lock spending the deposit, its bytes persisted before broadcast; a second watcher on the lock's txid and
//      inputs is open BEFORE the broadcast, and its IS-lock bytes are persisted the moment they arrive
//   4. instant proof (IS-lock); otherwise, or when Platform refuses it, a chain proof at Platform's coreChainLockedHeight
//   5. identities.create / identities.topUp, then a proved read that the identity (or the new balance) is there
// Progress is a FundingRecord in a FundingStore: txids, the signed lock tx, the IS-lock, heights. Never a key or the phrase: a
// reload resumes once the user unlocks the same seed again (the one-time key is re-derived from it).
import { BloomFilter, type Dapi, type Watcher } from '@govhub/dapi';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hash160, hexToBytes, identifierBytes, reversed, u32be, u32le, wipe } from './bytes.ts';
import { addressOf, isValidPrivateKey, publicKeyOf, type Network } from './keys.ts';
import { CREATE_KEYS, MIN_CREATE_DEPOSIT_DUFFS, MIN_TOPUP_DEPOSIT_DUFFS } from './layout.ts';
import type { AssetLockProofInput, PlatformPort, SigningKey } from './platform.ts';
import { registrationFundingPath, topUpFundingPath, type SeedWallet } from './seed.ts';
import { buildAssetLock, identityIdFromOutpoint, type Utxo } from './tx.ts';

export type FundingKind = 'create' | 'topup';
export type FundingState = 'awaiting-deposit' | 'locking' | 'locked' | 'registering' | 'done';

/** Persisted progress. Public data only (anyone could read it off the chain once broadcast). */
export interface FundingRecord {
  v: 1;
  key: string;
  kind: FundingKind;
  network: Network;
  identityIndex: number;
  topUpIndex?: number;
  /** Top-up target. For create, the id computed from the lock's outpoint. */
  identityId?: string;
  address: string;
  watchFromHeight?: number;
  deposits: Array<{ txid: string; vout: number; value: string }>;
  lock?: { raw: string; txid: string; creditIndex: number; burnVout: number; lockDuffs: string; feeDuffs: string };
  broadcastAt?: number;
  isLock?: string;
  isLockAfterMs?: number;
  proofKind?: 'instant' | 'chain';
  balanceBefore?: string;
  state: FundingState;
  createdAt: number;
  updatedAt: number;
}

export interface FundingStore {
  load(key: string): FundingRecord | null;
  save(rec: FundingRecord): void;
  remove(key: string): void;
  list(): FundingRecord[];
}

/** localStorage (or any Storage) under `govhub.funding.<key>`. */
export function storageFundingStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>): FundingStore {
  const P = 'govhub.funding.';
  return {
    load: (key) => {
      try {
        const raw = storage.getItem(P + key);
        return raw ? (JSON.parse(raw) as FundingRecord) : null;
      } catch {
        return null;
      }
    },
    save: (rec) => storage.setItem(P + rec.key, JSON.stringify({ ...rec, updatedAt: Date.now() })),
    remove: (key) => storage.removeItem(P + key),
    list: () => {
      const out: FundingRecord[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k?.startsWith(P)) continue;
        try {
          out.push(JSON.parse(storage.getItem(k) ?? '') as FundingRecord);
        } catch {
          /* ignore a damaged record */
        }
      }
      return out;
    },
  };
}

export const fundingKey = (kind: FundingKind, network: Network, identityIndex: number, topUpIndex?: number): string =>
  kind === 'create' ? `${network}.create.${identityIndex}` : `${network}.topup.${identityIndex}.${topUpIndex ?? 0}`;

export interface FundingView {
  state: FundingState;
  address: string;
  /** `dash:<address>?amount=<min>` for the QR code. */
  uri: string;
  minDuffs: number;
  receivedDuffs: bigint;
  depositTxids: string[];
  lockTxid?: string;
  isLocked: boolean;
  proofKind?: 'instant' | 'chain';
  identityId?: string;
  note?: string;
}

export interface FundingOptions {
  wallet: SeedWallet | null;
  dapi: Dapi;
  platform: PlatformPort;
  store: FundingStore;
  kind: FundingKind;
  /** create: the new identity's index. topup: the index of the session identity (selects the top-up key branch). */
  identityIndex: number;
  /** topup only. */
  topUp?: { identityId: string; index: number };
  /**
   * Top-up without a seed (key-paste sessions): the one-time key comes from `sessionTopUpKey` instead of the DIP-13 path, so a
   * reload resumes once the same key is pasted again. `wallet` may then be null.
   */
  sessionKey?: Uint8Array;
  minDepositDuffs?: number;
  /** How long to wait for the asset lock's IS-lock before switching to the chain-lock proof. Default 60 s. */
  isLockWaitMs?: number;
  /** Poll interval for mined height / Platform's chain-locked height. Default 8 s. */
  pollMs?: number;
  signal?: AbortSignal;
  onUpdate?(v: FundingView): void;
  /** Diagnostics only (no secrets are ever passed). */
  log?(msg: string): void;
}

export class FundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FundingError';
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(signal.reason)), { once: true });
  });

const outpointBytes = (txid: string, vout: number) => concatBytes(reversed(hexToBytes(txid)), u32le(vout));

const errText = (e: unknown): string => {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
};
/** Messages from the SDK can echo transition bytes; strip long hex/base58/base64 runs before showing or logging them. */
export const redact = (s: string): string => s.replace(/[0-9a-fA-F]{64,}/g, '[hex]').replace(/[1-9A-HJ-NP-Za-km-z]{50,}/g, '[b58]').replace(/[A-Za-z0-9+/=]{80,}/g, '[b64]');

/**
 * The tip height a node reports (getBestBlockHeight, a claim). Not `dapi.getBestBlockHeight()`: that one insists on
 * `isSynced`, and testnet evonodes have reported `isSynced: false` / status ERROR while serving current blocks (2026-10-24, V24).
 * Callers only use it as a stream start a few blocks back, so a lagging node costs a few replayed blocks at most.
 */
export async function tipHeight(dapi: Dapi, signal?: AbortSignal): Promise<number> {
  const { value } = await dapi.call((core, s) => core.getBestBlockHeight({ signal: s }), { signal });
  return value;
}

/** Height at which the tx was mined, as a node claims it (0 while in the mempool). Platform re-checks it against its own Core. */
export async function minedHeight(dapi: Dapi, txid: string, signal?: AbortSignal): Promise<number> {
  try {
    const { value } = await dapi.call((core, s) => core.getTransaction(txid, { signal: s }), { signal });
    return value.height > 0 ? value.height : 0;
  } catch (e) {
    if ((e as { code?: number }).code === 5) return 0;
    throw e;
  }
}

/** Waits until the tx is mined and Platform has seen a ChainLock at or above it; returns Platform's chain-locked height. */
export async function waitForChainLockedHeight(dapi: Dapi, platform: PlatformPort, txid: string, o: { pollMs?: number; signal?: AbortSignal; onWait?(mined: number, platformHeight: number): void } = {}): Promise<number> {
  for (;;) {
    const h = await minedHeight(dapi, txid, o.signal).catch(() => 0);
    if (h > 0) {
      const cl = await platform.coreChainLockedHeight().catch(() => 0);
      if (cl >= h) return cl;
      o.onWait?.(h, cl);
    } else o.onWait?.(0, 0);
    await sleep(o.pollMs ?? 8000, o.signal);
  }
}

/** Refusals that a chain proof can fix: Platform could not verify the IS-lock (quorum rotated away, or a node lagging). */
const instantProofRefused = (msg: string) => /instant ?lock|islock|InvalidInstantAssetLockProof|signature|quorum/i.test(msg);
/** The lock was already consumed: the earlier attempt landed even though its answer was lost. */
const alreadyUsed = (msg: string) => /already (been )?(used|consumed|exists)|IdentityAlreadyExists|AssetLockTransactionIsAlreadyUsed|already completely used/i.test(msg);

/**
 * Runs (or resumes) one funding. Resolves with the identity id once Platform proves it (create) or proves the larger balance (top-up).
 * Persists after every step; calling it again with the same seed and indexes continues where it stopped.
 */
export async function runFunding(o: FundingOptions): Promise<{ identityId: string; record: FundingRecord }> {
  const { wallet, dapi, platform, store, kind, identityIndex, signal } = o;
  const network = platform.network;
  if (dapi.network !== network || (wallet && wallet.network !== network)) throw new FundingError(`network mismatch: seed ${wallet?.network}, DAPI ${dapi.network}, Platform ${network}`);
  if (kind === 'topup' && !o.topUp) throw new FundingError('top-up target missing');
  if (!wallet && !(kind === 'topup' && o.sessionKey)) throw new FundingError('funding needs the recovery phrase (or, for a top-up, the signed-in key)');
  const minDuffs = o.minDepositDuffs ?? (kind === 'create' ? MIN_CREATE_DEPOSIT_DUFFS : MIN_TOPUP_DEPOSIT_DUFFS);
  const key = wallet ? fundingKey(kind, network, identityIndex, o.topUp?.index) : `${network}.topup.k.${o.topUp!.identityId}.${o.topUp!.index}`;
  const fk = wallet
    ? wallet.derive(kind === 'create' ? registrationFundingPath(network, identityIndex) : topUpFundingPath(network, identityIndex, o.topUp!.index))
    : sessionTopUpKey(o.sessionKey!, o.topUp!.identityId, o.topUp!.index);
  const h160 = hash160(fk.publicKey);
  const address = addressOf(fk.publicKey, network);
  const log = o.log ?? (() => {});
  const now = Date.now();
  let rec: FundingRecord =
    store.load(key) ??
    ({
      v: 1, key, kind, network, identityIndex, topUpIndex: o.topUp?.index, identityId: o.topUp?.identityId, address, deposits: [], state: 'awaiting-deposit', createdAt: now, updatedAt: now,
    } satisfies FundingRecord);
  if (rec.address !== address) {
    wipe(fk.privateKey);
    throw new FundingError('the saved funding record belongs to another recovery phrase');
  }
  const save = () => store.save(rec);
  const received = () => rec.deposits.reduce((a, d) => a + BigInt(d.value), 0n);
  const view = (note?: string): FundingView => ({
    state: rec.state,
    address,
    uri: `dash:${address}?amount=${(minDuffs / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`,
    minDuffs,
    receivedDuffs: received(),
    depositTxids: [...new Set(rec.deposits.map((d) => d.txid))],
    lockTxid: rec.lock?.txid,
    isLocked: !!rec.isLock,
    proofKind: rec.proofKind,
    identityId: rec.identityId,
    note,
  });
  const update = (note?: string) => {
    save();
    o.onUpdate?.(view(note));
  };
  const watchers: Watcher[] = [];
  try {
    // ---- 1-2: deposit -----------------------------------------------------------------------------------------------------
    if (rec.state === 'awaiting-deposit') {
      rec.watchFromHeight ??= Math.max(0, (await tipHeight(dapi, signal)) - 3);
      save();
      let resolveFunded!: () => void;
      const funded = new Promise<void>((r) => (resolveFunded = r));
      const check = () => {
        if (received() >= BigInt(minDuffs)) resolveFunded();
      };
      const w = await dapi.watchAddressForDeposit(
        h160,
        {
          onTx: ({ tx, matches }) => {
            for (const vout of matches) {
              if (rec.deposits.some((d) => d.txid === tx.txid && d.vout === vout)) continue;
              rec.deposits.push({ txid: tx.txid, vout, value: tx.outputs[vout]!.value.toString() });
            }
            update(`deposit ${tx.txid.slice(0, 12)}… seen`);
            check();
          },
          onIsLock: () => {},
          onError: (e, ctx) => log(`watch ${ctx.phase}: ${redact(errText(e))}`),
        },
        { fromHeight: rec.watchFromHeight, signal },
      );
      watchers.push(w);
      update(); // the address may be shown now: the subscription is live
      check();
      await Promise.race([funded, new Promise((_, rej) => signal?.addEventListener('abort', () => rej(signal.reason), { once: true }))]);
      // A wallet may split a payment across txs that arrive together: give the streams a moment before locking.
      await sleep(1500, signal);
      w.cancel();
      rec.state = 'locking';
      update();
    }

    // ---- 3: asset lock ------------------------------------------------------------------------------------------------------
    if (!rec.lock) {
      const utxos: Utxo[] = rec.deposits.map((d) => ({ txid: d.txid, vout: d.vout, value: BigInt(d.value) }));
      const built = buildAssetLock({ utxos, fundingKey: fk.privateKey, creditPubKeyHash: h160 });
      rec.lock = { raw: bytesToHex(built.raw), txid: built.txid, creditIndex: built.creditIndex, burnVout: built.burnVout, lockDuffs: built.lockDuffs.toString(), feeDuffs: built.feeDuffs.toString() };
      if (kind === 'create') rec.identityId = identityIdFromOutpoint(built.txid, built.creditIndex);
      update('asset lock built');
    }
    const lock = rec.lock;
    if (rec.state === 'locking' || rec.state === 'locked') {
      // Watch the lock's txid and inputs on several nodes BEFORE broadcasting: its IS-lock arrives within seconds and only once.
      if (!rec.isLock) {
        const f = new BloomFilter(2 + rec.deposits.length).insert(h160).insert(reversed(hexToBytes(lock.txid)));
        for (const d of rec.deposits) f.insert(outpointBytes(d.txid, d.vout));
        const lw = await dapi.watchTransactions(
          f.toJSON(),
          {
            onTx: () => {},
            onIsLock: ({ lock: l, bytes }) => {
              if (l.txid !== lock.txid || rec.isLock) return;
              rec.isLock = bytesToHex(bytes);
              if (rec.broadcastAt) rec.isLockAfterMs = Date.now() - rec.broadcastAt;
              update('IS-lock received');
            },
            onError: (e, ctx) => log(`lock watch ${ctx.phase}: ${redact(errText(e))}`),
          },
          { fromHeight: Math.max(0, (await tipHeight(dapi, signal)) - 2), signal },
          (tx) => (tx.txid === lock.txid ? [0] : []),
        );
        watchers.push(lw);
      }
      if (rec.state === 'locking' || !(await minedHeight(dapi, lock.txid, signal).catch(() => 0))) {
        // Re-sending the same bytes is harmless; nodes answering "already known" count as success.
        await dapi.broadcastTransaction(hexToBytes(lock.raw), { signal });
        rec.broadcastAt ??= Date.now();
      }
      rec.state = 'locked';
      update('asset lock broadcast');
      const deadline = Date.now() + (o.isLockWaitMs ?? 60_000);
      while (!rec.isLock && Date.now() < deadline) await sleep(250, signal);
      for (const w of watchers.splice(0)) w.cancel();
      rec.state = 'registering';
      update(rec.isLock ? undefined : 'no IS-lock seen; using a chain-lock proof');
    }

    // ---- 4-5: register on Platform -----------------------------------------------------------------------------------------
    const identityId = rec.identityId!;
    const exists = async () => (kind === 'create' ? (await platform.identityKeys(identityId)) !== null : false);
    const before = async () => (rec.balanceBefore ??= ((await platform.balance(identityId)) ?? 0n).toString());
    if (kind === 'topup') {
      await before();
      save();
    }
    if (await exists()) {
      rec.state = 'done';
      update('identity already registered');
      return { identityId, record: rec };
    }
    const signingKeys: SigningKey[] =
      kind === 'create' ? CREATE_KEYS.map((k) => ({ ...k, privateKey: wallet!.identityKey(identityIndex, k.id).privateKey })) : [];
    try {
      const submit = async (proof: AssetLockProofInput) => {
        rec.proofKind = proof.kind;
        update(proof.kind === 'instant' ? 'registering with the IS-lock proof' : 'registering with a chain-lock proof');
        if (kind === 'create') await platform.createIdentity({ proof, assetLockKey: fk.privateKey, keys: signingKeys });
        else await platform.topUpIdentity({ identityId, proof, assetLockKey: fk.privateKey });
      };
      const chainProof = async (): Promise<AssetLockProofInput> => {
        const cl = await waitForChainLockedHeight(dapi, platform, lock.txid, {
          pollMs: o.pollMs,
          signal,
          onWait: (m, p) => o.onUpdate?.(view(m ? `mined at ${m}; waiting for Platform's chain lock (${p})` : 'waiting for the asset lock to be mined')),
        });
        return { kind: 'chain', txid: lock.txid, creditIndex: lock.creditIndex, coreChainLockedHeight: cl };
      };
      let done = false;
      if (rec.isLock) {
        try {
          await submit({ kind: 'instant', tx: hexToBytes(lock.raw), isLock: hexToBytes(rec.isLock), creditIndex: lock.creditIndex });
          done = true;
        } catch (e) {
          const m = errText(e);
          log(`instant proof: ${redact(m)}`);
          if (alreadyUsed(m)) done = true;
          else if (!instantProofRefused(m) && (await settled(kind, platform, identityId, rec))) done = true;
        }
      }
      if (!done && !(await settled(kind, platform, identityId, rec))) {
        try {
          await submit(await chainProof());
        } catch (e) {
          const m = errText(e);
          log(`chain proof: ${redact(m)}`);
          if (!alreadyUsed(m)) throw new FundingError(`Platform refused the registration: ${redact(m)}`);
        }
      }
    } finally {
      for (const k of signingKeys) wipe(k.privateKey);
    }
    // A proved read must show the result; nodes can lag a block or two.
    for (let i = 0; !(await settled(kind, platform, identityId, rec)); i++) {
      if (i >= 20) throw new FundingError('Platform accepted the transition but the result is not visible yet. Reload in a minute to check again.');
      await sleep(3000, signal);
    }
    rec.state = 'done';
    update();
    return { identityId, record: rec };
  } finally {
    for (const w of watchers) w.cancel();
    wipe(fk.privateKey);
  }
}

/** Whether the registration has landed: the identity exists (create), or its balance grew past the recorded one (top-up). */
async function settled(kind: FundingKind, platform: PlatformPort, identityId: string, rec: FundingRecord): Promise<boolean> {
  try {
    if (kind === 'create') return (await platform.identityKeys(identityId)) !== null;
    const b = await platform.balance(identityId);
    return b !== null && rec.balanceBefore !== undefined && b > BigInt(rec.balanceBefore);
  } catch {
    return false;
  }
}

/**
 * One-time top-up key for a session without a seed: HMAC-SHA256(sessionKey, "govhub/topup/v1" || identityId || u32be(n)), re-drawn
 * with a counter in the (negligible) case it is not a valid scalar. Deterministic, so nothing secret has to be stored to resume.
 */
export function sessionTopUpKey(sessionKey: Uint8Array, identityId: string, n: number): { privateKey: Uint8Array; publicKey: Uint8Array } {
  for (let ctr = 0; ; ctr++) {
    const k = hmac(sha256, sessionKey, concatBytes(new TextEncoder().encode('govhub/topup/v1'), identifierBytes(identityId), u32be(n), Uint8Array.of(ctr)));
    if (isValidPrivateKey(k)) return { privateKey: k, publicKey: publicKeyOf(k) };
    wipe(k);
  }
}

/** The pending fundings for a network, newest first (the UI offers "continue" for these after a reload). */
export const pendingFundings = (store: FundingStore, network: Network): FundingRecord[] =>
  store
    .list()
    .filter((r) => r.network === network && r.state !== 'done')
    .sort((a, b) => b.updatedAt - a.updatedAt);
