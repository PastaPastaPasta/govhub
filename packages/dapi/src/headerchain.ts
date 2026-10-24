// A contiguous run of block hashes that this client verified itself, anchored to a pinned checkpoint. Pure (no I/O).
//
// Trust: the checkpoint is a constant in this file (like Core's own checkpoints, chainparams.cpp:306-347). Headers BELOW it are
// authenticated by hash linkage down from it (X11 preimage resistance). Headers ABOVE it must also pass Core's header rules: proof
// of work against nBits, nBits equal to Dark Gravity Wave's value, timestamp above the median of the last 11 and at most 2 h in the
// future. A node can therefore only serve a chain above the checkpoint by mining it at full network difficulty. A ChainLock on top
// (checked elsewhere) makes the verified part final.
import { bytesEqual, hashBytes, hashHex } from './bytes.ts';
import type { Network } from './chainlock.ts';
import { VerificationError } from './errors.ts';
import { type HeaderTiming, MAX_FUTURE_BLOCK_TIME, type PowParams, checkProofOfWork, medianTimePast, nextWorkRequired } from './pow.ts';

export interface Checkpoint {
  height: number;
  /** Display-order block hash. */
  hash: string;
}

/**
 * Pinned per network. Each pin was checked by `scripts/checkpoint.mjs` to descend from Dash Core's newest hard-coded checkpoint
 * (mainnet 2,487,500, chainparams.cpp:345; testnet 1,380,000, chainparams.cpp:528) through headers that pass every rule above, and
 * 8 random nodes returned the same hash. Move a pin forward (same script) to keep cold verification short: the first verification
 * on a device downloads every header from the lower of (checkpoint - 24, block of interest) to the tip.
 */
export const CHECKPOINTS: Record<Network, Checkpoint> = {
  mainnet: { height: 2_560_000, hash: '0000000000000007c3d73af34a556850b5748c66812021a136387bec1dd79675' },
  testnet: { height: 1_578_000, hash: '0000009c0b6cbd13862a8049d0a117a4210ae6eeb90d8022cd2276e875fe639c' },
};

/** DGW looks back 24 headers (pow.cpp:84), MTP 11 (chain.h:281). */
export const DGW_WINDOW = 24;

/** Headers fetched together: `headers` is n * 80 bytes for heights from..from+n-1, `hashes` their n * 32-byte X11 hashes. */
export interface HeaderRun {
  from: number;
  headers: Uint8Array;
  hashes: Uint8Array;
  /** Which node sent which heights (for retrying a bad part elsewhere). */
  sources?: Array<{ from: number; count: number; node: string }>;
}

export interface CheckOptions {
  pow: PowParams;
  /** Unix seconds; headers more than 2 h ahead are rejected like Core does (validation.cpp:4509). */
  now: number;
}

/** Serializable state, for a cache (IndexedDB). */
export interface StoredChain {
  version: 1;
  network: Network;
  checkpoint: Checkpoint;
  lo: number;
  /** Hash of block lo - 1 (header lo's prevHash), so the run can be extended downward. Internal order. */
  prevOfLo: Uint8Array;
  /** 32 bytes per height lo..hi, internal order. */
  hashes: Uint8Array;
  /** bits and time of the last DGW_WINDOW headers up to hi (oldest first), so the run can be extended upward. */
  timings: HeaderTiming[];
  /** The BLS-verified ChainLock the run ends at (hi = its height): everything stored is final. */
  chainLock: { height: number; blockHash: string };
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const prevHashOf = (headers: Uint8Array, i: number) => headers.subarray(i * 80 + 4, i * 80 + 36);
const timingOf = (headers: Uint8Array, i: number): HeaderTiming => ({ time: view(headers).getUint32(i * 80 + 68, true), bits: view(headers).getUint32(i * 80 + 72, true) });
const fail = (height: number, msg: string): never => { throw new VerificationError('header-chain', `block ${height}: ${msg}`, height); };

function checkRun(run: HeaderRun): number {
  const n = run.headers.length / 80;
  if (!Number.isInteger(n) || n < 1 || run.hashes.length !== n * 32) throw new VerificationError('header-chain', 'header run is malformed');
  for (let i = 1; i < n; i++) {
    if (!bytesEqual(prevHashOf(run.headers, i), run.hashes.subarray((i - 1) * 32, i * 32))) fail(run.from + i, 'does not link to the previous header');
  }
  return n;
}

export class HeaderChain {
  readonly network: Network;
  readonly checkpoint: Checkpoint;
  #lo: number;
  #prevOfLo: Uint8Array;
  #hashes: Uint8Array;
  /** bits/time of the top headers, ending at hi (at least DGW_WINDOW of them; more after extensions in this session). */
  #timings: HeaderTiming[];
  /** Height -> raw header for runs fetched in this session (not persisted): merkle roots and times near the tip. */
  readonly #raw = new Map<number, Uint8Array>();

  private constructor(network: Network, checkpoint: Checkpoint, lo: number, prevOfLo: Uint8Array, hashes: Uint8Array, timings: HeaderTiming[]) {
    this.network = network;
    this.checkpoint = checkpoint;
    this.#lo = lo;
    this.#prevOfLo = prevOfLo;
    this.#hashes = hashes;
    this.#timings = timings;
  }

  get lo(): number { return this.#lo; }
  get hi(): number { return this.#lo + this.#hashes.length / 32 - 1; }

  /** Internal-order hash at `height`, or null outside the verified run. */
  hashAt(height: number): Uint8Array | null {
    if (!Number.isInteger(height) || height < this.#lo || height > this.hi) return null;
    return this.#hashes.subarray((height - this.#lo) * 32, (height - this.#lo + 1) * 32);
  }

  /** Display-order hash at `height`, or null. */
  hashHexAt(height: number): string | null {
    const h = this.hashAt(height);
    return h ? hashHex(h) : null;
  }

  /** The verified 80-byte header at `height` if it was fetched in this session. */
  rawAt(height: number): Uint8Array | null { return this.#raw.get(height) ?? null; }

  /**
   * A run that contains the checkpoint and at least DGW_WINDOW headers below it: linkage everywhere, the pinned hash at the
   * checkpoint, and every header rule above it.
   */
  static fromCheckpoint(network: Network, cp: Checkpoint, run: HeaderRun, o: CheckOptions): HeaderChain {
    const n = checkRun(run);
    const at = cp.height - run.from;
    if (at < DGW_WINDOW || at >= n) throw new VerificationError('header-chain', `the header run must cover the checkpoint ${cp.height} and ${DGW_WINDOW} headers below it`);
    if (!bytesEqual(run.hashes.subarray(at * 32, at * 32 + 32), hashBytes(cp.hash))) fail(cp.height, 'is not the pinned checkpoint');
    const timings: HeaderTiming[] = [];
    for (let i = at - DGW_WINDOW + 1; i <= at; i++) timings.push(timingOf(run.headers, i));
    const chain = new HeaderChain(network, cp, run.from, Uint8Array.from(prevHashOf(run.headers, 0)), run.hashes.slice(0, (at + 1) * 32), timings);
    chain.#keepRaw(run, 0, at + 1);
    if (at + 1 < n) chain.extendUp({ from: cp.height + 1, headers: run.headers.subarray((at + 1) * 80), hashes: run.hashes.subarray((at + 1) * 32) }, o);
    return chain;
  }

  /** Resume from a cache entry (it was fully verified when written, and its checkpoint must be today's). */
  static fromStored(s: StoredChain, cp: Checkpoint): HeaderChain | null {
    if (s.version !== 1 || s.checkpoint.height !== cp.height || s.checkpoint.hash !== cp.hash) return null;
    if (s.hashes.length % 32 || s.hashes.length === 0 || s.prevOfLo.length !== 32 || s.timings.length !== DGW_WINDOW) return null;
    const c = new HeaderChain(s.network, cp, s.lo, s.prevOfLo, s.hashes, s.timings);
    if (c.hi !== s.chainLock.height || hashHex(c.hashAt(c.hi)!) !== s.chainLock.blockHash) return null;
    if (cp.height >= c.lo && cp.height <= c.hi && hashHex(c.hashAt(cp.height)!) !== cp.hash) return null;
    return c;
  }

  /** Headers hi+1.. : linkage, proof of work, DGW difficulty, MTP and future time, each checked like Core's header validation. */
  extendUp(run: HeaderRun, o: CheckOptions): void {
    const n = checkRun(run);
    if (run.from !== this.hi + 1) throw new VerificationError('header-chain', `run starts at ${run.from}, expected ${this.hi + 1}`);
    if (!bytesEqual(prevHashOf(run.headers, 0), this.hashAt(this.hi)!)) fail(run.from, 'does not link to the verified chain');
    const timings = this.#timings.slice();
    for (let i = 0; i < n; i++) {
      const height = run.from + i, t = timingOf(run.headers, i), hash = run.hashes.subarray(i * 32, i * 32 + 32);
      // validation.cpp:4487 (bad-diffbits), :4310 (high-hash), :4505 (time-too-old), :4509 (time-too-new)
      if (t.bits !== nextWorkRequired(timings, t.time, o.pow)) fail(height, 'difficulty (nBits) is not what Dark Gravity Wave requires');
      if (!checkProofOfWork(hash, t.bits, o.pow)) fail(height, 'proof of work does not meet its target');
      if (t.time <= medianTimePast(timings)) fail(height, 'timestamp is not above the median of the previous 11');
      if (t.time > o.now + MAX_FUTURE_BLOCK_TIME) fail(height, 'timestamp is more than 2 hours in the future');
      timings.push(t);
    }
    const next = new Uint8Array(this.#hashes.length + run.hashes.length);
    next.set(this.#hashes);
    next.set(run.hashes, this.#hashes.length);
    this.#hashes = next;
    this.#timings = timings;
    this.#keepRaw(run, 0, n);
  }

  /** Headers ..lo-1, authenticated by linking up into the verified run (no work check needed below a verified block). */
  extendDown(run: HeaderRun): void {
    const n = checkRun(run);
    if (run.from + n !== this.#lo) throw new VerificationError('header-chain', `run ends at ${run.from + n - 1}, expected ${this.#lo - 1}`);
    if (!bytesEqual(run.hashes.subarray((n - 1) * 32), this.#prevOfLo)) fail(this.#lo - 1, 'is not the parent of the verified chain');
    const next = new Uint8Array(this.#hashes.length + run.hashes.length);
    next.set(run.hashes);
    next.set(this.#hashes, run.hashes.length);
    this.#hashes = next;
    this.#prevOfLo = Uint8Array.from(prevHashOf(run.headers, 0));
    this.#lo = run.from;
    this.#keepRaw(run, 0, n);
  }

  /**
   * State to persist: the run cut at its ChainLock (headers above it are not final and are never stored), keeping at most
   * `maxHeights` heights from the top. Null when the lock is not inside the headers verified in this session.
   */
  toStored(chainLock: StoredChain['chainLock'], maxHeights = Infinity): StoredChain | null {
    const top = chainLock.height, cut = this.hi - top;
    if (top < this.#lo || cut < 0 || hashHex(this.hashAt(top)!) !== chainLock.blockHash) return null;
    if (this.#timings.length - cut < DGW_WINDOW) return null;
    const timings = this.#timings.slice(this.#timings.length - cut - DGW_WINDOW, this.#timings.length - cut);
    let lo = this.#lo, prevOfLo = this.#prevOfLo, hashes = this.#hashes.subarray(0, (top - lo + 1) * 32);
    if (hashes.length / 32 > maxHeights) {
      const drop = hashes.length / 32 - maxHeights;
      prevOfLo = hashes.subarray((drop - 1) * 32, drop * 32);
      hashes = hashes.subarray(drop * 32);
      lo += drop;
    }
    return { version: 1, network: this.network, checkpoint: this.checkpoint, lo, prevOfLo: Uint8Array.from(prevOfLo), hashes: Uint8Array.from(hashes), timings, chainLock };
  }

  #keepRaw(run: HeaderRun, a: number, b: number): void {
    for (let i = a; i < b; i++) this.#raw.set(run.from + i, run.headers.subarray(i * 80, i * 80 + 80));
  }
}
