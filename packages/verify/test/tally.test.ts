import { describe, expect, it } from 'vitest';
import { EVONODE_WEIGHT, REGULAR_MN_WEIGHT, tallyVotes } from '../src/index.ts';

const w = new Map([
  ['a', REGULAR_MN_WEIGHT],
  ['b', REGULAR_MN_WEIGHT],
  ['c', EVONODE_WEIGHT],
  ['d', EVONODE_WEIGHT],
]);

describe('tallyVotes', () => {
  it('weights evonodes x4 and counts unweighted too', () => {
    const t = tallyVotes(
      [
        { mn: 'a', outcome: 'yes', time: 1 },
        { mn: 'b', outcome: 'no', time: 1 },
        { mn: 'c', outcome: 'yes', time: 1 },
        { mn: 'd', outcome: 'abstain', time: 1 },
      ],
      w,
    );
    expect(t.weighted).toEqual({ yes: 5, no: 1, abstain: 4 });
    expect(t.unweighted).toEqual({ yes: 2, no: 1, abstain: 1 });
    expect(t.absoluteYes).toBe(4);
  });

  it('latest vote per masternode wins regardless of input order', () => {
    const votes = [
      { mn: 'a', outcome: 1, time: 10 },
      { mn: 'a', outcome: 2, time: 20 },
      { mn: 'a', outcome: 3, time: 15 },
    ];
    for (const order of [votes, [...votes].reverse(), [votes[1]!, votes[0]!, votes[2]!]]) {
      const t = tallyVotes(order, w);
      expect(t.weighted).toEqual({ yes: 0, no: 1, abstain: 0 });
    }
  });

  it('equal timestamps: the higher outcome value wins (Core ProcessVote), order independent', () => {
    const votes = [
      { mn: 'a', outcome: 'yes' as const, time: 5 },
      { mn: 'a', outcome: 'no' as const, time: 5 },
    ];
    expect(tallyVotes(votes, w).weighted).toEqual({ yes: 0, no: 1, abstain: 0 });
    expect(tallyVotes([...votes].reverse(), w).weighted).toEqual({ yes: 0, no: 1, abstain: 0 });
  });

  it('unknown masternodes are listed, not counted; ids are case-insensitive; accepts a Record', () => {
    const t = tallyVotes(
      [
        { mn: 'A', outcome: 'yes', time: 1 },
        { mn: 'zz', outcome: 'yes', time: 1 },
      ],
      { a: 1 },
    );
    expect(t.weighted.yes).toBe(1);
    expect(t.unknownMasternodes).toEqual(['zz']);
  });

  it('a later "none" vote supersedes a yes but counts nowhere; bad outcomes throw', () => {
    const t = tallyVotes(
      [
        { mn: 'a', outcome: 'yes', time: 1 },
        { mn: 'a', outcome: 'none', time: 2 },
      ],
      w,
    );
    expect(t.weighted).toEqual({ yes: 0, no: 0, abstain: 0 });
    expect(() => tallyVotes([{ mn: 'a', outcome: 7, time: 1 }], w)).toThrow();
  });

  it('supports bigint times and empty input', () => {
    expect(tallyVotes([{ mn: 'a', outcome: 'yes', time: 2n ** 40n }], w).weighted.yes).toBe(1);
    expect(tallyVotes([], w).absoluteYes).toBe(0);
  });
});

describe('tallyVotes hardening (review)', () => {
  const txid = 'ab'.repeat(32);
  it('rejects bad weights and conflicting duplicate weights', () => {
    expect(() => tallyVotes([], { a: 1000 })).toThrow(/invalid masternode weight/);
    expect(() => tallyVotes([], { a: 2 })).toThrow();
    expect(() => tallyVotes([], new Map([['A', 1], ['a', 4]]))).toThrow(/conflicting/);
    expect(() => tallyVotes([], { a: 0 })).not.toThrow();
  });
  it('drops negative-time votes always, and far-future votes when now is given', () => {
    const votes = [
      { mn: 'a', outcome: 'yes' as const, time: 100 },
      { mn: 'a', outcome: 'no' as const, time: 10 ** 15 },
      { mn: 'b', outcome: 'yes' as const, time: -1 },
    ];
    const noNow = tallyVotes(votes, w);
    expect(noNow.rejected.map((r) => r.reason)).toEqual(['negative-time']);
    expect(noNow.weighted).toEqual({ yes: 0, no: 1, abstain: 0 }); // without `now` the future vote wins - callers must pass now
    const t = tallyVotes(votes, w, { now: 1000 });
    expect(t.weighted).toEqual({ yes: 1, no: 0, abstain: 0 });
    expect(t.rejected.map((r) => r.reason).sort()).toEqual(['future-time', 'negative-time']);
    // exactly now + 3600 is accepted (Core: Time() > max_time is rejected)
    expect(tallyVotes([{ mn: 'a', outcome: 'yes', time: 4600 }], w, { now: 1000 }).weighted.yes).toBe(1);
    expect(tallyVotes([{ mn: 'a', outcome: 'yes', time: 4601 }], w, { now: 1000 }).weighted.yes).toBe(0);
  });
  it('outpoint ids are normalised (case, leading zeros) so one masternode is never counted twice', () => {
    const t = tallyVotes(
      [
        { mn: `${txid.toUpperCase()}-01`, outcome: 'yes', time: 1 },
        { mn: `${txid}-1`, outcome: 'yes', time: 2 },
      ],
      { [`${txid}-1`]: 4 },
    );
    expect(t.weighted.yes).toBe(4);
    expect(t.unweighted.yes).toBe(1);
  });
});
