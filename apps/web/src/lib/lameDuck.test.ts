import { describe, expect, it } from 'vitest';
import type { Cycle, Proposal, Sourced, Tally } from '../data/types.ts';
import { FUDGE_WINDOW_S, GOV_PARAMS, paymentSchedule } from './governance.ts';
import { isLameDuck } from './lameDuck.ts';
import { budgetView, deriveRow } from './view.ts';

const prov = { kind: 'proof', source: 'test' } as const;
const DAY = 86400;
const MAIN = GOV_PARAMS.mainnet;
const TEST = GOV_PARAMS.testnet;
const mainPeriod = MAIN.superblockCycle * MAIN.blockSeconds; // ~30.2 days
const testPeriod = TEST.superblockCycle * TEST.blockSeconds; // ~63 minutes

const proposal = (govHash: string, over: Partial<Proposal> = {}): Sourced<Proposal> => ({
  value: { govHash, parentHash: '0'.repeat(64), revision: 1, time: 0, dataHex: '', name: govHash, url: '', paymentAddress: 'X', paymentAmount: 100e8, startEpoch: 0, endEpoch: 2e9, collateralTxid: '', collateralHeight: 0, ...over },
  prov,
});
const tally = (govHash: string, over: Partial<Tally> = {}): Sourced<Tally> => ({
  value: { govHash, asOfHeight: 100, yesWeighted: 400, noWeighted: 20, abstainWeighted: 0, yesCount: 300, noCount: 20, abstainCount: 0, voteSetHash: '', rank: 1, inNextBudget: false, margin: 0, ...over },
  prov,
});
const cycleAt = (estTime: number, allocated = 0): Sourced<Cycle> => ({ value: { superblockHeight: 1, budget: 6000e8, allocated, votingDeadlineHeight: 0, estTime, validWeighted: 3320, paid: 0 }, prov });

// pshenmic-dev-dash-desktop-november-2026 on 2026-10-25: one payment of 100 DASH, runs Sep 29 to Oct 27, paid in the superblock a week ago.
const NOW = Date.UTC(2026, 9, 25) / 1000;
const SEP29 = Date.UTC(2026, 8, 29) / 1000;
const OCT27 = Date.UTC(2026, 9, 27) / 1000;

describe('isLameDuck', () => {
  it('fully paid: its one superblock is behind us and the next is after it ends (the pshenmic proposal)', () => {
    const next = NOW + 23 * DAY; // the previous superblock was ~7 days ago, inside Sep 29..Oct 27
    const p = proposal('a', { startEpoch: SEP29, endEpoch: OCT27 });
    const sched = paymentSchedule(p.value, cycleAt(next).value, MAIN, NOW);
    expect(sched).toEqual({ total: 1, remaining: 0, oneTime: true });
    expect(isLameDuck(p.value, sched.remaining, NOW)).toBe(true);
    expect(deriveRow(p, new Map([['a', tally('a')]]), new Map(), cycleAt(next), MAIN, NOW).lameDuck).toBe(true);
  });

  it('the next superblock falls after end_epoch + 2 h and none was in its window: nothing could ever pay it', () => {
    const p = proposal('a', { startEpoch: NOW - DAY, endEpoch: NOW + 2 * DAY });
    const cycle = cycleAt(NOW + 10 * DAY); // the previous superblock was ~20 days ago, before it started
    const sched = paymentSchedule(p.value, cycle.value, MAIN, NOW);
    expect(sched).toMatchObject({ total: 0, remaining: 0 });
    expect(deriveRow(p, new Map(), new Map(), cycle, MAIN, NOW).lameDuck).toBe(true);
  });

  it("uses Core's inclusive window: a superblock at end_epoch + 2 h can pay, one second later cannot (signing.cpp:94)", () => {
    const end = NOW + 3 * DAY;
    const p = proposal('a', { startEpoch: NOW - 10 * DAY, endEpoch: end });
    const at = (t: number) => deriveRow(p, new Map(), new Map(), cycleAt(t), MAIN, NOW);
    expect(at(end + FUDGE_WINDOW_S).lameDuck).toBe(false);
    expect(at(end + FUDGE_WINDOW_S).schedule?.remaining).toBe(1);
    expect(at(end + FUDGE_WINDOW_S + 1).lameDuck).toBe(true);
  });

  it('partly paid with payments left is not a lame duck', () => {
    // a 90-day proposal that started 40 days ago: one superblock behind it, the next one is inside the window
    const p = proposal('a', { startEpoch: NOW - 40 * DAY, endEpoch: NOW + 50 * DAY });
    const cycle = cycleAt(NOW + 5 * DAY);
    const sched = paymentSchedule(p.value, cycle.value, MAIN, NOW);
    expect(sched.total).toBeGreaterThanOrEqual(2);
    expect(sched.remaining).toBeGreaterThanOrEqual(1);
    expect(deriveRow(p, new Map(), new Map(), cycle, MAIN, NOW).lameDuck).toBe(false);
    // down to its last payment: still not (that payment is yet to come)
    const last = proposal('b', { startEpoch: NOW - 40 * DAY, endEpoch: NOW + 6 * DAY });
    expect(deriveRow(last, new Map(), new Map(), cycle, MAIN, NOW)).toMatchObject({ lameDuck: false, schedule: { remaining: 1 } });
    // the superblock one cycle later falls after end + 2 h, so it is the last: still to come a second ahead of it, and lame once it has passed
    const afterLast = cycleAt(NOW + 5 * DAY + mainPeriod);
    expect(deriveRow(last, new Map(), new Map(), afterLast, MAIN, NOW + 5 * DAY - 1).lameDuck).toBe(false);
    expect(deriveRow(last, new Map(), new Map(), afterLast, MAIN, NOW + 5 * DAY + 1).lameDuck).toBe(true);
  });

  it('is only for proposals still in the active set, and only when the schedule is known', () => {
    expect(isLameDuck({ endEpoch: NOW - 1 }, 0, NOW)).toBe(false);
    expect(isLameDuck({ endEpoch: NOW }, 0, NOW)).toBe(false); // Core: expired once end_epoch <= now (object.cpp:148)
    expect(isLameDuck({ endEpoch: NOW + 1 }, 0, NOW)).toBe(true);
    expect(isLameDuck({ endEpoch: NOW + DAY }, null, NOW)).toBe(false);
    expect(deriveRow(proposal('a', { startEpoch: NOW - 9 * DAY, endEpoch: NOW + DAY }), new Map(), new Map(), null, MAIN, NOW).lameDuck).toBe(false);
  });

  it('a proposal the next superblock is flagged to pay is never a lame duck, whatever the estimate says', () => {
    const p = proposal('a', { startEpoch: SEP29, endEpoch: OCT27 });
    const cycle = cycleAt(NOW + 23 * DAY);
    expect(deriveRow(p, new Map([['a', tally('a', { inNextBudget: true })]]), new Map(), cycle, MAIN, NOW).lameDuck).toBe(false);
    expect(isLameDuck(p.value, 0, NOW, true)).toBe(false);
  });

  it('testnet hourly cycle: the 2 h fudge is longer than the cycle, so an active proposal always has a superblock ahead', () => {
    const p = proposal('a', { startEpoch: NOW - 6 * 3600, endEpoch: NOW + 20 * 60 });
    // next superblock in 10 minutes: this one and the next two (~73 and ~136 minutes) are all inside end + 2 h
    const live = deriveRow(p, new Map(), new Map(), cycleAt(NOW + 600), TEST, NOW);
    expect(live.schedule!.remaining).toBe(3);
    expect(live.lameDuck).toBe(false);
    // wherever the next superblock falls within the cycle, and however close the end, it can still pay
    for (let offset = 1; offset <= testPeriod; offset += 97) {
      for (const left of [1, 60, 20 * 60, 6 * 3600]) {
        const q = proposal('q', { startEpoch: NOW - 6 * 3600, endEpoch: NOW + left });
        expect(deriveRow(q, new Map(), new Map(), cycleAt(NOW + offset), TEST, NOW).lameDuck).toBe(false);
      }
    }
    // the same proposal under mainnet rules has no superblock in its window: the parameters must follow the data's network
    expect(deriveRow(p, new Map(), new Map(), cycleAt(NOW + 3 * 3600), MAIN, NOW).lameDuck).toBe(true);
  });

  it('testnet with a longer cycle: lame once its last superblock has passed', () => {
    // a custom 6-hour cycle (a bridge may report any cycle): end + 2 h is shorter than the cycle
    const params = { ...TEST, superblockCycle: Math.round((6 * 3600) / TEST.blockSeconds) };
    const p = proposal('a', { startEpoch: NOW - 12 * 3600, endEpoch: NOW + 3600 });
    expect(deriveRow(p, new Map(), new Map(), cycleAt(NOW + 3 * 3600), params, NOW).lameDuck).toBe(false);
    expect(deriveRow(p, new Map(), new Map(), cycleAt(NOW + 4 * 3600), params, NOW).lameDuck).toBe(true);
  });
});

describe('budgetView with lame ducks', () => {
  it('leaves them out of the active count and the next budget; Allocated is still the cycle document', () => {
    const cycle = cycleAt(NOW + 23 * DAY, 250e8);
    const live = proposal('live', { startEpoch: NOW - 2 * DAY, endEpoch: NOW + 40 * DAY, paymentAmount: 250e8 });
    const ducked = proposal('duck', { startEpoch: SEP29, endEpoch: OCT27 });
    const tallies = new Map([
      ['live', tally('live', { inNextBudget: true })],
      ['duck', tally('duck')],
    ]);
    const rows = [live, ducked].map((p) => deriveRow(p, tallies, new Map(), cycle, MAIN, NOW));
    expect(rows.map((r) => r.lameDuck)).toEqual([false, true]);
    // even handed every row, as a caller that forgot to split them would
    expect(budgetView(rows, cycle.value)).toMatchObject({ active: 1, fundedSum: 250e8, allocated: 250e8 });
    expect(budgetView(rows, cycle.value).funded.map((r) => r.p.value.govHash)).toEqual(['live']);
  });
});
