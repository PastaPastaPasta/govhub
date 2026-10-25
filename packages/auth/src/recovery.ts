// Recovering DASH that got stuck at govhub's one-time funding addresses, from the chain alone: no localStorage, any device.
//
//   1. Key lanes: each key family (account setup, top-up, key-paste top-up, and whatever plugs in later through `families`) turns the
//      recovery phrase or a pasted key into lanes of one-time keys, index 0, 1, ... Only public keys are needed to scan; the private key
//      of one index is derived when the user acts on it, and wiped right after.
//   2. Scan: one bloom filter with every lane key's hash160 AND public key (a spend's scriptSig pushes the public key, so spends match
//      even where a node does not update the filter), replayed over DAPI from `fromHeight` to the tip in chunks, one node per chunk
//      (another one when a chunk fails). DAPI has no address or UTXO lookup: this replay is the only way to see an address's history.
//      A lane grows while a key within its gap limit of the end has history.
//   3. Proof: a transaction counts only when its bytes hash to a txid that a merkleblock of the stream proves (partial merkle tree up
//      to the header's root, the same standard the funding watcher uses). A second node is then asked for each transaction; one that
//      says it does not exist or is not mined drops it. Nothing a node merely claims is shown.
//   4. Items: unspent P2PKH payments to a lane key (minus every proven spend) and type-8 asset locks whose credit output pays a lane
//      key, with Platform's proved word on whether that lock was used (Drive's spent-asset-lock tree; PlatformPort.assetLockStatus).
//   5. Actions: a payment not yet locked can be swept to any Dash address (a plain P2PKH transaction broadcast over DAPI). Payments and
//      unused locks of an account-setup key can finish creating that account or top up any identity, those of a top-up key top up
//      the identity they were for; both through runFunding (`restore`: the record rebuilt from the chain). An asset lock's credit lives
//      on Platform now: it can never be sent back to a Core address.
// Nothing secret is ever persisted, logged or put in an item; errors never echo keys.
import { BloomFilter, classifyScript, parseMerkleBlock, parseTx, type Dapi, type Tx } from '@govhub/dapi';
import { decodeAddress, type Network as AnyNetwork } from '@govhub/verify';
import { bytesEqual, bytesToHex, hash160, hexToBytes, wipe } from './bytes.ts';
import {
  classifyRegistrationError, FundingError, fundingRecordKey, runFunding, sessionTopUpKey, tipHeight, withRecordLock, type FundingRecord, type FundingStore, type FundingView,
} from './funding.ts';
import { addressOf, wifOf, type Network } from './keys.ts';
import { CREATE_KEYS, createRequiredCredits, CREDITS_PER_DUFF, MIN_CREATE_LOCK_DUFFS, MIN_TOPUP_LOCK_DUFFS, topUpRequiredCredits } from './layout.ts';
import type { AssetLockStatus, PlatformPort } from './platform.ts';
import { IDENTITY_GAP_LIMIT, registrationFundingPath, topUpFundingPath, type SeedWallet } from './seed.ts';
import { assertLive, discoverIdentities, type FoundIdentity, type Session } from './signin.ts';
import { buildSweep, DUST_DUFFS, estimateAssetLockFee, estimateSweepFee, identityIdFromOutpoint, locateCredit, type Utxo } from './tx.ts';

// ---- what is scanned -------------------------------------------------------------------------------------------------------

/** The secret the keys come from: a recovery phrase, or a signed-in / pasted key (key-paste sessions derive their top-up keys from it). */
export type RecoverySecret = { wallet: SeedWallet; session?: undefined } | { wallet?: undefined; session: Session };

/** How a lane's funds can go to Platform through runFunding (absent: sweep only). */
export type LaneFunding =
  | { kind: 'create'; identityIndex: number }
  /** `session`: the one-time key comes from the session key (sessionTopUpKey), not the phrase. */
  | { kind: 'topup'; identityIndex: number; identityId: string; session: boolean };

/** One branch of one-time keys, index 0, 1, ... */
export interface KeyLane {
  /** Key family id ('create', 'topup', 'key-topup', or a plugged-in family's). */
  family: string;
  /** For people: "Account setup", "Top-up of 4Ytq…". */
  label: string;
  /** Unused indexes in a row after which the lane is not scanned further. */
  gap: number;
  /** Indexes 0..minIndexes-1 are scanned whatever their history (e.g. up to the last identity the phrase has). */
  minIndexes?: number;
  /** The one-time key at `index`: fresh private key bytes the caller wipes. */
  derive(index: number): { privateKey: Uint8Array; publicKey: Uint8Array };
  /** Where the key comes from, for the docs and the advanced export: a BIP32 path or the derivation rule. */
  path(index: number): string;
  /** How this lane's funds can be used on Platform; null: sweep only. */
  funding(index: number): LaneFunding | null;
}

/** A key family: the lanes it has for this secret (none when it does not apply, e.g. seed lanes for a pasted key). */
export type KeyFamily = (ctx: { secret: RecoverySecret; network: Network; identities: readonly FoundIdentity[] }) => KeyLane[];

/** Top-ups of one identity skip no index (an unfinished one is continued first), so a short gap is plenty. */
export const TOPUP_GAP_LIMIT = 5;

/** Account setups: m/9'/coin'/5'/1'/i' (DIP-13 registration funding), up to the identity gap limit past the last identity. */
export const createFamily: KeyFamily = ({ secret, network, identities }) => {
  const w = secret.wallet;
  if (!w) return [];
  return [
    {
      family: 'create',
      label: 'Account setup',
      gap: IDENTITY_GAP_LIMIT,
      minIndexes: identities.length ? Math.max(...identities.map((i) => i.identityIndex)) + 1 : 0,
      derive: (i) => w.derive(registrationFundingPath(network, i)),
      path: (i) => registrationFundingPath(network, i),
      funding: (i) => ({ kind: 'create', identityIndex: i }),
    },
  ];
};

/** Top-ups with the phrase: m/9'/coin'/5'/2'/i'/n for every identity the phrase has. */
export const topUpFamily: KeyFamily = ({ secret, network, identities }) => {
  const w = secret.wallet;
  if (!w) return [];
  return identities.map((f) => ({
    family: 'topup',
    label: `Top-up of identity #${f.identityIndex}`,
    gap: TOPUP_GAP_LIMIT,
    derive: (n: number) => w.derive(topUpFundingPath(network, f.identityIndex, n)),
    path: (n: number) => topUpFundingPath(network, f.identityIndex, n),
    funding: (): LaneFunding => ({ kind: 'topup', identityIndex: f.identityIndex, identityId: f.identityId, session: false }),
  }));
};

/** Top-ups of a key-paste session: HMAC-SHA256(session key, "govhub/topup/v1" || identity || n), govhub's own rule (funding.ts). */
export const keyTopUpFamily: KeyFamily = ({ secret }) => {
  const s = secret.session;
  if (!s || s.wallet) return [];
  return [
    {
      family: 'key-topup',
      label: 'Top-up with the pasted key',
      gap: TOPUP_GAP_LIMIT,
      derive: (n: number) => (assertLive(s), sessionTopUpKey(s.privateKey, s.identityId, n)),
      path: (n: number) => `HMAC-SHA256(key, "govhub/topup/v1" || ${s.identityId} || ${n})`,
      funding: (): LaneFunding => ({ kind: 'topup', identityIndex: s.identityIndex ?? 0, identityId: s.identityId, session: true }),
    },
  ];
};

/**
 * The families scanned by default. Another one-time key family (a fee payment from a later feature, say) plugs in by appending to this
 * list in the call to scanForFunds: its lanes are scanned, and their payments can be swept (and used on Platform if it says how).
 */
export const DEFAULT_KEY_FAMILIES: readonly KeyFamily[] = [createFamily, topUpFamily, keyTopUpFamily];

// ---- default start heights -------------------------------------------------------------------------------------------------

/**
 * Where a scan starts unless the user picks an older height: just before govhub could first take a payment on that network. Testnet:
 * the funding flow landed on 2026-10-24 (its first live records start at 1,578,338); 1,577,000 is two days earlier. Mainnet: govhub has
 * taken no mainnet payment yet; 2,560,000 is 2026-10-23, before this tool existed. Starting earlier only costs time, never safety, and
 * finds older funding of the same DIP-13 paths by other wallets (DashPay and Dash Evo Tool use the account-setup path too).
 */
export const RECOVERY_START_HEIGHT: Record<Network, number> = { testnet: 1_577_000, mainnet: 2_560_000 };
/** Core aims for one block every 2.5 minutes. */
export const BLOCKS_PER_DAY = 576;

// ---- the scan --------------------------------------------------------------------------------------------------------------

export interface ScanProgress {
  phase: 'identities' | 'scan' | 'check';
  /** Blocks replayed so far and in all, across every pass. */
  done: number;
  total: number;
  keys: number;
  note?: string;
}

export interface RecoveryDeposit {
  txid: string;
  vout: number;
  duffs: bigint;
  /** Mined height as a second node reports it (display only); undefined when no second node answered. */
  height?: number;
}

export interface RecoveryLock {
  txid: string;
  creditIndex: number;
  burnVout: number;
  /** The credit output: what Platform credits when the lock is used (Platform keeps less after a partial use). */
  lockDuffs: bigint;
  raw: string;
  height?: number;
  /** Platform's proved state; 'unknown' when the query failed (acting on it is still safe: Platform refuses a used lock for free). */
  status: AssetLockStatus | 'unknown';
}

export interface RecoveryItem {
  /** Stable within a scan: the address for payments, the outpoint for a lock. */
  id: string;
  type: 'payments' | 'lock';
  family: string;
  label: string;
  index: number;
  path: string;
  address: string;
  /** hex hash160 of the one-time key. */
  keyHash: string;
  funding: LaneFunding | null;
  payments: RecoveryDeposit[];
  lock?: RecoveryLock;
  /** Payments: their sum. A lock: its credit output. */
  duffs: bigint;
}

export interface RecoveryScan {
  network: Network;
  fromHeight: number;
  toHeight: number;
  keysScanned: number;
  identities: FoundIdentity[];
  /** Unspent payments and unused (or partly used, or unchecked) asset locks. */
  items: RecoveryItem[];
  /** Asset locks of these keys that Platform proves fully used (nothing to do). */
  usedLocks: number;
  /** Proven recoverable: unspent payments plus locks Platform proves unused. */
  provenDuffs: bigint;
  /** Transactions the scan dropped because a node's claim did not hold up (no merkle proof, wrong bytes, contradicted). */
  dropped: number;
}

export interface ScanOptions {
  secret: RecoverySecret;
  dapi: Dapi;
  platform: PlatformPort;
  fromHeight?: number;
  /** Default: the tip a node reports. */
  toHeight?: number;
  families?: readonly KeyFamily[];
  /** Blocks per stream request. Default 5000. */
  chunk?: number;
  /** The identities the phrase has, when the caller already knows them (skips discovery). */
  identities?: FoundIdentity[];
  signal?: AbortSignal;
  onProgress?(p: ScanProgress): void;
  /** Diagnostics only (never secrets). */
  log?(m: string): void;
}

interface LaneKey {
  lane: KeyLane;
  index: number;
  h160: Uint8Array;
  pub: Uint8Array;
  address: string;
}

export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryError';
  }
}

const errCode = (e: unknown): number | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'number' ? c : undefined;
};
const errText = (e: unknown) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e));

function laneKey(lane: KeyLane, index: number, network: Network): LaneKey {
  const k = lane.derive(index);
  wipe(k.privateKey); // scanning needs the public key only
  return { lane, index, h160: hash160(k.publicKey), pub: k.publicKey, address: addressOf(k.publicKey, network) };
}

/**
 * Replays [from, to] for `filter` and returns the transactions a merkleblock proves (keyed by the txid their bytes hash to). One node
 * per chunk; a chunk whose stream fails, ends early or carries a merkleblock whose tree does not reach its header's root is replayed
 * on another node. `dropped` counts transactions a node sent without proof.
 */
export async function replayProven(
  dapi: Dapi,
  filter: ReturnType<BloomFilter['toJSON']>,
  from: number,
  to: number,
  o: { chunk?: number; signal?: AbortSignal; onBlocks?(n: number): void; log?(m: string): void } = {},
): Promise<{ txs: Map<string, Tx>; dropped: number }> {
  await dapi.ready();
  const out = new Map<string, Tx>();
  let dropped = 0;
  const chunk = o.chunk ?? 5000;
  for (let h = from; h <= to; ) {
    const count = Math.min(chunk, to - h + 1);
    const tried = new Set<string>();
    for (let attempt = 0; ; attempt++) {
      o.signal?.throwIfAborted();
      const node = dapi.pool.pick(1, tried)[0];
      if (!node || attempt >= 4) throw new RecoveryError(`No DAPI node could replay blocks ${h}..${h + count - 1}. Try again later.`);
      tried.add(node);
      try {
        dapi.pool.charge(node);
      } catch {
        continue;
      }
      const raws = new Map<string, Tx>();
      const proven = new Set<string>();
      let blocks = 0;
      let bad: Error | null = null;
      const s = dapi.core(node).subscribeToTransactionsWithProofs(
        filter,
        { fromHeight: h, count },
        (ev) => {
          if (ev.type === 'rawtxs') {
            for (const raw of ev.txs) {
              try {
                const tx = parseTx(raw);
                raws.set(tx.txid, tx);
              } catch {
                dropped++;
              }
            }
          } else if (ev.type === 'merkleblock') {
            const b = parseMerkleBlock(ev.merkleBlock);
            if (!b.rootOk) bad = new Error('a merkleblock does not hash to its header');
            else for (const t of b.matched) proven.add(t);
            blocks++;
            o.onBlocks?.(1);
          }
        },
        { signal: o.signal, idleTimeoutMs: 120_000, connectTimeoutMs: dapi.options.timeoutMs ?? 15_000 },
      );
      const closed = await s.closed;
      if (o.signal?.aborted) throw o.signal.reason;
      if (closed.reason !== 'end' || bad) {
        const why = bad ?? (closed.reason === 'error' ? closed.error : new Error(closed.reason));
        o.log?.(`replay ${h}+${count} on ${node}: ${errText(why)}`);
        dapi.pool.fail(node, why);
        o.onBlocks?.(-blocks);
        continue;
      }
      // the tip a node reports may be a block or two behind the one asked for: what it did replay is what counts
      for (const [txid, tx] of raws) {
        if (proven.has(txid)) out.set(txid, tx);
        else dropped++;
      }
      dapi.pool.ok(node);
      break;
    }
    h += count;
  }
  return { txs: out, dropped };
}

/** A second node's word on a proven transaction: its mined height, or null when it contradicts (unknown, other bytes, not mined). */
async function secondOpinion(dapi: Dapi, tx: Tx, signal?: AbortSignal): Promise<number | null | undefined> {
  try {
    const { value } = await dapi.call((core, s) => core.getTransaction(tx.txid, { signal: s }), { signal, attempts: 3 });
    if (parseTx(value.raw).txid !== tx.txid) return null;
    return value.height > 0 ? value.height : null;
  } catch (e) {
    if (signal?.aborted) throw e;
    // NOT_FOUND twice (dapi.call asks a second node before believing it): the transaction does not exist for them
    if (errCode(e) === 5) return null;
    return undefined; // nobody answered: the merkle proof stands alone
  }
}

/**
 * Scans the chain for everything govhub's one-time keys of this secret received: unspent payments and asset locks Platform has not
 * (fully) used. Needs nothing from this browser's storage.
 */
export async function scanForFunds(o: ScanOptions): Promise<RecoveryScan> {
  const { secret, dapi, platform, signal } = o;
  const network = platform.network;
  if (dapi.network !== network || (secret.wallet && secret.wallet.network !== network) || (secret.session && secret.session.network !== network))
    throw new RecoveryError(`network mismatch: DAPI ${dapi.network}, Platform ${network}`);
  if (secret.session) assertLive(secret.session);
  const progress: ScanProgress = { phase: 'identities', done: 0, total: 0, keys: 0 };
  const report = (p: Partial<ScanProgress> = {}) => o.onProgress?.(Object.assign(progress, p));
  report();
  const identities = o.identities ?? (secret.wallet ? await discoverIdentities(secret.wallet, platform, { signal }) : []);
  const fromHeight = Math.max(0, o.fromHeight ?? RECOVERY_START_HEIGHT[network]);
  const toHeight = o.toHeight ?? (await tipHeight(dapi, signal));
  if (toHeight < fromHeight) throw new RecoveryError(`The start height ${fromHeight} is above the chain tip ${toHeight}.`);

  const lanes = (o.families ?? DEFAULT_KEY_FAMILIES).flatMap((f) => f({ secret, network, identities }));
  const keys: LaneKey[] = [];
  /** Indexes derived so far per lane. */
  const width = new Map<KeyLane, number>();
  const txs = new Map<string, Tx>();
  let dropped = 0;
  const span = toHeight - fromHeight + 1;

  /**
   * Each lane must cover its minimum and `gap` indexes past the last one with history. A lane that falls short grows by another `gap`
   * beyond that (keys are cheap in the filter; a pass over the range is not), so sequential use rarely needs a second pass. Returns
   * the keys that are new.
   */
  const grow = (): LaneKey[] => {
    const fresh: LaneKey[] = [];
    for (const lane of lanes) {
      const used = keys.filter((k) => k.lane === lane && touched(k));
      const need = Math.max(lane.minIndexes ?? 0, used.length ? Math.max(...used.map((k) => k.index)) + 1 : 0) + lane.gap;
      const have = width.get(lane) ?? 0;
      if (have >= need) continue;
      for (let i = have; i < need + lane.gap; i++) {
        const k = laneKey(lane, i, network);
        keys.push(k);
        fresh.push(k);
      }
      width.set(lane, need + lane.gap);
    }
    return fresh;
  };
  /** Whether any proven transaction pays the key, spends from it, or credits it in an asset lock. */
  const touched = (k: LaneKey) => [...txs.values()].some((tx) => paysKey(tx, k.h160) || spendsFrom(tx, k.pub) || creditsKey(tx, k.h160));

  for (let pass = 0, fresh = grow(); fresh.length; pass++, fresh = grow()) {
    if (pass >= 8 || keys.length > 400) throw new RecoveryError('These keys have more history than the Recover tool scans in one go. Contact the govhub developers.');
    const f = new BloomFilter(fresh.length * 2);
    for (const k of fresh) f.insert(k.h160).insert(k.pub);
    report({ phase: 'scan', keys: keys.length, total: progress.total + span });
    const r = await replayProven(dapi, f.toJSON(), fromHeight, toHeight, { chunk: o.chunk, signal, log: o.log, onBlocks: (n) => report({ done: progress.done + n }) });
    for (const [txid, tx] of r.txs) txs.set(txid, tx);
    dropped += r.dropped;
  }

  // ---- what is still there ----
  report({ phase: 'check', note: 'checking what was found' });
  const relevant = [...txs.values()].filter((tx) => keys.some((k) => paysKey(tx, k.h160) || spendsFrom(tx, k.pub) || creditsKey(tx, k.h160)));
  const heights = new Map<string, number | undefined>();
  for (const tx of relevant) {
    const h = await secondOpinion(dapi, tx, signal);
    if (h === null) {
      dropped++;
      txs.delete(tx.txid);
      o.log?.(`dropped ${tx.txid}: a second node contradicts it`);
    } else heights.set(tx.txid, h);
  }
  const kept = relevant.filter((tx) => txs.has(tx.txid));
  const spent = new Set(kept.flatMap((tx) => tx.inputs.map((i) => `${i.prevTxid}:${i.vout}`)));
  const items: RecoveryItem[] = [];
  let usedLocks = 0;
  for (const k of keys) {
    const base = { family: k.lane.family, label: k.lane.label, index: k.index, path: k.lane.path(k.index), address: k.address, keyHash: bytesToHex(k.h160), funding: k.lane.funding(k.index) };
    const payments: RecoveryDeposit[] = kept.flatMap((tx) =>
      tx.outputs.flatMap((out, vout) => {
        const c = classifyScript(out.script);
        return c.type === 'p2pkh' && bytesEqual(c.hash, k.h160) && !spent.has(`${tx.txid}:${vout}`) ? [{ txid: tx.txid, vout, duffs: out.value, height: heights.get(tx.txid) }] : [];
      }),
    );
    if (payments.length) items.push({ ...base, id: k.address, type: 'payments', payments, duffs: payments.reduce((a, p) => a + p.duffs, 0n) });
    for (const tx of kept) {
      if (!creditsKey(tx, k.h160)) continue;
      const c = locateCredit(tx, k.h160);
      let status: RecoveryLock['status'];
      try {
        status = await platform.assetLockStatus(tx.txid, c.creditIndex);
      } catch (e) {
        o.log?.(`asset lock status ${tx.txid}: ${errText(e)}`);
        status = 'unknown';
      }
      if (status === 'used') {
        usedLocks++;
        continue;
      }
      const lock: RecoveryLock = { txid: tx.txid, creditIndex: c.creditIndex, burnVout: c.burnVout, lockDuffs: c.creditDuffs, raw: bytesToHex(tx.raw), height: heights.get(tx.txid), status };
      items.push({ ...base, id: `${tx.txid}:${c.creditIndex}`, type: 'lock', payments: [], lock, duffs: c.creditDuffs });
    }
  }
  const provenDuffs = items.reduce((a, i) => a + (i.type === 'payments' || i.lock?.status === 'unused' ? i.duffs : 0n), 0n);
  report({ note: undefined });
  return { network, fromHeight, toHeight, keysScanned: keys.length, identities, items, usedLocks, provenDuffs, dropped };
}

const paysKey = (tx: Tx, h160: Uint8Array) =>
  tx.outputs.some((out) => {
    const c = classifyScript(out.script);
    return c.type === 'p2pkh' && bytesEqual(c.hash, h160);
  });
/** A P2PKH spend pushes `<sig> <pubkey>`: the last 33 bytes of the scriptSig are the key. */
const spendsFrom = (tx: Tx, pub: Uint8Array) => tx.inputs.some((i) => i.script.length > 34 && i.script[i.script.length - 34] === 33 && bytesEqual(i.script.subarray(i.script.length - 33), pub));
function creditsKey(tx: Tx, h160: Uint8Array): boolean {
  if (tx.type !== 8) return false;
  try {
    locateCredit(tx, h160);
    return true;
  } catch {
    return false;
  }
}

// ---- what an item can do ---------------------------------------------------------------------------------------------------

/** Duffs as DASH for people ("0.002215 DASH"). */
const dashText = (duffs: number | bigint) => `${(Number(duffs) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')} DASH`;

export interface ItemOptions {
  /** Payments only: what a sweep would send and cost (null: everything would go to the fee). */
  sweep: { sentDuffs: bigint; feeDuffs: bigint } | null;
  /** Finish creating the account at this identity index (its keys are free and the funds cover Platform's minimum). */
  create: number | null;
  /** Top up: 'any' (an account-setup key: any identity), the one identity a top-up key was for, or null (too small / sweep-only lane). */
  topUp: 'any' | string | null;
  /** Why something is not offered, for people. */
  notes: string[];
}

/** What the user can do with an item, given the scan (which identity indexes are taken). */
export function itemOptions(item: RecoveryItem, scan: Pick<RecoveryScan, 'identities'>): ItemOptions {
  const notes: string[] = [];
  const isLock = item.type === 'lock';
  const fee = isLock ? 0n : estimateAssetLockFee(Math.min(item.payments.length, 100));
  const credit = item.duffs - fee;
  let sweep: ItemOptions['sweep'] = null;
  if (isLock) notes.push('An asset lock is already on Dash Platform: it can be used for an account, but never sent back to a Dash address.');
  else {
    const f = estimateSweepFee(item.payments.length);
    if (item.duffs - f >= DUST_DUFFS) sweep = { sentDuffs: item.duffs - f, feeDuffs: f };
    else notes.push(`${dashText(item.duffs)} cannot pay a transaction fee and leave more than dust.`);
  }
  const usable = isLock ? item.lock!.status !== 'used' : item.payments.length <= 100;
  const fu = item.funding;
  let create: number | null = null;
  let topUp: ItemOptions['topUp'] = null;
  if (!fu) notes.push('This key is not a funding key: its payments can only be sent to an address.');
  else if (usable) {
    const bigEnoughFor = (k: 'create' | 'topup') => credit * CREDITS_PER_DUFF >= (k === 'create' ? createRequiredCredits(CREATE_KEYS.length) : topUpRequiredCredits());
    const canTopUp = bigEnoughFor('topup');
    if (fu.kind === 'create') {
      if (scan.identities.some((f) => f.identityIndex === fu.identityIndex)) notes.push(`Identity #${fu.identityIndex} of this phrase already exists, so this cannot create it again.`);
      else if (bigEnoughFor('create')) create = fu.identityIndex;
      else if (canTopUp) notes.push(`Creating an account needs ${dashText(MIN_CREATE_LOCK_DUFFS)} locked; this is enough to top up an identity instead.`);
      if (canTopUp) topUp = 'any';
    } else if (canTopUp) topUp = fu.identityId;
    if (!canTopUp) notes.push(`Too small to use on Dash Platform: a top-up needs ${dashText(MIN_TOPUP_LOCK_DUFFS)} locked${isLock ? '' : ' after the fee'}.`);
  }
  return { sweep, create, topUp, notes };
}

// ---- sweep -----------------------------------------------------------------------------------------------------------------

const OTHER: Record<Network, Network> = { mainnet: 'testnet', testnet: 'mainnet' };

/** A Dash address on `network` (P2PKH or P2SH), or a RecoveryError that says what is wrong (another network's address included). */
export function parseDashAddress(text: string, network: Network): { type: 'p2pkh' | 'p2sh'; hash160: Uint8Array } {
  const a = text.trim();
  const d = decodeAddress(a, network as AnyNetwork);
  if (d) return d;
  if (decodeAddress(a, OTHER[network] as AnyNetwork)) throw new RecoveryError(`That is a ${OTHER[network]} address; these funds are on ${network}. Use a ${network} address.`);
  throw new RecoveryError('That is not a Dash address. Paste a P2PKH ("X…" on mainnet, "y…" on testnet) or P2SH address.');
}

/** Derives an item's one-time key (fresh bytes the caller wipes) and checks it is the key the scan saw. */
function itemKey(item: RecoveryItem, secret: RecoverySecret, network: Network, families: readonly KeyFamily[], identities: readonly FoundIdentity[]) {
  const lane = families.flatMap((f) => f({ secret, network, identities })).find((l) => l.family === item.family && l.label === item.label);
  if (!lane) throw new RecoveryError('This recovery phrase or key does not hold that address.');
  const k = lane.derive(item.index);
  if (bytesToHex(hash160(k.publicKey)) !== item.keyHash) {
    wipe(k.privateKey);
    throw new RecoveryError('This recovery phrase or key does not hold that address.');
  }
  return k;
}

export interface SweepResult {
  txid: string;
  sentDuffs: bigint;
  feeDuffs: bigint;
}

/**
 * Sends an item's payments to `to` in one P2PKH-signed transaction over DAPI. Holds the funding record's Web Lock (so a funding of the
 * same address in another tab cannot lock the same payments meanwhile) and, once sent, drops the swept payments from this browser's
 * record of that address. A payment spent meanwhile makes the broadcast fail; nothing is sent twice (every input is spent once).
 */
export async function sweepItem(o: {
  item: RecoveryItem;
  scan: Pick<RecoveryScan, 'network' | 'identities'>;
  secret: RecoverySecret;
  to: string;
  dapi: Dapi;
  store?: FundingStore;
  families?: readonly KeyFamily[];
  signal?: AbortSignal;
}): Promise<SweepResult> {
  const { item, scan, secret, dapi } = o;
  const network = scan.network;
  if (item.type !== 'payments') throw new RecoveryError('An asset lock cannot be sent to an address: its credit is on Dash Platform. Use it for an account instead.');
  if (dapi.network !== network) throw new RecoveryError(`network mismatch: DAPI ${dapi.network}, scan ${network}`);
  const to = parseDashAddress(o.to, network);
  const recordKey = fundingRecordKey(network, item.funding?.kind ?? 'create', hexToBytes(item.keyHash));
  return withRecordLock(recordKey, async () => {
    const k = itemKey(item, secret, network, o.families ?? DEFAULT_KEY_FAMILIES, scan.identities);
    let built;
    try {
      const utxos: Utxo[] = item.payments.map((p) => ({ txid: p.txid, vout: p.vout, value: p.duffs }));
      built = buildSweep({ utxos, key: k.privateKey, to });
    } catch (e) {
      throw new RecoveryError(errText(e));
    } finally {
      wipe(k.privateKey);
    }
    try {
      await dapi.broadcastTransaction(built.raw, { signal: o.signal });
    } catch (e) {
      if (/missing-?inputs|bad-txns-inputs-missingorspent|txn-mempool-conflict|inputs.*(spent|missing)/i.test(errText(e)))
        throw new RecoveryError('The network says these payments were already spent (by another device, or a funding in progress). Scan again to see what is left.');
      throw e;
    }
    if (o.store) forgetSpent(o.store, recordKey, item.payments);
    return { txid: built.txid, sentDuffs: built.sentDuffs, feeDuffs: built.feeDuffs };
  });
}

/** Drops spent payments from this browser's record of the address; an unfinished record left with nothing to lock is hidden. */
export function forgetSpent(store: FundingStore, recordKey: string, spent: ReadonlyArray<{ txid: string; vout: number }>): void {
  const r = store.load(recordKey);
  if (!r) return;
  const gone = (d: { txid: string; vout: number }) => spent.some((s) => s.txid === d.txid && s.vout === d.vout);
  const deposits = r.lock ? r.deposits : r.deposits.filter((d) => !gone(d));
  const lateDeposits = r.lateDeposits?.filter((d) => !gone(d));
  const empty = !r.lock && !deposits.length && !lateDeposits?.length;
  store.save({ ...r, deposits, lateDeposits: lateDeposits?.length ? lateDeposits : undefined, discarded: r.state !== 'done' && empty ? true : r.discarded });
}

// ---- use on Platform -------------------------------------------------------------------------------------------------------

export type RecoveryTarget = { create: true } | { topUp: string };

/**
 * Creates the account (account-setup key) or tops up an identity with an item, through runFunding: the funding record is rebuilt from
 * the chain (`restore`) and saved in `store`, so a closed tab resumes like any funding. Payments are locked first (an asset lock), a
 * lock is registered with a chain proof. A top-up key only tops up the identity it was for.
 */
export async function fundWithItem(o: {
  item: RecoveryItem;
  scan: Pick<RecoveryScan, 'network' | 'identities' | 'toHeight'>;
  secret: RecoverySecret;
  target: RecoveryTarget;
  dapi: Dapi;
  platform: PlatformPort;
  store: FundingStore;
  signal?: AbortSignal;
  onUpdate?(v: FundingView): void;
  log?(m: string): void;
}): Promise<{ identityId: string; record: FundingRecord }> {
  const { item, scan, secret, target, platform } = o;
  const network = scan.network;
  const fu = item.funding;
  if (!fu) throw new RecoveryError('These payments can only be sent to an address.');
  if (platform.network !== network) throw new RecoveryError(`network mismatch: Platform ${platform.network}, scan ${network}`);
  if ('create' in target && fu.kind !== 'create') throw new RecoveryError('A top-up payment cannot create an account.');
  if ('topUp' in target && fu.kind === 'topup' && target.topUp !== fu.identityId) throw new RecoveryError(`A top-up payment only tops up the identity it was for (${fu.identityId}).`);
  if (fu.kind === 'topup' && fu.session !== !!secret.session) throw new RecoveryError('This top-up address belongs to the other kind of sign-in.');
  if (fu.kind === 'create' && !secret.wallet) throw new RecoveryError('An account setup needs its recovery phrase.');
  if (item.lock) {
    // checked again right before use: another device may have used it since the scan
    const st = await platform.assetLockStatus(item.lock.txid, item.lock.creditIndex).catch(() => 'unknown' as const);
    if (st === 'used') throw new RecoveryError('Dash Platform has already used this asset lock (since the scan, or from another device). Scan again.');
  }
  const kind = fu.kind;
  const key = fundingRecordKey(network, kind, hexToBytes(item.keyHash));
  const now = Date.now();
  const heights = [...item.payments.map((p) => p.height), item.lock?.height].filter((h): h is number => !!h);
  const restore: FundingRecord = {
    v: 2,
    key,
    kind,
    network,
    identityIndex: fu.identityIndex,
    topUpIndex: kind === 'topup' ? item.index : undefined,
    identityId: kind === 'topup' ? fu.identityId : item.lock ? identityIdFromOutpoint(item.lock.txid, item.lock.creditIndex) : undefined,
    address: item.address,
    // the watcher replays from the oldest payment, so a rebuild after a refused lock still finds them (spent ones drop out)
    watchFromHeight: heights.length ? Math.max(0, Math.min(...heights) - 1) : Math.max(0, scan.toHeight - 3),
    deposits: item.payments.map((p) => ({ txid: p.txid, vout: p.vout, value: p.duffs.toString(), confirmed: true })),
    lock: item.lock
      ? { raw: item.lock.raw, txid: item.lock.txid, creditIndex: item.lock.creditIndex, burnVout: item.lock.burnVout, lockDuffs: item.lock.lockDuffs.toString(), feeDuffs: '0' }
      : undefined,
    state: item.lock ? 'registering' : 'awaiting-deposit',
    createdAt: now,
    updatedAt: now,
  };
  if (item.lock && !restore.lock!.raw) throw new RecoveryError('The asset lock transaction is missing; scan again.');
  try {
    return await runFunding({
      wallet: secret.wallet ?? null,
      session: secret.session,
      dapi: o.dapi,
      platform,
      store: o.store,
      kind,
      identityIndex: fu.identityIndex,
      topUp: kind === 'topup' ? { identityId: fu.identityId, index: item.index } : undefined,
      recoverInto: 'topUp' in target && kind === 'create' ? target.topUp : undefined,
      restore,
      signal: o.signal,
      onUpdate: o.onUpdate,
      log: o.log,
    });
  } catch (e) {
    if (e instanceof FundingError) throw e;
    if (classifyRegistrationError(e) === 'used') throw new RecoveryError('Dash Platform has already used this asset lock.');
    throw e;
  }
}

// ---- export ----------------------------------------------------------------------------------------------------------------

/**
 * The one-time key of an item as WIF, for importing into another wallet (Dash Core `importprivkey`, for one). Advanced and opt-in:
 * the caller shows it only after a warning, never logs or stores it. Anyone holding it can take the payments at that address and use
 * any unused asset lock that credits it.
 */
export function exportItemWif(o: { item: RecoveryItem; scan: Pick<RecoveryScan, 'network' | 'identities'>; secret: RecoverySecret; families?: readonly KeyFamily[] }): string {
  const k = itemKey(o.item, o.secret, o.scan.network, o.families ?? DEFAULT_KEY_FAMILIES, o.scan.identities);
  try {
    return wifOf(k.privateKey, o.scan.network);
  } finally {
    wipe(k.privateKey);
  }
}
