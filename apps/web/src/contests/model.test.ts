import { describe, expect, it } from 'vitest';
import { displayName, isContestedLabel, normalizeLabel, percent, phaseOf, registersAs, toOutcome, type ContestState } from './model.ts';
import { TtlCache } from './source.ts';
import { leadText, statusTag } from './ui.tsx';
import { contestsShown } from './useContests.ts';

const state = (over: Partial<ContestState> = {}): ContestState => {
  const s = { label: 'x', contenders: [], abstain: 0, lock: 0, total: 0, outcome: null, height: null, ...over };
  return { ...s, total: over.total ?? s.contenders.reduce((n, c) => n + c.votes, 0) + s.abstain + s.lock };
};
const A = 'eUJLdV1mRNVYAMdHYV3nSiwKu2EBB1jGfVKUuCDeUE2';
const B = '3Yos9bTgS21oDhEqc99f5Eyvq1axrvznkTLAjhiAXCat';

describe('labels', () => {
  it('normalizes the way DPNS does (o to 0, i and l to 1, lower case, no .dash)', () => {
    expect(normalizeLabel('TheRoadNotTaken')).toBe('ther0adn0ttaken');
    expect(normalizeLabel(' Alpha.DASH ')).toBe('a1pha');
    expect(normalizeLabel('LIL-oil')).toBe('111-011');
  });
  it('knows which labels can be contested', () => {
    expect(isContestedLabel('a1pha')).toBe(true);
    expect(isContestedLabel('ab')).toBe(false);
    expect(isContestedLabel('a'.repeat(20))).toBe(false);
    expect(isContestedLabel('alpha2')).toBe(false); // digits other than 0 and 1 make a name uncontested
    expect(isContestedLabel('Alpha')).toBe(false); // only the normalized form is in the index
  });
  it('shows the leading spelling, and the registered form only when it differs beyond case', () => {
    const s = state({ contenders: [{ identityId: A, votes: 2 }, { identityId: B, votes: 1, requested: 'Satoshi' }] });
    expect(displayName(s, 'sat0sh1')).toBe('Satoshi');
    expect(displayName(state(), 'sat0sh1')).toBe('sat0sh1');
    expect(registersAs('Satoshi', 'sat0sh1')).toBe('sat0sh1');
    expect(registersAs('DashPay', 'dashpay')).toBeNull();
  });
});

describe('outcome and phase', () => {
  it('maps the SDK winner kinds', () => {
    expect(toOutcome('WonByIdentity', A, 5)).toEqual({ kind: 'won', identityId: A, at: 5 });
    expect(toOutcome('Locked', undefined, null)).toEqual({ kind: 'locked', at: null });
    expect(toOutcome('NoWinner', undefined, 1)).toEqual({ kind: 'none', at: 1 });
  });
  it('is open before the end, closing after it, decided with an outcome', () => {
    expect(phaseOf(state(), 2000, 1000)).toBe('open');
    expect(phaseOf(state(), 1000, 1000)).toBe('closing');
    expect(phaseOf(state({ outcome: { kind: 'locked', at: 1 } }), 2000, 1000)).toBe('decided');
    expect(phaseOf(null, null, 1000)).toBe('open');
  });
  it('rounds shares, keeping a small one visible', () => {
    expect(percent(0, 10)).toBe('0%');
    expect(percent(1, 300)).toBe('<1%');
    expect(percent(2, 3)).toBe('67%');
    expect(percent(0, 0)).toBe('0%');
  });
});

describe('card wording', () => {
  it('says who leads while open', () => {
    expect(leadText(state())).toBe('No votes yet');
    expect(leadText(state({ contenders: [{ identityId: A, votes: 6 }], lock: 4 }))).toBe('60% for the only contender');
    expect(leadText(state({ contenders: [{ identityId: A, votes: 3 }], lock: 7 }))).toBe('Lock leads with 70%');
    expect(leadText(state({ contenders: [{ identityId: A, votes: 6 }, { identityId: B, votes: 3 }], abstain: 1 }))).toBe('Leader 60%, next 30%');
    expect(leadText(state({ contenders: [{ identityId: A, votes: 0 }], abstain: 2 }))).toBe('Only abstain votes so far');
  });
  it('says how it ended once decided', () => {
    expect(leadText(state({ contenders: [{ identityId: A, votes: 9 }], abstain: 1, outcome: { kind: 'won', identityId: A, at: 1 } }))).toBe('Won with 90% of the votes');
    expect(leadText(state({ contenders: [{ identityId: A, votes: 1 }], lock: 3, outcome: { kind: 'locked', at: 1 } }))).toBe('Locked by 75% of the votes');
    expect(leadText(state({ contenders: [{ identityId: B, votes: 1 }], outcome: { kind: 'won', identityId: A, at: 1 } }))).toBe('Awarded');
  });
  it('tags the status, urgent under a day', () => {
    const now = 1_000_000_000;
    expect(statusTag(null, now + 3 * 86_400_000, now)).toEqual({ text: 'Closes in 3 days', tone: 'open' });
    expect(statusTag(null, now + 5 * 3_600_000, now)).toEqual({ text: 'Closes in 5 hours', tone: 'soon' });
    expect(statusTag(null, now, now).text).toBe('Voting closed');
    expect(statusTag(state(), null, now).text).toBe('No result yet');
    expect(statusTag(state({ outcome: { kind: 'won', identityId: A, at: 1 } }), null, now)).toEqual({ text: 'Awarded', tone: 'won' });
    expect(statusTag(state({ outcome: { kind: 'locked', at: 1 } }), null, now)).toEqual({ text: 'Locked', tone: 'locked' });
  });
});

describe('gate', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  it('shows contests on testnet Platform, and on mainnet Platform only after ?contests=1', () => {
    const s = store();
    expect(contestsShown({ platformNetwork: 'testnet' }, '', s)).toBe(true);
    expect(contestsShown({ platformNetwork: 'mainnet' }, '', s)).toBe(false);
    expect(contestsShown({ platformNetwork: 'mainnet' }, '?contests=1', s)).toBe(true);
    expect(contestsShown({ platformNetwork: 'mainnet' }, '', s)).toBe(true);
    expect(contestsShown({ platformNetwork: 'mainnet' }, '?contests=0', s)).toBe(false);
    expect(contestsShown({ platformNetwork: 'mainnet' }, '', s)).toBe(false);
  });
});

describe('TtlCache', () => {
  it('shares one read, keeps it for the TTL, and drops failures', async () => {
    let t = 0;
    const c = new TtlCache<number>(100, () => t);
    let calls = 0;
    const load = async () => ++calls;
    await Promise.all([c.get('k', load), c.get('k', load)]);
    expect(calls).toBe(1);
    expect(c.peek('k')).toBe(1);
    t = 150;
    expect(c.peek('k')).toBeUndefined();
    expect(await c.get('k', load)).toBe(2);
    await c.get('bad', async () => Promise.reject(new Error('x'))).catch(() => {});
    await Promise.resolve();
    expect(await c.get('bad', load)).toBe(3);
    c.delete('k');
    expect(c.peek('k')).toBeUndefined();
  });
});
