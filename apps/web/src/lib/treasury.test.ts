import { describe, expect, it } from 'vitest';
import type { Proposal, Tally } from '../data/types.ts';
import { share, treasuryView } from './treasury.ts';
import type { Row } from './view.ts';

const prov = { kind: 'proof', source: 'test' } as const;
function row(name: string, amount: number, o: { inBudget?: boolean; passing?: boolean; votes?: boolean; later?: boolean; lameDuck?: boolean } = {}): Row {
  const p = { govHash: name, name, paymentAmount: amount * 1e8 } as Proposal;
  const tally = o.votes === false ? null : { value: { inNextBudget: !!o.inBudget } as Tally, prov };
  return {
    p: { value: p, prov },
    tally,
    platformTally: tally,
    bridgeTally: null,
    absYes: null,
    threshold: null,
    state: tally ? { passing: !!(o.passing ?? o.inBudget), margin: 0, needed: 0, light: 'pass' } : null,
    schedule: null,
    lameDuck: !!o.lameDuck,
    startsLater: o.later ? ({ firstEpoch: 0 } as unknown as Row['startsLater']) : null,
    content: { ok: true },
  } as Row;
}

describe('treasuryView', () => {
  const rows = [
    row('italia', 60, { inBudget: true }),
    row('dcg', 4832, { inBudget: true }),
    row('growth', 200, { passing: true }),
    row('apac', 61),
    row('new', 14, { votes: false }),
    row('rules', 1, { inBudget: true, later: true }),
    row('done', 500, { inBudget: true, lameDuck: true }),
  ];
  const v = treasuryView(rows);

  it('groups by where each stands, largest first, leaving out what no superblock can pay', () => {
    expect(v.groups.funded.rows.map((r) => r.p.value.name)).toEqual(['dcg', 'italia']);
    expect(v.groups.over.rows.map((r) => r.p.value.name)).toEqual(['growth']);
    expect(v.groups.short.rows.map((r) => r.p.value.name)).toEqual(['apac', 'new']);
    expect(v.groups.later.rows.map((r) => r.p.value.name)).toEqual(['rules']); // passing, but not up for this superblock
    expect(Object.values(v.groups).flatMap((g) => g.rows).some((r) => r.p.value.name === 'done')).toBe(false);
  });

  it('adds up what this superblock is asked for, and what has the votes', () => {
    expect(v.groups.funded.sum).toBe(4892e8);
    expect(v.requested).toBe((4832 + 60 + 200 + 61 + 14) * 1e8);
    expect(v.passing).toBe((4832 + 60 + 200) * 1e8);
  });
});

describe('treasuryView with votes that weren’t read', () => {
  it('groups those apart, still counts what they ask, and never as short of votes', () => {
    const v = treasuryView([row('dcg', 4832, { inBudget: true }), row('apac', 61, { votes: false }), row('new', 14, { votes: false })], new Set(['apac']));
    expect(v.groups.unread.rows.map((r) => r.p.value.name)).toEqual(['apac']);
    expect(v.groups.short.rows.map((r) => r.p.value.name)).toEqual(['new']); // read, and no tally published: no votes yet
    expect(v.requested).toBe((4832 + 61 + 14) * 1e8);
    expect(v.passing).toBe(4832e8);
  });
});

describe('share', () => {
  it('rounds to whole percent, and never calls a sliver nothing', () => {
    expect(share(4832, 6828)).toBe('71%');
    expect(share(1, 6828)).toBe('<1%');
    expect(share(0, 6828)).toBe('0%');
    expect(share(1, 0)).toBe('–');
    expect(share(6820, 6828)).toBe('>99%');
    expect(share(6828, 6828)).toBe('100%');
    expect(share(6830, 6828)).toBe('>100%');
    expect(share(8151, 6828)).toBe('119%');
  });
});
