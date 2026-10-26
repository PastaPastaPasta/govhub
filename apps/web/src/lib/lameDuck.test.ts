import { describe, expect, it } from 'vitest';
import type { Cycle, Proposal, Sourced, Tally } from '../data/types.ts';
import { FUDGE_WINDOW_S, GOV_PARAMS, paymentSchedule, type GovParams } from './governance.ts';
import { isLameDuck, LAME_DUCK_SLACK_S, startsLater } from './lameDuck.ts';
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

// a row with no tallies
const bare = (p: Sourced<Proposal>, cycle: Sourced<Cycle> | null, params: GovParams, now = NOW) => deriveRow(p, new Map(), new Map(), cycle, params, now);

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
    expect(bare(p, cycle, MAIN, NOW).lameDuck).toBe(true);
  });

  it("uses Core's inclusive window, plus a day of slack for the estimate (signing.cpp:94)", () => {
    const end = NOW + 3 * DAY;
    const p = proposal('a', { startEpoch: NOW - 10 * DAY, endEpoch: end });
    const at = (t: number) => bare(p, cycleAt(t), MAIN, NOW);
    // at end + 2 h Core still pays it (inclusive); just after, only the estimate's drift could
    expect(at(end + FUDGE_WINDOW_S).schedule?.remaining).toBe(1);
    expect(at(end + FUDGE_WINDOW_S + 1).schedule?.remaining).toBe(0);
    expect(at(end + FUDGE_WINDOW_S).lameDuck).toBe(false);
    expect(at(end + FUDGE_WINDOW_S + 1).lameDuck).toBe(false);
    expect(at(end + FUDGE_WINDOW_S + LAME_DUCK_SLACK_S).lameDuck).toBe(false);
    expect(at(end + FUDGE_WINDOW_S + LAME_DUCK_SLACK_S + 1).lameDuck).toBe(true);
  });

  it('the same slack at the start, for a proposal that has not begun', () => {
    const start = NOW + 3 * DAY;
    const p = proposal('a', { startEpoch: start, endEpoch: start + 5 * DAY });
    // the superblock after the next is a cycle later, past its end: only the next one can pay it
    const lame = (est: number) => bare(p, cycleAt(est), MAIN, NOW).lameDuck;
    expect(lame(start - FUDGE_WINDOW_S - 100)).toBe(false); // just before the window opens: the estimate's drift could bring it in
    expect(lame(start - FUDGE_WINDOW_S - LAME_DUCK_SLACK_S - 1)).toBe(true); // well before it, and the one after is far past the end
  });

  it('partly paid with payments left is not a lame duck', () => {
    // a 90-day proposal that started 40 days ago: one superblock behind it, the next one is inside the window
    const p = proposal('a', { startEpoch: NOW - 40 * DAY, endEpoch: NOW + 50 * DAY });
    const cycle = cycleAt(NOW + 5 * DAY);
    const sched = paymentSchedule(p.value, cycle.value, MAIN, NOW);
    expect(sched.total).toBeGreaterThanOrEqual(2);
    expect(sched.remaining).toBeGreaterThanOrEqual(1);
    expect(bare(p, cycle, MAIN, NOW).lameDuck).toBe(false);
    // down to its last payment: still not (that payment is yet to come)
    const last = proposal('b', { startEpoch: NOW - 40 * DAY, endEpoch: NOW + 6 * DAY });
    expect(bare(last, cycle, MAIN, NOW)).toMatchObject({ lameDuck: false, schedule: { remaining: 1 } });
    // the superblock one cycle later falls after end + 2 h, so it is the last: still to come a second ahead of it, and lame once it has passed
    const afterLast = cycleAt(NOW + 5 * DAY + mainPeriod);
    expect(bare(last, afterLast, MAIN, NOW + 5 * DAY - 1).lameDuck).toBe(false);
    expect(bare(last, afterLast, MAIN, NOW + 5 * DAY + 1).lameDuck).toBe(true);
  });

  it('is only for proposals still in the active set, and only when the schedule is known', () => {
    expect(isLameDuck({ endEpoch: NOW - 1 }, 0, NOW)).toBe(false);
    expect(isLameDuck({ endEpoch: NOW }, 0, NOW)).toBe(false); // Core: expired once end_epoch <= now (object.cpp:148)
    expect(isLameDuck({ endEpoch: NOW + 1 }, 0, NOW)).toBe(true);
    expect(isLameDuck({ endEpoch: NOW + DAY }, null, NOW)).toBe(false);
    expect(bare(proposal('a', { startEpoch: NOW - 9 * DAY, endEpoch: NOW + DAY }), null, MAIN, NOW).lameDuck).toBe(false);
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
    const live = bare(p, cycleAt(NOW + 600), TEST, NOW);
    expect(live.schedule!.remaining).toBe(3);
    expect(live.lameDuck).toBe(false);
    // wherever the next superblock falls within the cycle, and however close the end, it can still pay
    for (let offset = 1; offset <= testPeriod; offset += 97) {
      for (const left of [1, 60, 20 * 60, 6 * 3600]) {
        const q = proposal('q', { startEpoch: NOW - 6 * 3600, endEpoch: NOW + left });
        expect(bare(q, cycleAt(NOW + offset), TEST, NOW).lameDuck).toBe(false);
      }
    }
    // the same proposal under mainnet rules has no superblock in its window: the parameters must follow the data's network
    expect(bare(p, cycleAt(NOW + 3 * DAY), MAIN, NOW).lameDuck).toBe(true);
  });

  it('a custom 3-day cycle (a bridge may report any): lame once the next superblock is past end + 2 h + the slack', () => {
    const params = { ...TEST, superblockCycle: Math.round((3 * DAY) / TEST.blockSeconds) };
    const p = proposal('a', { startEpoch: NOW - 12 * 3600, endEpoch: NOW + 3600 });
    expect(bare(p, cycleAt(NOW + 20 * 3600), params, NOW).lameDuck).toBe(false);
    expect(bare(p, cycleAt(NOW + 2 * DAY), params, NOW).lameDuck).toBe(true);
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

describe('startsLater', () => {
  // Dash-Pay-name-registration-rules on mainnet: 1 DASH, starts Jan 3 2027 and ends Feb 1 2027; the next superblock (2,575,480) is ~Nov 20 2026
  const NEXT = Date.UTC(2026, 10, 20, 12) / 1000;
  const JAN3 = 1798946946;
  const FEB1 = 1801522426;
  const dash = (over: Partial<Proposal> = {}) => proposal('dpn', { startEpoch: JAN3, endEpoch: FEB1, paymentAmount: 1e8, ...over });

  it('its first payment is a later superblock: Jan 19 (the third), not the Nov 20 or Dec 20 ones', () => {
    const cycle = cycleAt(NEXT);
    const later = startsLater(dash().value, cycle.value, MAIN, NOW);
    expect(later).toEqual({ firstTime: Math.round(NEXT + 2 * mainPeriod), nextTime: NEXT });
    expect(new Date(later!.firstTime * 1000).toISOString().slice(0, 7)).toBe('2027-01');
    expect(paymentSchedule(dash().value, cycle.value, MAIN, NOW)).toEqual({ total: 1, remaining: 1, oneTime: true });
    // the schedule's own count agrees: one payment ahead, so it is not a lame duck
    const row = deriveRow(dash(), new Map([['dpn', tally('dpn', { yesWeighted: 348, noWeighted: 332 })]]), new Map(), cycle, MAIN, NOW);
    expect(row).toMatchObject({ lameDuck: false, startsLater: { nextTime: NEXT } });
  });

  it('is judged by votes alone: passing is not a warning, and a bridge flag does not change what the schedule says', () => {
    const cycle = cycleAt(NEXT);
    // 3320 weighted valid -> threshold 332; 348 net yes passes by 16 (the card read "Passing by 16", yellow, "Not in the next budget")
    const row = (over: Partial<Tally>) => deriveRow(dash(), new Map([['dpn', tally('dpn', { yesWeighted: 348, noWeighted: 0, ...over })]]), new Map(), cycle, MAIN, NOW);
    expect(row({ inNextBudget: false }).state).toMatchObject({ passing: true, margin: 16, light: 'pass' });
    expect(row({ inNextBudget: true })).toMatchObject({ startsLater: { nextTime: NEXT }, state: { passing: true, light: 'pass' } });
    expect(row({ yesWeighted: 100 }).state).toMatchObject({ passing: false, light: 'fail' });
    // a due proposal that is passing and not in the budget is still the warning
    const due = deriveRow(proposal('d', { startEpoch: NOW - DAY, endEpoch: NOW + 90 * DAY }), new Map([['d', tally('d', { yesWeighted: 348, noWeighted: 0 })]]), new Map(), cycle, MAIN, NOW);
    expect(due).toMatchObject({ startsLater: null, state: { light: 'warn' } });
  });

  it('starts now: a window that holds the next superblock is not later (start before it, or within the slack)', () => {
    const cycle = cycleAt(NEXT).value;
    const at = (start: number, end: number) => startsLater({ startEpoch: start, endEpoch: end }, cycle, MAIN, NOW);
    expect(at(NOW - 5 * DAY, NEXT + 30 * DAY)).toBeNull();
    expect(at(NEXT - FUDGE_WINDOW_S, NEXT + 9 * DAY)).toBeNull(); // Core's own inclusive start edge
    expect(at(NEXT + 3600, NEXT + 9 * DAY)).toBeNull(); // starts an hour after the estimate: drift could bring it in
    expect(at(NEXT + FUDGE_WINDOW_S + LAME_DUCK_SLACK_S, NEXT + 9 * DAY)).toBeNull(); // the slack's edge
    expect(at(NEXT + FUDGE_WINDOW_S + LAME_DUCK_SLACK_S + 1, NEXT + 9 * DAY)).toBeNull(); // no superblock in its window at all: lame, not later
    expect(at(NEXT + FUDGE_WINDOW_S + LAME_DUCK_SLACK_S + 1, NEXT + mainPeriod + DAY)).toEqual({ firstTime: Math.round(NEXT + mainPeriod), nextTime: NEXT });
  });

  it("a proposal only the slack lets in (nothing in Core's own window) is borderline, not \"starts later\"", () => {
    const cycle = cycleAt(NEXT).value;
    // ends 14 h before the superblock after the next one: Core's window holds none, one day of slack reaches it
    const end = NEXT + mainPeriod - 14 * 3600;
    expect(paymentSchedule({ startEpoch: NEXT + 5 * DAY, endEpoch: end }, cycle, MAIN, NOW).total).toBe(0);
    expect(startsLater({ startEpoch: NEXT + 5 * DAY, endEpoch: end }, cycle, MAIN, NOW)).toBeNull();
  });

  it('an overdue cycle (its superblock is estimated a few hours ago, not yet mined) still has that superblock as the next one', () => {
    const cycle = cycleAt(NOW - 3 * 3600).value;
    // starts 10 days on: later than the unmined superblock, so it is "later" and the budget it misses is that one
    const p = { startEpoch: NOW + 10 * DAY, endEpoch: NOW + 40 * DAY };
    expect(startsLater(p, cycle, MAIN, NOW)).toMatchObject({ nextTime: NOW - 3 * 3600 });
    // a cycle document more than a day stale is not trusted for that: the next superblock is the next one by the clock
    const far = { startEpoch: NOW + 35 * DAY, endEpoch: NOW + 60 * DAY };
    expect(startsLater(far, cycleAt(NOW - 2 * DAY).value, MAIN, NOW)?.nextTime).toBe(Math.round(NOW - 2 * DAY + mainPeriod));
    // and a proposal the unmined superblock could still pay is not "later"
    expect(startsLater({ startEpoch: NOW - DAY, endEpoch: NOW + 40 * DAY }, cycle, MAIN, NOW)).toBeNull();
  });

  it('one superblock later already counts, and a long window that opens later still starts at its first superblock', () => {
    const cycle = cycleAt(NEXT).value;
    const later = startsLater({ startEpoch: NEXT + 2 * DAY, endEpoch: NEXT + 100 * DAY }, cycle, MAIN, NOW);
    expect(later).toEqual({ firstTime: Math.round(NEXT + mainPeriod), nextTime: NEXT });
  });

  it('lame ducks are unchanged: ended, finished or window-less proposals are never "starts later"', () => {
    const next = NOW + 23 * DAY;
    const paid = proposal('a', { startEpoch: SEP29, endEpoch: OCT27 });
    expect(deriveRow(paid, new Map(), new Map(), cycleAt(next), MAIN, NOW)).toMatchObject({ lameDuck: true, startsLater: null });
    const windowless = proposal('b', { startEpoch: NOW - DAY, endEpoch: NOW + 2 * DAY });
    expect(deriveRow(windowless, new Map(), new Map(), cycleAt(NOW + 10 * DAY), MAIN, NOW)).toMatchObject({ lameDuck: true, startsLater: null });
    expect(startsLater({ startEpoch: NOW - 9 * DAY, endEpoch: NOW - 1 }, cycleAt(NEXT).value, MAIN, NOW)).toBeNull();
    // the schedule is unknown without a cycle
    expect(deriveRow(dash(), new Map(), new Map(), null, MAIN, NOW).startsLater).toBeNull();
  });

  it('never lame and later at once, whatever the cycle estimate', () => {
    for (let off = 1; off < 100; off += 3) {
      const cycle = cycleAt(NOW + off * DAY);
      const row = deriveRow(dash(), new Map(), new Map(), cycle, MAIN, NOW);
      expect(row.lameDuck && !!row.startsLater, `offset ${off}d`).toBe(false);
    }
  });

  it('testnet hourly: a proposal starting in a day or more is later; one starting within the day is not', () => {
    const cycle = cycleAt(NOW + 600).value;
    expect(startsLater({ startEpoch: NOW + 3 * 3600, endEpoch: NOW + 9 * 3600 }, cycle, TEST, NOW)).toBeNull();
    expect(startsLater({ startEpoch: NOW + 20 * 3600, endEpoch: NOW + 30 * 3600 }, cycle, TEST, NOW)).toBeNull(); // within the slack (a day)
    const later = startsLater({ startEpoch: NOW + 3 * DAY, endEpoch: NOW + 3 * DAY + 6 * 3600 }, cycle, TEST, NOW);
    expect(later?.nextTime).toBe(NOW + 600);
    // the first superblock inside Core's own window (start - 2 h .. end + 2 h), not the one the slack let in
    expect(later!.firstTime).toBeGreaterThanOrEqual(NOW + 3 * DAY - FUDGE_WINDOW_S);
    expect(later!.firstTime).toBeLessThan(NOW + 3 * DAY - FUDGE_WINDOW_S + testPeriod);
    // mainnet parameters on the same data would not see a superblock hourly: the parameters follow the network
    expect(testPeriod).toBeLessThan(DAY);
  });

  it('is left out of the budget numbers (N of M) and counted apart; allocated stays the cycle document', () => {
    const cycle = cycleAt(NEXT, 250e8);
    const live = proposal('live', { startEpoch: NOW - 2 * DAY, endEpoch: NEXT + 40 * DAY, paymentAmount: 250e8 });
    const tallies = new Map([
      ['live', tally('live', { inNextBudget: true })],
      ['dpn', tally('dpn', { inNextBudget: true })], // a source says it is funded; the schedule says otherwise
    ]);
    const rows = [live, dash()].map((p) => deriveRow(p, tallies, new Map(), cycle, MAIN, NOW));
    const view = budgetView(rows, cycle.value);
    expect(view).toMatchObject({ active: 1, later: 1, fundedSum: 250e8, allocated: 250e8 });
    expect(view.funded.map((r) => r.p.value.govHash)).toEqual(['live']);
  });
});
