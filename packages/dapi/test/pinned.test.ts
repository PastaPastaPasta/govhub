// Runs of old headers linked up to pinned hashes (src/pinned.ts), on a synthetic chain (only X11 linkage matters here), and the
// shape of the built-in pin tables (src/quorumpins.ts).
import { describe, expect, it } from 'vitest';
import { hashHex } from '../src/bytes.ts';
import type { HeaderRun } from '../src/headerchain.ts';
import { MAX_PIN_SPAN, PinConflictError, PinnedChain, PinnedView, checkPinTable } from '../src/pinned.ts';
import { QUORUM_CHECKPOINTS } from '../src/quorumproof.ts';
import { type PinTable, QUORUM_PINS } from '../src/quorumpins.ts';
import { x11, x11Many } from '../src/x11.ts';
import type { VerifiedChain } from '../src/linkedchain.ts';

/** Heights BASE..BASE+n-1 of a made-up chain: each header's prevHash is the X11 hash of the one before. */
const BASE = 1000, COUNT = 120;
const headers = new Uint8Array(COUNT * 80);
for (let i = 0; i < COUNT; i++) {
  const h = headers.subarray(i * 80, i * 80 + 80);
  new DataView(h.buffer, h.byteOffset).setUint32(0, 0x20000000, true);
  if (i > 0) h.set(x11(headers.subarray((i - 1) * 80, i * 80)), 4);
  h.fill(i + 1, 36, 68); // a merkle root, any
  new DataView(h.buffer, h.byteOffset).setUint32(68, 1_700_000_000 + i * 150, true);
}
const hashes = x11Many(headers);
const hashAt = (h: number) => hashHex(hashes.subarray((h - BASE) * 32, (h - BASE + 1) * 32));
const runOf = (from: number, to: number): HeaderRun => ({ from, headers: headers.slice((from - BASE) * 80, (to - BASE + 1) * 80), hashes: hashes.slice((from - BASE) * 32, (to - BASE + 1) * 32) });
const table = (pins: number[], o: { lie?: number } = {}): PinTable => {
  const top = pins[pins.length - 1]!;
  return {
    network: 'testnet', checkpoint: { height: top, blockHash: hashAt(top) },
    pins: pins.map((h) => [h, h === o.lie ? hashAt(h + 1) : hashAt(h)] as const),
  };
};

describe('PinnedChain', () => {
  it('covers a pinned height with no headers, a deeper one with the run up to its pin, and extends that run down', () => {
    const c = new PinnedChain(table([1040, 1080, 1100]));
    expect(c.need(1080)).toBeNull(); // a pin itself: nothing to fetch
    expect(c.hashHexAt(1080)).toBe(hashAt(1080));
    expect(c.need(1070)).toEqual({ from: 1070, to: 1080 });
    c.apply(runOf(1070, 1080));
    expect(c.hashHexAt(1075)).toBe(hashAt(1075));
    expect(c.hashHexAt(1069)).toBeNull();
    // deeper in the same interval: only the headers below what is held
    expect(c.need(1050)).toEqual({ from: 1050, to: 1069 });
    c.apply(runOf(1050, 1069));
    expect(c.hashHexAt(1050)).toBe(hashAt(1050));
    // the interval below has its own pin: a separate run
    expect(c.need(1030)).toEqual({ from: 1030, to: 1040 });
    expect(c.heights).toBe(31);
    // above the highest pin there is nothing to link to
    expect(c.need(1101)).toBeUndefined();
  });

  it('rejects a run that does not end at the pinned hash (a wrong pin, or a node serving another chain)', () => {
    const c = new PinnedChain(table([1040, 1080, 1100], { lie: 1080 }));
    expect(() => c.apply(runOf(1070, 1080))).toThrow(/is not the pinned block/);
    expect(c.hashAt(1075)).toBeNull();
    expect(c.segments).toBe(0);
  });

  it('rejects a tampered header run: a broken link, a run not reaching the segment, or one past the pin', () => {
    const c = new PinnedChain(table([1080, 1100]));
    const bad = runOf(1070, 1080);
    bad.headers[3 * 80 + 10]! ^= 1; // header 1073's prevHash no longer matches 1072's hash
    expect(() => c.apply(bad)).toThrow(/does not link/);
    c.apply(runOf(1070, 1080));
    const forged = runOf(1060, 1069);
    forged.headers[9 * 80 + 40]! ^= 1; // change 1069's merkle root: its hash changes, so it is not the parent of 1070
    forged.hashes.set(x11(forged.headers.subarray(9 * 80)), 9 * 32);
    expect(() => c.apply(forged)).toThrow(/is not the parent/);
    expect(() => c.apply(runOf(1060, 1068))).toThrow(/expected 1069/);
    expect(() => c.apply(runOf(1085, 1101))).toThrow(/does not end at or below a pin/);
    expect(c.hashHexAt(1069)).toBeNull();
  });

  it('reaches no further than MAX_PIN_SPAN below a pin', () => {
    const pin = 'ab'.repeat(32);
    const c = new PinnedChain({ network: 'testnet', checkpoint: { height: 10_000, blockHash: pin }, pins: [[10_000, pin]] });
    expect(c.pinFor(10_000 - MAX_PIN_SPAN)).toEqual({ height: 10_000, hash: pin });
    expect(c.pinFor(10_000 - MAX_PIN_SPAN - 1)).toBeNull();
    expect(c.need(10_000 - MAX_PIN_SPAN - 1)).toBeUndefined();
  });

  it('round-trips through the store, dropping segments whose pin changed and the oldest past the cap', () => {
    const t = table([1040, 1080, 1100]);
    const c = new PinnedChain(t);
    c.apply(runOf(1030, 1040));
    c.apply(runOf(1070, 1080));
    const back = PinnedChain.fromStored(c.toStored(), t);
    expect(back.hashHexAt(1035)).toBe(hashAt(1035));
    expect(back.hashHexAt(1075)).toBe(hashAt(1075));
    // a newer build moved the pin at 1080: that segment is not trusted any more
    const moved: PinTable = { ...t, pins: t.pins.map(([h, x]) => (h === 1080 ? [1080, hashAt(1079)] as const : [h, x] as const)) };
    const after = PinnedChain.fromStored(c.toStored(), moved);
    expect(after.hashHexAt(1035)).toBe(hashAt(1035));
    expect(after.hashHexAt(1075)).toBeNull();
    // another checkpoint, another network: nothing
    expect(PinnedChain.fromStored({ ...c.toStored(), checkpoint: 1 }, t).segments).toBe(0);
    expect(PinnedChain.fromStored({ ...c.toStored(), network: 'mainnet' }, t).segments).toBe(0);
    // a damaged entry (hashes not ending at the pin) is skipped
    const s = c.toStored();
    s.segments[1]!.hashes = s.segments[1]!.hashes.slice(32);
    expect(PinnedChain.fromStored(s, t).hashHexAt(1075)).toBeNull();
    // the cap keeps the newest segments
    expect(c.toStored(11).segments.map((x) => x.pin)).toEqual([1080]);
  });

  it('fails closed when the pinned runs (or the pins) and the verified run disagree on a block, keeping nothing new', () => {
    const c = new PinnedChain(table([1080, 1100]));
    const honest: VerifiedChain = { lo: 1078, hi: 1119, hashAt: (h) => (h >= 1078 ? hashes.subarray((h - BASE) * 32, (h - BASE + 1) * 32) : null), hashHexAt: () => null, rawAt: () => null };
    const liar: VerifiedChain = { ...honest, hashAt: (h) => (h === 1079 ? new Uint8Array(32) : honest.hashAt(h)) };
    // a new run that disagrees is refused before it is kept
    expect(() => c.apply(runOf(1070, 1080), liar)).toThrow(PinConflictError);
    expect(c.segments).toBe(0);
    c.apply(runOf(1070, 1080), honest);
    expect(() => c.checkAgainst(honest)).not.toThrow();
    // a held run that disagrees is named so it can be dropped
    let err: unknown;
    try { c.checkAgainst(liar); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PinConflictError);
    expect((err as PinConflictError).pins).toEqual([1080]);
    c.drop(1080);
    expect(c.hashAt(1075)).toBeNull();
    // a pin itself inside the verified run must match it too
    const pinLiar: VerifiedChain = { ...honest, hashAt: (h) => (h === 1100 ? new Uint8Array(32) : honest.hashAt(h)) };
    expect(() => c.checkAgainst(pinLiar)).toThrow(PinConflictError);
  });

  it('the anchored view answers below the contiguous run through pins, and names the pin', () => {
    const c = new PinnedChain(table([1040, 1100]));
    c.apply(runOf(1030, 1040));
    const main: VerifiedChain = { lo: 1090, hi: 1119, hashAt: (h) => (h >= 1090 && h <= 1119 ? hashes.subarray((h - BASE) * 32, (h - BASE + 1) * 32) : null), hashHexAt: () => null, rawAt: () => null };
    const v = new PinnedView(main, c);
    expect(v.lo).toBe(1090);
    expect(v.hashHexAt(1095)).toBe(hashAt(1095));
    expect(v.pinOf(1095)).toBeNull();
    expect(v.hashHexAt(1033)).toBe(hashAt(1033));
    expect(v.pinOf(1033)).toEqual({ height: 1040, hash: hashAt(1040) });
    expect(v.hashHexAt(1060)).toBeNull();
    expect(v.pinOf(1060)).toBeNull();
  });
});

describe('the built-in pin tables', () => {
  for (const network of ['mainnet', 'testnet'] as const) {
    it(`${network}: well formed, ending at the quorum checkpoint, at most 2,000 apart over 400,000 blocks`, () => {
      const t = QUORUM_PINS[network];
      expect(() => checkPinTable(t)).not.toThrow();
      expect(t.checkpoint).toEqual({ height: QUORUM_CHECKPOINTS[network].height, blockHash: QUORUM_CHECKPOINTS[network].blockHash });
      expect(t.pins[0]![0]).toBeLessThanOrEqual(t.checkpoint.height - 400_000);
      for (let i = 1; i < t.pins.length; i++) expect(t.pins[i]![0] - t.pins[i - 1]![0]).toBeLessThanOrEqual(2_000);
      // every height in that range has a pin within one spacing above it
      const c = new PinnedChain(t);
      for (let h = t.checkpoint.height - 400_000; h <= t.checkpoint.height; h += 997) expect(c.pinFor(h)!.height - h).toBeLessThanOrEqual(2_000);
    });
  }
  it('mainnet pins every superblock in its range (a payment check reads them without headers)', () => {
    const t = QUORUM_PINS.mainnet, at = new Set(t.pins.map(([h]) => h));
    for (let h = Math.ceil(t.pins[0]![0] / 16_616) * 16_616; h < t.checkpoint.height; h += 16_616) expect(at.has(h), String(h)).toBe(true);
  });
});
