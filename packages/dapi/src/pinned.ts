// Old blocks without the headers in between: short runs of headers that hash-link up to a block hash this build pins (QUORUM_PINS,
// quorumpins.ts: every pin is an ancestor of the pinned quorum checkpoint, derived from it by hash linkage when the table was
// generated). A block 100,000 deep costs the headers from it up to the next pin above it (at most a pin spacing), not 100,000.
//
// Trust: the same as the quorum checkpoint itself. A pin is a hash the build already commits to (the checkpoint fixes all of its
// ancestors through prevHash links), and a run is accepted only when its headers link, each header's X11 hash being the next
// one's prevHash, up to that pinned hash (or down from a segment accepted that way). A node can withhold headers, not forge them.
// Pure (no I/O).
import { bytesEqual, hashBytes, hashHex } from './bytes.ts';
import type { Network } from './chainlock.ts';
import { VerificationError } from './errors.ts';
import { type HeaderRun, checkRun, prevHashOf } from './headerchain.ts';
import type { VerifiedChain } from './linkedchain.ts';
import type { PinTable } from './quorumpins.ts';

/** Longest run fetched to reach a pin (the built-in tables are spaced 2,000 apart): anything deeper below the lowest pin is out of reach. */
export const MAX_PIN_SPAN = 5_000;
/** Segment heights kept in the store (~3.2 MB of hashes); the oldest segments are dropped first. */
export const MAX_PINNED_HEIGHTS = 100_000;

/** A run of verified hashes `lo..pin`, its top being the pinned block. */
interface Segment {
  pin: number;
  lo: number;
  /** Hash of block lo - 1 (header lo's prevHash), internal order: a run below links into it. */
  prevOfLo: Uint8Array;
  /** 32 bytes per height lo..pin, internal order; the last one is the pinned hash. */
  hashes: Uint8Array;
}

/** Serializable state of a PinnedChain, for a cache (IndexedDB). */
export interface StoredPinned {
  version: 1;
  kind: 'pinned';
  network: Network;
  /** The quorum checkpoint the pins descend from: another one (a new build) discards the entry. */
  checkpoint: number;
  segments: Array<{ pin: number; pinHash: string; lo: number; prevOfLo: Uint8Array; hashes: Uint8Array }>;
}

const fail = (height: number, msg: string): never => { throw new VerificationError('pinned-chain', `block ${height}: ${msg}`, height); };

/**
 * A pinned hash or run and the contiguous verified run disagree on a block: one of them is forged (or the stored copy is damaged).
 * Anchoring fails closed; `pins` names held runs to drop so that the next attempt fetches and links them again.
 */
export class PinConflictError extends VerificationError {
  readonly pins: number[];
  constructor(height: number, pins: number[]) {
    super('pin-conflict', `block ${height}: the pinned chain and the verified chain disagree`);
    this.name = 'PinConflictError';
    this.pins = pins;
  }
}

/** A pin table checked for shape: strictly ascending heights at or below the checkpoint, 64-hex hashes, the checkpoint on top. */
export function checkPinTable(t: PinTable): void {
  if (!t.pins.length) throw new Error(`${t.network} pin table is empty`);
  let last = 0;
  for (const [h, hash] of t.pins) {
    if (!Number.isSafeInteger(h) || h <= last || h > t.checkpoint.height) throw new Error(`${t.network} pin ${h} is out of order or above the checkpoint`);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${t.network} pin ${h} is not a display-order hash`);
    last = h;
  }
  const top = t.pins[t.pins.length - 1]!;
  if (top[0] !== t.checkpoint.height || top[1] !== t.checkpoint.blockHash) throw new Error(`${t.network} pin table does not end at its checkpoint`);
}

export class PinnedChain {
  readonly network: Network;
  readonly table: PinTable;
  readonly #heights: number[];
  readonly #hashes: Uint8Array[];
  /** By pin height, in insertion order (the oldest is dropped first past MAX_PINNED_HEIGHTS, in memory and in the store). */
  readonly #segments = new Map<number, Segment>();

  constructor(table: PinTable) {
    checkPinTable(table);
    this.network = table.network;
    this.table = table;
    this.#heights = table.pins.map(([h]) => h);
    this.#hashes = table.pins.map(([, h]) => hashBytes(h));
  }

  /** Index of the lowest pin at or above `height`, or -1. */
  #pinIndex(height: number): number {
    let lo = 0, hi = this.#heights.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.#heights[mid]! < height) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.#heights.length ? lo : -1;
  }

  /** The pin a run for `height` must link up to, when one is within MAX_PIN_SPAN above it (else the block is out of the pins' reach). */
  pinFor(height: number): { height: number; hash: string } | null {
    if (!Number.isSafeInteger(height) || height < 1) return null;
    const i = this.#pinIndex(height);
    if (i < 0 || this.#heights[i]! - height > MAX_PIN_SPAN) return null;
    return { height: this.#heights[i]!, hash: this.table.pins[i]![1] };
  }

  /** Internal-order hash at `height`: a pinned one, or one of a segment linked to a pin; null otherwise. */
  hashAt(height: number): Uint8Array | null {
    if (!Number.isSafeInteger(height)) return null;
    const i = this.#pinIndex(height);
    if (i < 0) return null;
    if (this.#heights[i] === height) return this.#hashes[i]!;
    const s = this.#segments.get(this.#heights[i]!);
    if (!s || height < s.lo) return null;
    return s.hashes.subarray((height - s.lo) * 32, (height - s.lo + 1) * 32);
  }

  hashHexAt(height: number): string | null {
    const h = this.hashAt(height);
    return h ? hashHex(h) : null;
  }

  /** Segments held (each a run up to one pin). */
  get segments(): number { return this.#segments.size; }

  /** Heights held in segments (pins alone not counted). */
  get heights(): number { let n = 0; for (const s of this.#segments.values()) n += s.hashes.length / 32; return n; }

  /**
   * What to download so that `height` is covered: heights from..to, the run ending at the pin (a new segment) or just below the
   * segment that already reaches down toward it. Null when it is covered, undefined when no pin is within reach.
   */
  need(height: number): { from: number; to: number } | null | undefined {
    if (this.hashAt(height)) return null;
    const pin = this.pinFor(height);
    if (!pin) return undefined;
    const s = this.#segments.get(pin.height);
    return { from: height, to: s ? s.lo - 1 : pin.height };
  }

  /**
   * Accept a run from `need`: it must link throughout and end at the pinned hash, or at the parent of the segment above it, and agree
   * with `against` (the contiguous verified run) wherever both have a block. Nothing is kept unless every check passes.
   */
  apply(run: HeaderRun, against?: VerifiedChain): void {
    const n = checkRun(run), top = run.from + n - 1;
    const pin = this.pinFor(run.from);
    if (!pin || top > pin.height) throw new VerificationError('pinned-chain', `run ${run.from}..${top} does not end at or below a pin`);
    const s = this.#segments.get(pin.height);
    const last = run.hashes.subarray((n - 1) * 32);
    let hashes: Uint8Array;
    if (s) {
      if (top !== s.lo - 1) throw new VerificationError('pinned-chain', `run ends at ${top}, expected ${s.lo - 1}`);
      if (!bytesEqual(last, s.prevOfLo)) fail(top, 'is not the parent of the segment below the pin');
      hashes = new Uint8Array(run.hashes.length + s.hashes.length);
      hashes.set(run.hashes);
      hashes.set(s.hashes, run.hashes.length);
    } else {
      if (top !== pin.height) throw new VerificationError('pinned-chain', `run ends at ${top}, expected the pin at ${pin.height}`);
      if (!bytesEqual(last, hashBytes(pin.hash))) fail(top, `is not the pinned block ${pin.hash}`);
      hashes = run.hashes.slice();
    }
    const next: Segment = { pin: pin.height, lo: run.from, prevOfLo: Uint8Array.from(prevHashOf(run.headers, 0)), hashes };
    if (against) {
      const bad = disagreement(next, against);
      if (bad !== null) throw new PinConflictError(bad, []);
    }
    this.#segments.delete(pin.height); // (re-)inserted as the newest
    this.#segments.set(pin.height, next);
    for (const k of this.#segments.keys()) {
      if (this.heights <= MAX_PINNED_HEIGHTS || k === pin.height) break;
      this.#segments.delete(k);
    }
  }

  /** Drop a held run (it disagreed with the verified chain): the next use fetches and links it again. */
  drop(pin: number): void { this.#segments.delete(pin); }

  /**
   * Every height `other` also verifies must carry the same hash here, pins and held runs alike: two verified sources that disagree mean
   * a forgery or a damaged store. Throws PinConflictError (naming the runs to drop).
   */
  checkAgainst(other: VerifiedChain): void {
    for (let i = this.#pinIndex(other.lo); i >= 0 && i < this.#heights.length && this.#heights[i]! <= other.hi; i++) {
      const o = other.hashAt(this.#heights[i]!);
      if (o && !bytesEqual(o, this.#hashes[i]!)) throw new PinConflictError(this.#heights[i]!, []);
    }
    for (const s of this.#segments.values()) {
      const bad = disagreement(s, other);
      if (bad !== null) throw new PinConflictError(bad, [s.pin]);
    }
  }

  /** State to persist, keeping the newest segments up to `maxHeights` heights. */
  toStored(maxHeights = MAX_PINNED_HEIGHTS): StoredPinned {
    const keep: Segment[] = [];
    let n = 0;
    for (const s of [...this.#segments.values()].reverse()) {
      n += s.hashes.length / 32;
      if (n > maxHeights) break;
      keep.unshift(s);
    }
    return {
      version: 1, kind: 'pinned', network: this.network, checkpoint: this.table.checkpoint.height,
      segments: keep.map((s) => ({ pin: s.pin, pinHash: this.hashHexAt(s.pin)!, lo: s.lo, prevOfLo: Uint8Array.from(s.prevOfLo), hashes: Uint8Array.from(s.hashes) })),
    };
  }

  /** Resume from a cache entry for the same table (segments were verified when written; one whose pin changed is dropped). */
  static fromStored(s: StoredPinned | null | undefined, table: PinTable): PinnedChain {
    const c = new PinnedChain(table);
    if (!s || s.version !== 1 || s.kind !== 'pinned' || s.network !== table.network || s.checkpoint !== table.checkpoint.height || !Array.isArray(s.segments)) return c;
    for (const g of s.segments) {
      const pin = c.pinFor(g.pin);
      if (!pin || pin.height !== g.pin || pin.hash !== g.pinHash) continue;
      if (!(g.hashes instanceof Uint8Array) || !(g.prevOfLo instanceof Uint8Array) || g.prevOfLo.length !== 32 || g.hashes.length % 32 || !g.hashes.length) continue;
      if (!Number.isSafeInteger(g.lo) || g.lo + g.hashes.length / 32 - 1 !== g.pin || !bytesEqual(g.hashes.subarray(g.hashes.length - 32), hashBytes(pin.hash))) continue;
      const below = c.pinFor(g.lo);
      if (!below || below.height !== g.pin) continue; // a segment never reaches past the pin below it
      c.#segments.set(g.pin, { pin: g.pin, lo: g.lo, prevOfLo: g.prevOfLo, hashes: g.hashes });
    }
    return c;
  }
}

/** The first height where a run and `other` both have a block with different hashes, or null. */
function disagreement(s: Segment, other: VerifiedChain): number | null {
  for (let h = Math.max(s.lo, other.lo); h <= Math.min(s.pin, other.hi); h++) {
    const o = other.hashAt(h);
    if (o && !bytesEqual(o, s.hashes.subarray((h - s.lo) * 32, (h - s.lo + 1) * 32))) return h;
  }
  return null;
}

/**
 * The anchored chain as handed out: the contiguous run `lo..hi` down from the ChainLock (or up from the header checkpoint), plus any
 * older block reached through a pin. `lo` stays the bottom of the contiguous run; `hashAt` answers for pinned heights below it too.
 */
export class PinnedView implements VerifiedChain {
  readonly #main: VerifiedChain;
  readonly #pinned: PinnedChain;
  constructor(main: VerifiedChain, pinned: PinnedChain) {
    this.#main = main;
    this.#pinned = pinned;
  }
  /** The contiguous run. */
  get main(): VerifiedChain { return this.#main; }
  get lo(): number { return this.#main.lo; }
  get hi(): number { return this.#main.hi; }
  hashAt(height: number): Uint8Array | null { return this.#main.hashAt(height) ?? (height < this.#main.lo ? this.#pinned.hashAt(height) : null); }
  hashHexAt(height: number): string | null {
    const h = this.hashAt(height);
    return h ? hashHex(h) : null;
  }
  rawAt(height: number): Uint8Array | null { return this.#main.rawAt(height); }
  /** The pin a height below the contiguous run is linked to (null for heights of the run, and for heights not covered at all). */
  pinOf(height: number): { height: number; hash: string } | null {
    if (height >= this.#main.lo || !this.#pinned.hashAt(height)) return null;
    return this.#pinned.pinFor(height);
  }
}
