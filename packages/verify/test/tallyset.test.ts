// The packed tally set format (src/tallyset.ts; packages/contracts-v1/README.md "talliesSet").
import { describe, expect, it } from 'vitest';
import {
  decodeTallySet,
  encodeTallySetStream,
  paginateTallySet,
  splitTallySetStream,
  TALLY_SET_ENTRY_BYTES,
  TALLY_SET_FIELD_BYTES,
  TALLY_SET_MAX_ENTRIES,
  tallySetFields,
  type TallySetEntry,
} from '../src/index.ts';

const h = (n: number, salt = 0) => (n * 7919 + salt).toString(16).padStart(8, '0').repeat(8);
const entry = (n: number, over: Partial<TallySetEntry> = {}): TallySetEntry => ({
  govHash: h(n),
  yesWeighted: 1000 + n,
  noWeighted: 20 + n,
  abstainWeighted: n,
  yesCount: 900 + n,
  noCount: 15,
  abstainCount: 1,
  voteSetHash: h(n, 1),
  rank: n + 1,
  inNextBudget: n % 2 === 0,
  margin: n % 3 === 0 ? -(n + 5) : n * 100,
  ...over,
});
const fieldsOf = (es: TallySetEntry[]) => {
  const f = tallySetFields(es);
  return [f.b0, f.b1, f.b2];
};
const sortByHash = (es: TallySetEntry[]) => [...es].sort((a, b) => (a.govHash < b.govHash ? -1 : 1));

describe('tally set v1', () => {
  it('round-trips 0, 6, 30 and the maximum number of entries; sorted by govHash', () => {
    for (const n of [0, 6, 30, TALLY_SET_MAX_ENTRIES]) {
      const es = Array.from({ length: n }, (_, i) => entry(i));
      const stream = encodeTallySetStream(es);
      expect(stream.length).toBe(3 + n * TALLY_SET_ENTRY_BYTES);
      expect(decodeTallySet(fieldsOf(es))).toEqual(sortByHash(es));
    }
    expect(TALLY_SET_MAX_ENTRIES).toBe(161);
  });

  it('30 entries fit in b0; the maximum needs all three fields, each but the last full', () => {
    expect(Object.keys(tallySetFields(Array.from({ length: 30 }, (_, i) => entry(i))))).toEqual(['b0']);
    const f = tallySetFields(Array.from({ length: TALLY_SET_MAX_ENTRIES }, (_, i) => entry(i)));
    expect([f.b0!.length, f.b1!.length]).toEqual([TALLY_SET_FIELD_BYTES, TALLY_SET_FIELD_BYTES]);
    expect(f.b2!.length).toBeLessThanOrEqual(TALLY_SET_FIELD_BYTES);
  });

  it('keeps the extremes of every field', () => {
    const e = entry(1, { yesWeighted: 0xffffffff, noWeighted: 0, rank: 0xffff, margin: -0x80000000, inNextBudget: true });
    const f = entry(2, { margin: 0x7fffffff, rank: 0, inNextBudget: false });
    expect(decodeTallySet(fieldsOf([e, f]))).toEqual(sortByHash([e, f]));
  });

  it('a replace with the same proposals keeps the size (fixed width)', () => {
    const a = encodeTallySetStream([entry(1), entry(2)]);
    const b = encodeTallySetStream([entry(1, { yesWeighted: 999_999, margin: -7 }), entry(2)]);
    expect(b.length).toBe(a.length);
  });

  it('rejects what does not fit the contract fields', () => {
    expect(() => encodeTallySetStream(Array.from({ length: TALLY_SET_MAX_ENTRIES + 1 }, (_, i) => entry(i)))).toThrow(/at most 161/);
    expect(() => encodeTallySetStream([entry(1), entry(1)])).toThrow(/duplicate/);
    expect(() => encodeTallySetStream([entry(1, { rank: 70_000 })])).toThrow(/rank/);
    expect(() => encodeTallySetStream([entry(1, { margin: 2 ** 31 })])).toThrow(/margin/);
    expect(() => encodeTallySetStream([entry(1, { yesWeighted: -1 })])).toThrow(/yesWeighted/);
    expect(() => encodeTallySetStream([entry(1, { voteSetHash: 'ab' })])).toThrow(/voteSetHash/);
  });

  describe('decoding is strict', () => {
    const good = () => encodeTallySetStream([entry(1), entry(2), entry(3)]);
    it('unknown version', () => {
      const s = good();
      s[0] = 2;
      expect(() => decodeTallySet([s])).toThrow(/version 2/);
    });
    it('count that does not match the length (a truncated or padded set)', () => {
      const s = good();
      expect(() => decodeTallySet([s.slice(0, -1)])).toThrow(/bytes for 3 entries/);
      const c = good();
      c[2] = 4;
      expect(() => decodeTallySet([c])).toThrow(/bytes for 4 entries/);
      expect(() => decodeTallySet([new Uint8Array([1, 0])])).toThrow(/header/);
    });
    it('unsorted or duplicate entries', () => {
      const s = good();
      const swapped = new Uint8Array(s);
      swapped.set(s.subarray(3, 3 + 95), 3 + 95);
      swapped.set(s.subarray(3 + 95, 3 + 190), 3);
      expect(() => decodeTallySet([swapped])).toThrow(/sorted/);
      const dup = new Uint8Array(s);
      dup.set(s.subarray(3, 3 + 95), 3 + 95);
      expect(() => decodeTallySet([dup])).toThrow(/sorted/);
    });
    it('unknown flag bits', () => {
      const s = good();
      s[3 + 90] = 2;
      expect(() => decodeTallySet([s])).toThrow(/flag/);
    });
    it('non-canonical field split', () => {
      const big = encodeTallySetStream(Array.from({ length: 60 }, (_, i) => entry(i)));
      const [b0, b1] = splitTallySetStream(big);
      expect(decodeTallySet([b0, b1])).toHaveLength(60);
      // the same bytes split elsewhere, or a gap, are not a set
      expect(() => decodeTallySet([big.slice(0, 100), big.slice(100)])).toThrow(/not full/);
      expect(() => decodeTallySet([b0, undefined, b1])).toThrow(/missing/);
      expect(() => decodeTallySet([undefined])).toThrow(/needs b0/);
    });
  });

  it('paginates in govHash order, at most 161 per page, always at least one page', () => {
    expect(paginateTallySet([])).toEqual([[]]);
    const es = Array.from({ length: 200 }, (_, i) => entry(i));
    const pages = paginateTallySet(es);
    expect(pages.map((p) => p.length)).toEqual([161, 39]);
    expect(pages.flat()).toEqual(sortByHash(es));
  });
});
