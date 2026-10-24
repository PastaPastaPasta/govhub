// Funding order from recounted tallies: Core's GetApprovedProposals ordering (governance.cpp:1198-1229) and the greedy fill of
// CreateSuperblockCandidate (governance/signing.cpp:38-100), via lib/governance's selectBudget. Pure.
import { FUDGE_WINDOW_S, selectBudget } from '../lib/governance.ts';
import type { ThresholdFact } from './chain.ts';

export interface RecountedProposal {
  govHash: string;
  name: string;
  /** Recounted weighted yes - no. */
  absYes: number;
  /** duffs */
  amount: number;
  startEpoch: number;
  endEpoch: number;
  /** Keys, types and collateral of every counted vote proven (VoteCheckResult.keysFrom === 'sml'). */
  proven: boolean;
  /** Why not proven / not recounted. */
  problem?: string;
}

export interface RankingEntry extends RecountedProposal {
  /** 1-based position among passing proposals in Core's order, or null when not passing. */
  rank: number | null;
  funded: boolean;
  /** The funded answer depends on Core's own estimate of the superblock time (a window edge is close to it). */
  timeSensitive: boolean;
}

export interface RankingResult {
  entries: RankingEntry[];
  /** Every input was proven: every recount, the threshold, and no answer hangs on the superblock-time estimate. */
  verified: boolean;
  reasons: string[];
  threshold: ThresholdFact;
  budget: { height: number; limit: string };
  /** Core's estimate: now + blocks to the superblock * 2.62 min. */
  superblockTime: number;
  allocated: number;
}

/** How far Core's own superblock-time estimate (made at the start of the maturity window) can plausibly be from ours. */
export const TIME_MARGIN_S = 12 * 3600;

export function rankRecounts(rs: readonly RecountedProposal[], threshold: ThresholdFact, budget: { height: number; limit: string }, superblockTime: number): RankingResult {
  const sel = selectBudget(rs.map((r) => ({ govHash: r.govHash, absYes: r.absYes, amount: r.amount, startEpoch: r.startEpoch, endEpoch: r.endEpoch })), Number(budget.limit), threshold.value, superblockTime);
  const rank = new Map(sel.ranked.map((h, i) => [h, i + 1]));
  const near = (t: number) => Math.abs(superblockTime - t) <= TIME_MARGIN_S;
  const entries = rs.map((r) => ({
    ...r,
    rank: rank.get(r.govHash) ?? null,
    funded: sel.funded.has(r.govHash),
    timeSensitive: rank.has(r.govHash) && (near(r.startEpoch - FUDGE_WINDOW_S) || near(r.endEpoch + FUDGE_WINDOW_S)),
  }));
  entries.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.absYes - a.absYes);
  const reasons: string[] = [];
  const unproven = rs.filter((r) => !r.proven);
  if (unproven.length) reasons.push(`${unproven.length} of ${rs.length} recounts are not fully proven (${unproven.slice(0, 3).map((r) => `${r.name}: ${r.problem ?? 'keys not proven'}`).join('; ')})`);
  if (threshold.status !== 'verified') reasons.push(`the funding threshold is not proven (${threshold.reason ?? 'reported'})`);
  const sensitive = entries.filter((e) => e.timeSensitive);
  if (sensitive.length) reasons.push(`${sensitive.map((e) => e.name).join(', ')}: a payment window edge is within 12 h of the superblock time, which Core estimates`);
  return { entries, verified: reasons.length === 0, reasons, threshold, budget, superblockTime, allocated: sel.allocated };
}
