import { describe, expect, it } from 'vitest';
import { countVotes, tallyVotes, voteSetHash, voteSetPreimage, VOTE_SET_DOMAIN } from '../src/index.ts';

const A = 'ab'.repeat(32);
const Z = '00'.repeat(32);

describe('voteSetHash (govhub-voteset-v1)', () => {
  // Expected values computed independently with coreutils:
  //   printf 'govhub-voteset-v1\n<Z>-0|3|1700000002\n<A>-10|1|1700000000\n<A>-9|2|1700000001\n' | shasum -a 256
  it('matches the pinned vector (ASCII order puts "-10" before "-9"; ids are normalised)', () => {
    const entries = [
      { mn: `${A.toUpperCase()}-10`, outcome: 1, time: 1700000000 },
      { mn: `${A}-09`, outcome: 2, time: 1700000001n },
      { mn: `${Z}-0`, outcome: 3, time: 1700000002 },
    ];
    expect(voteSetPreimage(entries)).toBe(`govhub-voteset-v1\n${Z}-0|3|1700000002\n${A}-10|1|1700000000\n${A}-9|2|1700000001\n`);
    expect(voteSetHash(entries)).toBe('6a0902cd1d0d3cb181fd0d688076f76d7e4ce775436f29949801105a326b66ad');
    expect(voteSetHash([...entries].reverse())).toBe('6a0902cd1d0d3cb181fd0d688076f76d7e4ce775436f29949801105a326b66ad');
  });

  it('hashes the bare domain for an empty set', () => {
    expect(VOTE_SET_DOMAIN).toBe('govhub-voteset-v1\n');
    expect(voteSetHash([])).toBe('9f663a94fdf1b539292cd033b3de366c4836d4055b0043706e7e575ad5303692');
  });

  it('rejects malformed ids, duplicates and bad outcomes', () => {
    expect(() => voteSetHash([{ mn: 'not-an-outpoint', outcome: 1, time: 1 }])).toThrow(/outpoint/);
    expect(() => voteSetHash([{ mn: `${A}-1`, outcome: 1, time: 1 }, { mn: `${A}-01`, outcome: 2, time: 2 }])).toThrow(/twice/);
    expect(() => voteSetHash([{ mn: `${A}-1`, outcome: 4, time: 1 }])).toThrow(/outcome/);
  });

  it('composes with tallyVotes: hash the current votes of masternodes in the weight map', () => {
    const weights = new Map([[`${A}-1`, 1], [`${Z}-2`, 4]]);
    const t = tallyVotes(
      [
        { mn: `${A}-1`, outcome: 'yes', time: 10 },
        { mn: `${A}-1`, outcome: 'no', time: 20 }, // newer wins
        { mn: `${Z}-2`, outcome: 'abstain', time: 5 },
        { mn: `${'cd'.repeat(32)}-0`, outcome: 'yes', time: 5 }, // not in the weight map: not counted, not hashed
      ],
      weights,
    );
    const counted = [...t.current].filter(([mn]) => weights.has(mn)).map(([mn, v]) => ({ mn, ...v }));
    expect(voteSetPreimage(counted)).toBe(`govhub-voteset-v1\n${Z}-2|3|5\n${A}-1|2|20\n`);
  });
});

describe('countVotes: the one counting rule (tally + voteSetHash over the counted masternodes)', () => {
  const weights = new Map([[`${A}-1`, 1], [`${Z}-2`, 4], [`${'cd'.repeat(32)}-0`, 1]]);
  const votes = [
    { mn: `${A}-1`, outcome: 'yes' as const, time: 10 },
    { mn: `${A}-1`, outcome: 'no' as const, time: 20 }, // newer wins
    { mn: `${Z}-2`, outcome: 'abstain' as const, time: 5 }, // evonode, weight 4
    { mn: `${'ef'.repeat(32)}-0`, outcome: 'yes' as const, time: 5 }, // not in the weight map: neither counted nor hashed
  ];

  it('equals tallyVotes plus the hand-built hash of the counted set', () => {
    const c = countVotes(votes, weights);
    expect(c.weighted).toEqual({ yes: 0, no: 1, abstain: 4 });
    expect(c.unknownMasternodes).toEqual([`${'ef'.repeat(32)}-0`]);
    expect(c.counted).toEqual([{ mn: `${A}-1`, outcome: 2, time: 20n }, { mn: `${Z}-2`, outcome: 3, time: 5n }]);
    const t = tallyVotes(votes, weights);
    expect(c.voteSetHash).toBe(voteSetHash([...t.current].filter(([mn]) => weights.has(mn)).map(([mn, v]) => ({ mn, ...v }))));
    expect(c.voteSetHash).toBe(voteSetHash([{ mn: `${A}-1`, outcome: 2, time: 20 }, { mn: `${Z}-2`, outcome: 3, time: 5 }]));
  });

  it('keeps a voter whose weight is 0 in the set, normalises ids, and is independent of vote order', () => {
    const w = new Map([[`${A.toUpperCase()}-01`, 0]]);
    const c = countVotes([{ mn: `${A}-1`, outcome: 'yes', time: 1 }], w);
    expect(c.counted).toEqual([{ mn: `${A}-1`, outcome: 1, time: 1n }]);
    expect(countVotes([...votes].reverse(), weights).voteSetHash).toBe(countVotes(votes, weights).voteSetHash);
  });

  it('applies the future-time rule before hashing', () => {
    const c = countVotes([{ mn: `${A}-1`, outcome: 'yes', time: 5000 }], weights, { now: 1000 });
    expect(c.rejected).toHaveLength(1);
    expect(c.counted).toEqual([]);
    expect(c.voteSetHash).toBe(voteSetHash([]));
  });
});
