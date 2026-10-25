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
// The superblock times are Core's own 2.62-minute-per-block estimates, so this is an estimate, labelled so where it is shown.
import type { Proposal } from '../data/types.ts';

/**
 * Whether a proposal that is still active can receive no more payments.
 * - `remaining`: superblocks still to come whose estimated time is in the proposal's window (`PaymentSchedule.remaining`, or the
 *   payments fact's `remainingEstimate`); null when the schedule is unknown, which is never a lame duck.
 * - `inNextBudget`: the next superblock's own flag. A proposal reported as paid in the next superblock can still be paid, so a
 *   disagreement between that flag and the estimate is resolved toward "not a lame duck" (the estimate is the weaker of the two).
 */
export function isLameDuck(p: Pick<Proposal, 'endEpoch'>, remaining: number | null, nowS: number, inNextBudget = false): boolean {
  return remaining !== null && remaining <= 0 && p.endEpoch > nowS && !inNextBudget;
}
