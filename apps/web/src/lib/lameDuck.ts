// Lame-duck proposals: still in Dash Core's active governance set, but no superblock left can pay them.
//
// Core keeps a proposal until its end_epoch passes (governance/object.cpp:148: "expired" once end_epoch <= now). It pays one
// only in a superblock whose estimated time lies in [start_epoch - 2 h, end_epoch + 2 h] (governance/signing.cpp:58-59, 85-97;
// dash develop f35a24cfca12), and the same rule is already in `paymentSchedule` (lib/governance.ts) and the payments fact
// (verify/chain.ts `remainingEstimate`). So a proposal is a lame duck when it is active and that count of future superblocks
// in its window is zero. That covers every way of running out of payments with one test:
//   - it was paid at each superblock of its window (a one-time proposal, once paid);
//   - the next superblock falls after end_epoch + 2 h, or the window holds no superblock at all.
// A proposal that was paid in part and still has a superblock ahead in its window is not a lame duck.
//
// The superblock times are Core's own 2.62-minute-per-block estimates, so this is an estimate, labelled so where it is shown; one day
// of slack on each edge of the window keeps a borderline proposal in the normal list.
import type { Cycle, Proposal } from '../data/types.ts';
import { nextSuperblockIndex, paymentSchedule, superblockTime, windowIndices, type GovParams } from './governance.ts';

/**
 * Slack on each edge of the payment window when deciding that nothing can pay a proposal any more (the same day chain.ts allows
 * for reading real payments). Core decides with a superblock-time estimate made about three days before the superblock; this app
 * extrapolates from the cycle document, up to a month, so a superblock estimated just outside the window might really be inside it.
 * Lame means no superblock is even close to the window, and a borderline proposal stays in the normal list.
 */
export const LAME_DUCK_SLACK_S = 86_400;

/** Superblocks still to come within the proposal's payment window widened by `LAME_DUCK_SLACK_S` (never fewer than `paymentSchedule`'s). */
export function remainingWithSlack(p: Pick<Proposal, 'startEpoch' | 'endEpoch'>, cycle: Pick<Cycle, 'estTime'>, params: GovParams, nowS: number): number {
  return paymentSchedule({ startEpoch: p.startEpoch - LAME_DUCK_SLACK_S, endEpoch: p.endEpoch + LAME_DUCK_SLACK_S }, cycle, params, nowS).remaining;
}

/**
 * Whether a proposal that is still active can receive no more payments.
 * - `remaining`: superblocks still to come whose estimated time is in the proposal's window, with slack (`remainingWithSlack`);
 *   null when the schedule is unknown, which is never a lame duck.
 * - `inNextBudget`: the next superblock's own flag. A proposal reported as paid in the next superblock can still be paid, so a
 *   disagreement between that flag and the estimate is resolved toward "not a lame duck" (the estimate is the weaker of the two).
 */
export function isLameDuck(p: Pick<Proposal, 'endEpoch'>, remaining: number | null, nowS: number, inNextBudget = false): boolean {
  return remaining !== null && remaining <= 0 && p.endEpoch > nowS && !inNextBudget;
}

/** A proposal whose first eligible superblock is after the next one: active and possibly passing, but not up for the next payout. */
export interface StartsLater {
  /** Estimated time of the first superblock that can pay it. */
  firstTime: number;
  /** Estimated time of the next superblock, which cannot. */
  nextTime: number;
}

/**
 * Whether the proposal's payment window (widened by `LAME_DUCK_SLACK_S`, as for lame ducks) opens only after the next superblock
 * and still holds one: it is not in the next budget because it is not due yet, not because the budget is full. The widening keeps a
 * borderline proposal (the next superblock estimated just before its window, or a window only the slack reaches a superblock in) in the
 * normal list. Null when the schedule is unknown.
 * Such a proposal is never a lame duck: it has a superblock ahead in its window.
 */
export function startsLater(p: Pick<Proposal, 'startEpoch' | 'endEpoch'>, cycle: Pick<Cycle, 'estTime'>, params: GovParams, nowS: number): StartsLater | null {
  const wide = windowIndices({ startEpoch: p.startEpoch - LAME_DUCK_SLACK_S, endEpoch: p.endEpoch + LAME_DUCK_SLACK_S }, cycle, params);
  // The cycle's own superblock (k = 0) is still the next one for a day after its estimated time: it may not be mined yet, and the
  // header and every `inNextBudget` flag still describe it.
  let next = nextSuperblockIndex(cycle, params, nowS);
  if (next === 1 && nowS - cycle.estTime <= LAME_DUCK_SLACK_S) next = 0;
  // Core's own window must hold a superblock too: a proposal only the slack lets in is borderline, and stays in the normal list
  const strict = windowIndices(p, cycle, params);
  if (wide.lo <= next || strict.lo > strict.hi || p.endEpoch <= nowS) return null;
  return { firstTime: superblockTime(cycle, strict.lo, params), nextTime: superblockTime(cycle, next, params) };
}
