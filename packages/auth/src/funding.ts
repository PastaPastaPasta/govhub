// Funding an identity from external DASH, all over DAPI (PLAN 4.4, Dash Bridge's flow without Insight):
//   1. a one-time key at the DIP-13 funding path (registration m/9'/c'/5'/1'/i', top-up m/9'/c'/5'/2'/i'/n)
//   2. watchAddressForDeposit subscribes BEFORE the address is shown (IS-locks are never replayed); a deposit counts once it is
//      IS-locked or merkle-proven in a block, P2PKH outputs only; the watcher stays open until the end so late payments are reported
//   3. type-8 asset lock spending the deposits (refused below Platform's minimum or above 100 inputs), its bytes persisted before
//      broadcast; a second watcher on the lock's txid and inputs is open BEFORE the broadcast and its IS-lock bytes are persisted on
//      arrival; a lock whose inputs the network rejects (spent / missing) is dropped and rebuilt from the deposits that still count
//   4. instant proof (IS-lock); otherwise, or when Platform refuses it, a chain proof at Platform's coreChainLockedHeight
//   5. identities.create / identities.topUp, then a proved read that the identity (or the new balance) is there
// Progress is a FundingRecord in a FundingStore, keyed by the funding key's hash160 (so seeds never collide): txids, the signed lock
// tx, the IS-lock, heights. Never a key or the phrase: a reload resumes once the user unlocks the same seed (or, for a seedless
// top-up, pastes the same key) again. One tab at a time per record (Web Locks, where the platform has them).
import { BloomFilter, classifyScript, type Dapi, type Watcher } from '@govhub/dapi';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesEqual, bytesToHex, concatBytes, hash160, hexToBytes, identifierBytes, reversed, u32be, u32le, wipe } from './bytes.ts';
import { addressOf, isValidPrivateKey, publicKeyOf, type Network } from './keys.ts';
import { CREATE_KEYS, MIN_CREATE_DEPOSIT_DUFFS, MIN_CREATE_LOCK_DUFFS, MIN_TOPUP_DEPOSIT_DUFFS, MIN_TOPUP_LOCK_DUFFS } from './layout.ts';
import type { AssetLockProofInput, PlatformPort, SigningKey } from './platform.ts';
import { registrationFundingPath, topUpFundingPath, type SeedWallet } from './seed.ts';
import { assertLive, type Session } from './signin.ts';
import { buildAssetLock, estimateAssetLockFee, identityIdFromOutpoint, MAX_ASSET_LOCK_INPUTS, type Utxo } from './tx.ts';

export type FundingKind = 'create' | 'topup';
export type FundingState = 'awaiting-deposit' | 'locking' | 'locked' | 'registering' | 'done';

export interface Deposit {
  txid: string;
  vout: number;
  value: string;
  /** IS-locked or merkle-proven in a block: only these are spent by the lock. */
  confirmed: boolean;
}

/** Persisted progress. Public data only (anyone could read it off the chain once broadcast). */
export interface FundingRecord {
  v: 2;
  key: string;
  kind: FundingKind;
  network: Network;
  identityIndex: number;
  topUpIndex?: number;
  /** Top-up target. For create, the id computed from the lock's outpoint. */
  identityId?: string;
  address: string;
  watchFromHeight?: number;
  deposits: Deposit[];
  /** Payments that arrived after the lock was built: they stay at the one-time address (the seed / key still controls it). */
  lateDeposits?: Array<{ txid: string; vout: number; value: string }>;
  lock?: { raw: string; txid: string; creditIndex: number; burnVout: number; lockDuffs: string; feeDuffs: string };
  broadcastAt?: number;
  isLock?: string;
  isLockAfterMs?: number;
  proofKind?: 'instant' | 'chain';
  balanceBefore?: string;
  /** Lock txids the network refused (never rebuilt into the same bytes again) and how many rebuilds happened (at most 2). */
  rejectedLocks?: string[];
  /** Hidden from the pending list by the user ("I never sent anything"); kept so a later resume still replays from watchFromHeight. */
  discarded?: boolean;
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
  const parse = (raw: string | null): FundingRecord | null => {
    try {
      const r = raw ? (JSON.parse(raw) as FundingRecord) : null;
      return r && r.v === 2 ? r : null;
    } catch {
      return null;
    }
  };
  return {
    load: (key) => parse(storage.getItem(P + key)),
    save: (rec) => storage.setItem(P + rec.key, JSON.stringify({ ...rec, updatedAt: Date.now() })),
    remove: (key) => storage.removeItem(P + key),
    list: () => {
      const out: FundingRecord[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        const r = k?.startsWith(P) ? parse(storage.getItem(k)) : null;
        if (r) out.push(r);
      }
      return out;
    },
  };
}

/** Records are keyed by the funding key's hash160, so two seeds (or two sessions) in one browser never share a record. */
export const fundingRecordKey = (network: Network, kind: FundingKind, keyHash160: Uint8Array): string => `${network}.${kind}.${bytesToHex(keyHash160)}`;

export interface FundingView {
  state: FundingState;
  address: string;
  /** `dash:<address>?amount=<min>` for the QR code. */
  uri: string;
  minDuffs: number;
  /** Counted deposits (IS-locked or in a block). */
  receivedDuffs: bigint;
  /** Seen but not yet IS-locked or mined. */
  pendingDuffs: bigint;
  lateDuffs: bigint;
  depositTxids: string[];
  lockTxid?: string;
  isLocked: boolean;
  proofKind?: 'instant' | 'chain';
  identityId?: string;
  note?: string;
}

export interface FundingOptions {
  /** The seed: derives the funding key (and, for create, the identity keys). */
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
   * Top-up without a seed (key-paste sessions): the one-time key comes from `sessionTopUpKey(session key)` instead of the DIP-13 path,
   * so a reload resumes once the same key is pasted again. Refused once the session has ended.
   */
  session?: Session;
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

/** Abort-aware sleep; the abort listener is removed when the timer fires (long waits poll many times). */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    if (signal?.aborted) return rej(signal.reason);
    const onAbort = () => (clearTimeout(t), rej(signal!.reason));
    const t = setTimeout(() => (signal?.removeEventListener('abort', onAbort), res()), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
/** Rejects when `signal` aborts (also when it already has). */
const aborted = (signal?: AbortSignal) =>
  new Promise<never>((_, rej) => {
    if (signal?.aborted) return rej(signal.reason);
    signal?.addEventListener('abort', () => rej(signal.reason), { once: true });
  });

const outpointBytes = (txid: string, vout: number) => concatBytes(reversed(hexToBytes(txid)), u32le(vout));

const errText = (e: unknown): string => {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
};
const errCode = (e: unknown): number | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'number' ? c : undefined;
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
    if (errCode(e) === 5) return 0;
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

/**
 * What Platform's answer to a registration means. Only the consensus errors themselves count (rs-dpp errors/consensus/codes.rs):
 *  - 'used': the outpoint is already consumed (10504) or the identity exists (40200): an earlier attempt landed
 *  - 'key-conflict': a key is already registered to another identity (40206 / 40207)
 *  - 'instant-refused': Platform could not verify the IS-lock; a chain proof may still work
 *  - 'other': anything else (network errors, timeouts): check the result, never assume success
 */
export type RegistrationOutcome = 'used' | 'key-conflict' | 'instant-refused' | 'other';
export function classifyRegistrationError(e: unknown): RegistrationOutcome {
  const code = errCode(e);
  const m = errText(e);
  if (code === 10504 || code === 40200 || /\b(IdentityAssetLockTransactionOutPointAlreadyConsumedError|IdentityAlreadyExistsError)\b/.test(m)) return 'used';
  if (code === 40206 || code === 40207 || /\b(DuplicatedIdentityPublicKeyStateError|DuplicatedIdentityPublicKeyIdStateError)\b/.test(m)) return 'key-conflict';
  if (/\b(InvalidInstantAssetLockProofSignatureError|InvalidInstantAssetLockProofError|InvalidAssetLockProofCoreChainHeightError)\b/.test(m) || /instant ?lock|islock/i.test(m)) return 'instant-refused';
  return 'other';
}

/** The network rejected the lock's inputs: a deposit was double-spent, replaced or not seen yet by that node. */
const inputsRejected = (e: unknown) => /missing-?inputs|bad-txns-inputs-missingorspent|txn-mempool-conflict|inputs.*(spent|missing)/i.test(errText(e));

/**
 * Whether nodes know the lock: its mined height, 0 while in the mempool, 'unknown' only for NOT_FOUND (dapi.call asks a second node
 * before believing it). Any other failure throws: a failed lookup is never evidence that the lock does not exist.
 */
async function lockStatus(dapi: Dapi, txid: string, signal?: AbortSignal): Promise<number | 'unknown'> {
  try {
    const { value } = await dapi.call((core, s) => core.getTransaction(txid, { signal: s }), { signal });
    return value.height > 0 ? value.height : 0;
  } catch (e) {
    if (errCode(e) === 5) return 'unknown';
    throw e;
  }
}

/**
 * Broadcasts the lock. "Inputs missing or spent" is only believed after the lock's own txid is still unknown and three attempts a few
 * seconds apart (other nodes, which may simply not have seen the deposit yet) agree. Returns false only then; other errors throw.
 */
async function broadcastLock(dapi: Dapi, lock: { raw: string; txid: string }, isLocked: () => boolean, signal: AbortSignal | undefined, log: (m: string) => void): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      // Re-sending the same bytes is harmless; nodes answering "already known" count as success.
      await dapi.broadcastTransaction(hexToBytes(lock.raw), { signal });
      return true;
    } catch (e) {
      if (!inputsRejected(e)) throw e;
      log(`lock broadcast refused (${attempt + 1}): ${redact(errText(e))}`);
      // An IS-lock for it (seen by the lock watcher meanwhile) or any node knowing it means it is out there.
      if (isLocked() || (await lockStatus(dapi, lock.txid, signal)) !== 'unknown') return true;
      if (attempt >= 2) return isLocked();
      await sleep(4000 * (attempt + 1), signal);
    }
  }
}

/**
 * The deposits a lock spends: the largest counted outputs, at most MAX_ASSET_LOCK_INPUTS, skipping any worth less than the fee of
 * spending it, as long as they lock at least `minLock` after fees and add up to `minTotal`. Null while they do not (keep waiting).
 * So a stranger's flood of tiny payments cannot block a funding.
 */
export function pickInputs<T extends { value: string }>(counted: readonly T[], minLock: bigint, minTotal: bigint): T[] | null {
  const perInput = estimateAssetLockFee(2) - estimateAssetLockFee(1);
  const usable = counted.filter((d) => BigInt(d.value) > perInput).sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : BigInt(b.value) < BigInt(a.value) ? -1 : 0));
  const pick = usable.slice(0, MAX_ASSET_LOCK_INPUTS);
  const total = pick.reduce((a, d) => a + BigInt(d.value), 0n);
  return pick.length && total >= minTotal && total - estimateAssetLockFee(pick.length) >= minLock ? pick : null;
}

/** Runs `fn` holding an exclusive Web Lock named for the record, when the platform has Web Locks (browsers; not Node 22). */
async function withRecordLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: { request(n: string, o: { ifAvailable: boolean }, cb: (l: unknown) => Promise<T>): Promise<T> } } | undefined)?.locks;
  if (!locks) return fn();
  return locks.request(`govhub.funding.${key}`, { ifAvailable: true }, async (l) => {
    if (!l) throw new FundingError('This funding is already running in another tab or window. Continue it there.');
    return fn();
  });
}

/**
 * Runs (or resumes) one funding. Resolves with the identity id once Platform proves it (create) or proves the larger balance (top-up).
 * Persists after every step; calling it again with the same seed and indexes continues where it stopped.
 */
export async function runFunding(o: FundingOptions): Promise<{ identityId: string; record: FundingRecord }> {
  const { wallet, dapi, platform, kind, identityIndex } = o;
  const network = platform.network;
  if (dapi.network !== network || (wallet && wallet.network !== network)) throw new FundingError(`network mismatch: seed ${wallet?.network}, DAPI ${dapi.network}, Platform ${network}`);
  if (kind === 'topup' && !o.topUp) throw new FundingError('top-up target missing');
  if (o.session) assertLive(o.session);
  if (!wallet && !(kind === 'topup' && o.session)) throw new FundingError('funding needs the recovery phrase (or, for a top-up, the signed-in key)');
  const fk = wallet
    ? wallet.derive(kind === 'create' ? registrationFundingPath(network, identityIndex) : topUpFundingPath(network, identityIndex, o.topUp!.index))
    : sessionTopUpKey(o.session!.privateKey, o.topUp!.identityId, o.topUp!.index);
  const key = fundingRecordKey(network, kind, hash160(fk.publicKey));
  try {
    return await withRecordLock(key, () => fund(o, fk, key));
  } finally {
    wipe(fk.privateKey);
  }
}

async function fund(o: FundingOptions, fk: { privateKey: Uint8Array; publicKey: Uint8Array }, key: string): Promise<{ identityId: string; record: FundingRecord }> {
  const { wallet, dapi, platform, store, kind, identityIndex, signal } = o;
  const network = platform.network;
  const minDuffs = o.minDepositDuffs ?? (kind === 'create' ? MIN_CREATE_DEPOSIT_DUFFS : MIN_TOPUP_DEPOSIT_DUFFS);
  const minLock = BigInt(kind === 'create' ? MIN_CREATE_LOCK_DUFFS : MIN_TOPUP_LOCK_DUFFS);
  const h160 = hash160(fk.publicKey);
  const address = addressOf(fk.publicKey, network);
  const log = o.log ?? (() => {});
  const now = Date.now();
  const rec: FundingRecord =
    store.load(key) ??
    ({
      v: 2, key, kind, network, identityIndex, topUpIndex: o.topUp?.index, identityId: o.topUp?.identityId, address, deposits: [], state: 'awaiting-deposit', createdAt: now, updatedAt: now,
    } satisfies FundingRecord);
  if (rec.address !== address) throw new FundingError('the saved funding record belongs to another key');
  const save = () => store.save(rec);
  const sum = (l: ReadonlyArray<{ value: string }>) => l.reduce((a, d) => a + BigInt(d.value), 0n);
  const counted = () => rec.deposits.filter((d) => d.confirmed);
  const view = (note?: string): FundingView => ({
    state: rec.state,
    address,
    uri: `dash:${address}?amount=${(minDuffs / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`,
    minDuffs,
    receivedDuffs: sum(counted()),
    pendingDuffs: sum(rec.deposits.filter((d) => !d.confirmed)),
    lateDuffs: sum(rec.lateDeposits ?? []),
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
    // ---- 1-2: deposits. The watcher stays open until the end: payments after the lock are reported as late. ----------------
    rec.discarded = undefined;
    rec.watchFromHeight ??= Math.max(0, (await tipHeight(dapi, signal)) - 3);
    save();
    const lockedTxids = new Set<string>();
    let wake: () => void = () => {};
    const same = (a: { txid: string; vout: number }) => (b: { txid: string; vout: number }) => a.txid === b.txid && a.vout === b.vout;
    const confirm = (txid: string) => {
      let changed = false;
      for (const d of rec.deposits) if (d.txid === txid && !d.confirmed) changed = d.confirmed = true;
      if (changed) {
        update(`payment ${txid.slice(0, 12)}… confirmed`);
        wake();
      }
    };
    if (rec.state !== 'done') {
      const w = await dapi.watchAddressForDeposit(
        h160,
        {
          onTx: ({ tx }) => {
            if (tx.txid === rec.lock?.txid) return;
            // P2PKH outputs to the one-time key only (the watcher also matches P2SH with the same hash).
            const outs = tx.outputs.flatMap((out, vout) => {
              const c = classifyScript(out.script);
              return c.type === 'p2pkh' && bytesEqual(c.hash, h160) ? [{ txid: tx.txid, vout, value: out.value.toString() }] : [];
            });
            const fresh = outs.filter((d) => !rec.deposits.some(same(d)) && !(rec.lateDeposits ?? []).some(same(d)));
            if (!fresh.length) return;
            if (rec.lock) {
              (rec.lateDeposits ??= []).push(...fresh);
              update(`a payment arrived after the lock was made (${tx.txid.slice(0, 12)}…); it stays at the deposit address`);
              return;
            }
            for (const d of fresh) rec.deposits.push({ ...d, confirmed: lockedTxids.has(d.txid) });
            update(`payment ${tx.txid.slice(0, 12)}… seen; waiting for InstantSend or a block`);
            wake();
          },
          onIsLock: ({ lock }) => {
            lockedTxids.add(lock.txid);
            confirm(lock.txid);
          },
          onBlock: (b) => {
            for (const t of b.matched) {
              lockedTxids.add(t);
              confirm(t);
            }
          },
          onError: (e, ctx) => log(`watch ${ctx.phase}: ${redact(errText(e))}`),
        },
        { fromHeight: rec.watchFromHeight, signal },
      );
      watchers.push(w);
    }
    update(); // the address may be shown now: the subscription is live

    // ---- wait until the counted deposits make a lock above Platform's floor ----
    if (rec.state === 'awaiting-deposit') {
      const stop = aborted(signal);
      stop.catch(() => {});
      while (!pickInputs(counted(), minLock, BigInt(minDuffs))) await Promise.race([new Promise<void>((r) => (wake = r)), stop]);
      // A wallet may split a payment across txs that arrive together: give the streams a moment before locking.
      await sleep(1500, signal);
      rec.state = 'locking';
      update();
    }

    // ---- 3: asset lock ----
    if (!rec.lock) {
      const inputs = pickInputs(counted(), minLock, BigInt(minDuffs));
      if (!inputs) throw new FundingError('the payments no longer cover the minimum; wait for more or contact support');
      const utxos: Utxo[] = inputs.map((d) => ({ txid: d.txid, vout: d.vout, value: BigInt(d.value) }));
      const built = buildAssetLock({ utxos, fundingKey: fk.privateKey, creditPubKeyHash: h160, minLockDuffs: minLock });
      // The same deposits sign into the same bytes (RFC 6979): a lock refused before comes back here and is checked again below, which
      // also finds it when it was in fact mined (a mined lock's re-send is always refused).
      // Everything not spent by this lock (unconfirmed payments, dust, outputs over the input cap) is reported as late: it stays at the address.
      const left = rec.deposits.filter((d) => !inputs.some(same(d))).map(({ txid, vout, value }) => ({ txid, vout, value }));
      if (left.length) (rec.lateDeposits ??= []).push(...left);
      rec.deposits = inputs;
      rec.lock = { raw: bytesToHex(built.raw), txid: built.txid, creditIndex: built.creditIndex, burnVout: built.burnVout, lockDuffs: built.lockDuffs.toString(), feeDuffs: built.feeDuffs.toString() };
      if (kind === 'create') rec.identityId = identityIdFromOutpoint(built.txid, built.creditIndex);
      update('asset lock built');
    }
    const lock = rec.lock;
    if (rec.state === 'locking' || rec.state === 'locked') {
      // Whatever the saved state, a lock the network already knows (mined or in the mempool) is never re-sent: re-sending a mined lock
      // fails with "inputs missing or spent" (its only output is an OP_RETURN, which Core cannot find in the UTXO set). A mined lock's
      // IS-lock is gone for good (never replayed): straight to the chain proof.
      const status = rec.isLock ? 'known' : await lockStatus(dapi, lock.txid, signal);
      const mined = typeof status === 'number' && status > 0;
      if (!rec.isLock && !mined) {
        // Watch the lock's txid and inputs on several nodes BEFORE broadcasting: its IS-lock arrives within seconds, once.
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
      if (status === 'unknown') {
        const sent = await broadcastLock(dapi, lock, () => !!rec.isLock, signal, log);
        if (!sent) {
          // Every node refused the inputs and none knows the lock: a deposit was double-spent or replaced. Forget this lock and replay
          // the address from the start (the same deposits would rebuild the same bytes, which are then checked again), at most twice.
          (rec.rejectedLocks ??= []).push(lock.txid);
          if (rec.rejectedLocks.length >= 3) {
            update('the network refused the payment three times');
            throw new FundingError('The network refused the payment three times. Try again later, or contact support with the deposit address.');
          }
          rec.lock = undefined;
          rec.isLock = rec.isLockAfterMs = rec.proofKind = undefined;
          if (kind === 'create') rec.identityId = undefined;
          rec.deposits = [];
          rec.lateDeposits = undefined; // replayed and counted again
          rec.broadcastAt = undefined;
          rec.state = 'awaiting-deposit';
          update('the network rejected the payment the lock spends; waiting for a valid payment');
          for (const w of watchers.splice(0)) w.cancel();
          return await fund(o, fk, key);
        }
        rec.broadcastAt ??= Date.now();
      }
      rec.state = 'locked';
      update('asset lock broadcast');
      const deadline = mined || rec.isLock ? 0 : Date.now() + (o.isLockWaitMs ?? 60_000);
      while (!rec.isLock && Date.now() < deadline) await sleep(250, signal);
      rec.state = 'registering';
      update(rec.isLock ? undefined : 'no IS-lock seen; using a chain-lock proof');
    }

    // ---- 4-5: register on Platform ----
    const identityId = rec.identityId!;
    if (kind === 'topup') {
      rec.balanceBefore ??= ((await platform.balance(identityId)) ?? 0n).toString();
      save();
    }
    if (!(await settled(kind, platform, identityId, rec))) {
      const signingKeys: SigningKey[] =
        kind === 'create' ? CREATE_KEYS.map((k) => ({ ...k, privateKey: wallet!.identityKey(identityIndex, k.id).privateKey })) : [];
      try {
        const submit = async (proof: AssetLockProofInput) => {
          signal?.throwIfAborted();
          rec.proofKind = proof.kind;
          update(proof.kind === 'instant' ? 'registering with the IS-lock proof' : 'registering with a chain-lock proof');
          if (kind === 'create') await platform.createIdentity({ proof, assetLockKey: fk.privateKey, keys: signingKeys });
          else await platform.topUpIdentity({ identityId, proof, assetLockKey: fk.privateKey });
        };
        const refused = (e: unknown, outcome: RegistrationOutcome): never => {
          if (outcome === 'key-conflict')
            throw new FundingError('One of these keys is already registered to another identity. Sign in with this recovery phrase instead; the locked funds can be claimed by that identity with support.');
          throw new FundingError(`Platform refused the registration: ${redact(errText(e))}`);
        };
        let done = false;
        if (rec.isLock) {
          try {
            await submit({ kind: 'instant', tx: hexToBytes(lock.raw), isLock: hexToBytes(rec.isLock), creditIndex: lock.creditIndex });
            done = true;
          } catch (e) {
            const outcome = classifyRegistrationError(e);
            log(`instant proof: ${outcome}: ${redact(errText(e))}`);
            if (outcome === 'used') done = true;
            else if (outcome === 'key-conflict') refused(e, outcome);
            else if (outcome === 'other' && (await settled(kind, platform, identityId, rec))) done = true;
          }
        }
        if (!done && !(await settled(kind, platform, identityId, rec))) {
          const cl = await waitForChainLockedHeight(dapi, platform, lock.txid, {
            pollMs: o.pollMs,
            signal,
            onWait: (m, p) => o.onUpdate?.(view(m ? `mined at ${m}; waiting for Platform's chain lock (${p})` : 'waiting for the asset lock to be mined')),
          });
          // The wait can take minutes: an earlier submission may have landed meanwhile.
          if (!(await settled(kind, platform, identityId, rec))) {
            try {
              await submit({ kind: 'chain', txid: lock.txid, creditIndex: lock.creditIndex, coreChainLockedHeight: cl });
            } catch (e) {
              const outcome = classifyRegistrationError(e);
              log(`chain proof: ${outcome}: ${redact(errText(e))}`);
              if (outcome !== 'used' && !(outcome === 'other' && (await settled(kind, platform, identityId, rec)))) refused(e, outcome);
            }
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
    }
    rec.state = 'done';
    update(rec.lateDeposits?.length ? 'done; a later payment is still at the deposit address' : undefined);
    return { identityId, record: rec };
  } finally {
    for (const w of watchers) w.cancel();
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
 * One-time top-up key for a session without a seed: HMAC-SHA256(sessionKey, "govhub/topup/v1" || identityId || u32be(n) || ctr),
 * re-drawn with the counter in the (negligible) case it is not a valid scalar. Deterministic, so nothing secret has to be stored to
 * resume. Refuses anything that is not a valid private key (a wiped, all-zero session key would give a key anyone can compute).
 */
export function sessionTopUpKey(sessionKey: Uint8Array, identityId: string, n: number): { privateKey: Uint8Array; publicKey: Uint8Array } {
  if (!isValidPrivateKey(sessionKey)) throw new FundingError('The signed-in key is not available any more. Sign in again.');
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
    .filter((r) => r.network === network && r.state !== 'done' && !r.discarded)
    .sort((a, b) => b.updatedAt - a.updatedAt);

/**
 * Hides a record nothing was seen paid to (no deposit, no lock) from the pending list. The record stays: a payment made while no tab
 * was watching is invisible until the address is replayed, so continuing later with the same phrase still replays from its original
 * height. Returns whether it was hidden.
 */
export function discardFunding(store: FundingStore, key: string): boolean {
  const r = store.load(key);
  if (!r || r.state !== 'awaiting-deposit' || r.deposits.length || r.lock || r.lateDeposits?.length) return false;
  store.save({ ...r, discarded: true });
  return true;
}

/** The top-up index to use for `identityId`: an unfinished one first, else the next after those already made in this browser. */
export function nextTopUpIndex(store: FundingStore, network: Network, identityId: string): number {
  const mine = store.list().filter((r) => r.kind === 'topup' && r.network === network && r.identityId === identityId);
  const pending = mine.find((r) => r.state !== 'done');
  if (pending?.topUpIndex !== undefined) return pending.topUpIndex;
  return mine.reduce((m, r) => Math.max(m, (r.topUpIndex ?? -1) + 1), 0);
}
