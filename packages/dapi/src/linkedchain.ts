// A contiguous run of block hashes whose top is a ChainLocked block this client verified (through a quorum proof chain, see
// quorumproof.ts), and everything below it authenticated by hash linkage alone: each header's X11 hash is the next header's prevHash,
// up to the locked block's hash. No proof of work or difficulty rule is checked or needed: a ChainLock is final, and X11 preimage
// resistance makes the linkage unforgeable. Pure (no I/O).
import { bytesEqual, hashHex } from './bytes.ts';
import type { Network } from './chainlock.ts';
import { VerificationError } from './errors.ts';
import { type HeaderRun, checkRun, prevHashOf } from './headerchain.ts';
import type { ProofState } from './quorumproof.ts';

/** What anchoring hands out: verified hashes from `lo` to `hi`, and the raw headers fetched in this session. */
export interface VerifiedChain {
  readonly lo: number;
  readonly hi: number;
  /** Internal-order hash at `height`, or null outside the verified run. */
  hashAt(height: number): Uint8Array | null;
  /** Display-order hash at `height`, or null. */
  hashHexAt(height: number): string | null;
  /** The verified 80-byte header at `height` if it was fetched in this session. */
  rawAt(height: number): Uint8Array | null;
}

/** Serializable state of a LinkedChain, for a cache (IndexedDB). */
export interface StoredLinkedChain {
  version: 2;
  kind: 'chainlock';
  network: Network;
  /** The pinned checkpoint the whole history was proven from: a different pin discards the entry. */
  root: { height: number; blockHash: string };
  lo: number;
  /** Hash of block lo - 1 (header lo's prevHash), internal order. */
  prevOfLo: Uint8Array;
  /** 32 bytes per height lo..hi, internal order. */
  hashes: Uint8Array;
  /** The proof-verified ChainLock the run ends at (hi): its header and signature let it serve again while it is fresh. */
  chainLock: { height: number; blockHash: string; header?: Uint8Array; signature?: Uint8Array };
  /** The proof-verified state of that block: the next proof may start from it instead of the checkpoint. */
  state: ProofState;
}

const fail = (height: number, msg: string): never => { throw new VerificationError('header-chain', `block ${height}: ${msg}`, height); };
/** Whether the last of the run's `n` headers hashes to `hash`. */
const endsWith = (run: HeaderRun, n: number, hash: Uint8Array): boolean => bytesEqual(run.hashes.subarray((n - 1) * 32), hash);

export class LinkedChain implements VerifiedChain {
  readonly network: Network;
  #lo: number;
  #prevOfLo: Uint8Array;
  #hashes: Uint8Array;
  readonly #raw = new Map<number, Uint8Array>();

  private constructor(network: Network, lo: number, prevOfLo: Uint8Array, hashes: Uint8Array) {
    this.network = network;
    this.#lo = lo;
    this.#prevOfLo = prevOfLo;
    this.#hashes = hashes;
  }

  get lo(): number { return this.#lo; }
  get hi(): number { return this.#lo + this.#hashes.length / 32 - 1; }

  hashAt(height: number): Uint8Array | null {
    if (!Number.isInteger(height) || height < this.#lo || height > this.hi) return null;
    return this.#hashes.subarray((height - this.#lo) * 32, (height - this.#lo + 1) * 32);
  }

  hashHexAt(height: number): string | null {
    const h = this.hashAt(height);
    return h ? hashHex(h) : null;
  }

  rawAt(height: number): Uint8Array | null { return this.#raw.get(height) ?? null; }

  /** A run ending at a verified ChainLocked block: it must link throughout and its last header must hash to `top.hash`. */
  static fromTop(network: Network, run: HeaderRun, top: { height: number; hash: Uint8Array }): LinkedChain {
    const n = checkRun(run);
    if (run.from + n - 1 !== top.height) throw new VerificationError('header-chain', `the header run must end at the ChainLocked block ${top.height}`);
    if (!endsWith(run, n, top.hash)) fail(top.height, 'is not the ChainLocked block');
    const c = new LinkedChain(network, run.from, Uint8Array.from(prevHashOf(run.headers, 0)), run.hashes.slice());
    c.#keepRaw(run, n);
    return c;
  }

  /** Resume from a cache entry proven from the same pinned checkpoint on `network` (it was verified when written). */
  static fromStored(s: StoredLinkedChain, root: { height: number; blockHash: string }, network: Network): LinkedChain | null {
    if (s.version !== 2 || s.kind !== 'chainlock' || s.network !== network || s.root.height !== root.height || s.root.blockHash !== root.blockHash) return null;
    if (!(s.hashes instanceof Uint8Array) || !(s.prevOfLo instanceof Uint8Array) || s.hashes.length % 32 || s.hashes.length === 0 || s.prevOfLo.length !== 32) return null;
    if (!Number.isSafeInteger(s.lo) || s.lo < 1 || !Number.isSafeInteger(s.chainLock.height) || !s.state) return null;
    const c = new LinkedChain(s.network, s.lo, s.prevOfLo, s.hashes);
    if (c.hi !== s.chainLock.height || c.hashHexAt(c.hi) !== s.chainLock.blockHash) return null;
    if (s.state.network !== s.network || s.state.height !== s.chainLock.height || s.state.blockHash !== s.chainLock.blockHash) return null;
    return c;
  }

  /** Headers hi+1..top.height up to a newer verified ChainLocked block: linkage from the current top, ending at `top.hash`. */
  extendUpTo(run: HeaderRun, top: { height: number; hash: Uint8Array }): void {
    const n = checkRun(run);
    if (run.from !== this.hi + 1 || run.from + n - 1 !== top.height) throw new VerificationError('header-chain', `run ${run.from}..${run.from + n - 1} does not reach from ${this.hi + 1} to the ChainLocked block ${top.height}`);
    if (!bytesEqual(prevHashOf(run.headers, 0), this.hashAt(this.hi)!)) fail(run.from, 'does not link to the verified chain');
    if (!endsWith(run, n, top.hash)) fail(top.height, 'is not the ChainLocked block');
    const next = new Uint8Array(this.#hashes.length + run.hashes.length);
    next.set(this.#hashes);
    next.set(run.hashes, this.#hashes.length);
    this.#hashes = next;
    this.#keepRaw(run, n);
  }

  /** Headers ..lo-1, authenticated by linking up into the verified run. */
  extendDown(run: HeaderRun): void {
    const n = checkRun(run);
    if (run.from + n !== this.#lo) throw new VerificationError('header-chain', `run ends at ${run.from + n - 1}, expected ${this.#lo - 1}`);
    if (!endsWith(run, n, this.#prevOfLo)) fail(this.#lo - 1, 'is not the parent of the verified chain');
    const next = new Uint8Array(this.#hashes.length + run.hashes.length);
    next.set(run.hashes);
    next.set(this.#hashes, run.hashes.length);
    this.#hashes = next;
    this.#prevOfLo = Uint8Array.from(prevHashOf(run.headers, 0));
    this.#lo = run.from;
    this.#keepRaw(run, n);
  }

  /**
   * State to persist, keeping at most `maxHeights` heights from the top. `state` must be the proof-verified state of hi, `lock` its
   * header and ChainLock signature.
   */
  toStored(root: StoredLinkedChain['root'], state: ProofState, lock: { header: Uint8Array; signature: Uint8Array }, maxHeights = Infinity): StoredLinkedChain {
    const top = this.hashHexAt(this.hi)!;
    if (state.height !== this.hi || state.blockHash !== top || state.network !== this.network) throw new Error('toStored: the state is not the top block');
    let lo = this.#lo, prevOfLo = this.#prevOfLo, hashes = this.#hashes;
    if (hashes.length / 32 > maxHeights) {
      const drop = hashes.length / 32 - maxHeights;
      prevOfLo = hashes.subarray((drop - 1) * 32, drop * 32);
      hashes = hashes.subarray(drop * 32);
      lo += drop;
    }
    return {
      version: 2, kind: 'chainlock', network: this.network, root: { ...root }, lo, prevOfLo: Uint8Array.from(prevOfLo), hashes: Uint8Array.from(hashes),
      chainLock: { height: this.hi, blockHash: top, header: Uint8Array.from(lock.header), signature: Uint8Array.from(lock.signature) }, state: { ...state },
    };
  }

  #keepRaw(run: HeaderRun, count: number): void {
    for (let i = 0; i < count; i++) this.#raw.set(run.from + i, run.headers.subarray(i * 80, i * 80 + 80));
  }
}
