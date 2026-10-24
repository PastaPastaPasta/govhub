import { describe, expect, it } from 'vitest';
import { GOV_PARAMS, FUDGE_WINDOW_S, fundingThreshold, passState, paymentSchedule, rankProposals, selectBudget, superblockTime, votingDeadlineTime } from './governance.ts';

const M = GOV_PARAMS.mainnet;
const PERIOD = M.superblockCycle * M.blockSeconds; // ~30.2 days

describe('fundingThreshold (governance.cpp:1209)', () => {
  it('is 10% of weighted valid MNs, integer division, floored at the min quorum', () => {
    expect(fundingThreshold(3320, M)).toBe(332);
    expect(fundingThreshold(3329, M)).toBe(332); // getgovernanceinfo said 332 on 2026-10-23
    expect(fundingThreshold(3330, M)).toBe(333);
    expect(fundingThreshold(50, M)).toBe(10);
    expect(fundingThreshold(5, GOV_PARAMS.testnet)).toBe(1);
  });
});

describe('passState', () => {
  it('passes at exactly the threshold (object.cpp:991 uses >=)', () => {
    expect(passState(332, 332, true)).toEqual({ passing: true, margin: 0, needed: 0, light: 'pass' });
  });
  it('reports how many more yes votes are needed', () => {
    const s = passState(212, 332, undefined);
    expect(s.passing).toBe(false);
    expect(s.needed).toBe(120);
    expect(s.light).toBe('fail');
  });
  it('is amber when passing but not in the budget, or within 10% of the threshold', () => {
    expect(passState(400, 332, false).light).toBe('warn');
    expect(passState(332 - 34, 332, undefined).light).toBe('warn');
    expect(passState(332 - 35, 332, undefined).light).toBe('fail');
  });
});

describe('superblock timing', () => {
  const cycle = { estTime: 1_795_179_000, superblockHeight: 2_575_480, votingDeadlineHeight: 2_575_480 - 1662 };
  it('steps by one cycle of 2.62-minute blocks', () => {
    expect(superblockTime(cycle, 1, M) - superblockTime(cycle, 0, M)).toBe(Math.round(PERIOD));
  });
  it('voting deadline is the maturity window before the superblock', () => {
    expect(cycle.estTime - votingDeadlineTime(cycle, M)).toBe(Math.round(1662 * M.blockSeconds));
  });
});

describe('paymentSchedule', () => {
  const cycle = { estTime: 2_000_000_000 };
  const now = cycle.estTime - 5 * 86400;
  it('one-time proposal covering just the next superblock', () => {
    const s = paymentSchedule({ startEpoch: cycle.estTime - 86400, endEpoch: cycle.estTime + 86400 }, cycle, M, now);
    expect(s).toEqual({ total: 1, remaining: 1, oneTime: true });
  });
  it('three-month proposal that started one superblock ago', () => {
    const start = cycle.estTime - PERIOD - 86400;
    const s = paymentSchedule({ startEpoch: start, endEpoch: start + 3 * PERIOD }, cycle, M, now);
    expect(s.total).toBe(3);
    expect(s.remaining).toBe(2);
    expect(s.oneTime).toBe(false);
  });
  it('honours the 2 h fudge window on both ends', () => {
    const s = paymentSchedule({ startEpoch: cycle.estTime + FUDGE_WINDOW_S, endEpoch: cycle.estTime + 86400 }, cycle, M, now);
    expect(s.total).toBe(1);
    const t = paymentSchedule({ startEpoch: cycle.estTime + FUDGE_WINDOW_S + 1, endEpoch: cycle.estTime + 86400 }, cycle, M, now);
    expect(t.total).toBe(0);
  });
  it('ended proposals have nothing remaining', () => {
    const s = paymentSchedule({ startEpoch: cycle.estTime - 3 * PERIOD, endEpoch: cycle.estTime - PERIOD / 2 }, cycle, M, now);
    expect(s.remaining).toBe(0);
    expect(s.total).toBe(3);
  });
});

describe('ranking and budget fill (signing.cpp:62-100)', () => {
  const sb = 2_000_000_000;
  const e = (govHash: string, absYes: number, dash: number, start = sb - 86400, end = sb + 86400) => ({ govHash, absYes, amount: dash * 1e8, startEpoch: start, endEpoch: end });
  it('orders by absolute yes, then by hash descending', () => {
    const r = rankProposals([e('00aa', 10, 1), e('ff00', 10, 1), e('0b00', 50, 1)]);
    expect(r.map((x) => x.govHash)).toEqual(['0b00', 'ff00', '00aa']);
  });
  it('skips what does not fit and keeps filling with smaller proposals', () => {
    const sel = selectBudget([e('a1', 900, 600), e('a2', 800, 500), e('a3', 700, 300), e('a4', 100, 1)], 1000e8, 332, sb);
    expect([...sel.funded]).toEqual(['a1', 'a3']);
    expect(sel.allocated).toBe(900e8);
    expect(sel.ranked).toEqual(['a1', 'a2', 'a3']);
  });
  it('skips proposals whose window does not include the superblock', () => {
    const sel = selectBudget([e('b1', 900, 10, sb + 3 * 3600, sb + 9e6)], 1000e8, 332, sb);
    expect(sel.funded.size).toBe(0);
  });
});
