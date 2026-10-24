// Governance math that mirrors Dash Core. Sources (dash develop f35a24cfca12):
//   threshold        governance/governance.cpp:1208-1217, object.cpp:975-991
//                    nAbsVoteReq = max(nGovernanceMinQuorum, weightedValidMNs / 10); funded iff absYes >= nAbsVoteReq
//   ranking          governance.cpp:1220-1225  absYes desc, then hash desc (as a 256-bit number)
//   budget fill      governance/signing.cpp:62-100  skip if it doesn't fit, then skip if the superblock time is
//                    outside [start_epoch - 2h, end_epoch + 2h]; the SB time estimate uses 2.62 min per block
//   chain params     chainparams.cpp:171-175 (mainnet), 380-384 (testnet)
import type { CoreNetwork, Cycle, Tally } from '../data/types.ts';

export interface GovParams {
  superblockCycle: number;
  maturityWindow: number;
  minQuorum: number;
  /** Core's own superblock-time estimate: 2.62 minutes per block. */
  blockSeconds: number;
}

export const GOV_PARAMS: Record<CoreNetwork, GovParams> = {
  mainnet: { superblockCycle: 16616, maturityWindow: 1662, minQuorum: 10, blockSeconds: 2.62 * 60 },
  testnet: { superblockCycle: 24, maturityWindow: 8, minQuorum: 1, blockSeconds: 2.62 * 60 },
};

/** GOVERNANCE_FUDGE_WINDOW (signing.cpp:23). */
export const FUDGE_WINDOW_S = 2 * 3600;

export function fundingThreshold(validWeighted: number, params: GovParams): number {
  return Math.max(params.minQuorum, Math.floor(validWeighted / 10));
}

export const absoluteYes = (t: Pick<Tally, 'yesWeighted' | 'noWeighted'>): number => t.yesWeighted - t.noWeighted;

export type Light = 'pass' | 'warn' | 'fail';

export interface PassState {
  passing: boolean;
  /** absYes - threshold: >= 0 when passing. */
  margin: number;
  /** Yes votes still needed (0 when passing). */
  needed: number;
  /**
   * Traffic light: pass = passing and in the next payout; warn = passing but not paid next (budget full
   * or outside its window), or within 10% of the threshold; fail = otherwise.
   */
  light: Light;
}

export function passState(absYes: number, threshold: number, inBudget: boolean | undefined): PassState {
  const margin = absYes - threshold;
  const passing = margin >= 0;
  const close = !passing && -margin <= Math.ceil(threshold * 0.1);
  const light: Light = passing ? (inBudget === false ? 'warn' : 'pass') : close ? 'warn' : 'fail';
  return { passing, margin, needed: passing ? 0 : -margin, light };
}

/** Estimated unix time of the k-th superblock relative to `cycle` (k = 0 is `cycle.superblockHeight`). */
export function superblockTime(cycle: Pick<Cycle, 'estTime'>, k: number, params: GovParams): number {
  return Math.round(cycle.estTime + k * params.superblockCycle * params.blockSeconds);
}

/** Estimated time of the voting deadline (maturity window start) for this cycle. */
export function votingDeadlineTime(cycle: Pick<Cycle, 'estTime' | 'superblockHeight' | 'votingDeadlineHeight'>, params: GovParams): number {
  return Math.round(cycle.estTime - (cycle.superblockHeight - cycle.votingDeadlineHeight) * params.blockSeconds);
}

export interface PaymentSchedule {
  /** Superblocks whose estimated time falls inside the proposal window (with Core's 2 h fudge). */
  total: number;
  /** Of those, the ones still in the future. */
  remaining: number;
  oneTime: boolean;
}

/** Superblock-aligned payment count, the way proposal.dash.org and DashCentral present it (estimates). */
export function paymentSchedule(
  p: { startEpoch: number; endEpoch: number },
  cycle: Pick<Cycle, 'estTime'>,
  params: GovParams,
  nowS: number,
): PaymentSchedule {
  const period = params.superblockCycle * params.blockSeconds;
  const lo = Math.ceil((p.startEpoch - FUDGE_WINDOW_S - cycle.estTime) / period);
  const hi = Math.floor((p.endEpoch + FUDGE_WINDOW_S - cycle.estTime) / period);
  const total = Math.max(0, hi - lo + 1);
  let remaining = 0;
  for (let k = Math.max(lo, Math.floor((nowS - cycle.estTime) / period)); k <= hi; k++) {
    if (superblockTime(cycle, k, params) > nowS) remaining++;
  }
  return { total, remaining: Math.min(remaining, total), oneTime: total === 1 };
}

export interface BudgetEntry {
  govHash: string;
  absYes: number;
  /** duffs */
  amount: number;
  startEpoch: number;
  endEpoch: number;
}

export interface BudgetSelection {
  /** Passing proposals in Core's order (absYes desc, hash desc). */
  ranked: string[];
  /** Proposals that would be paid in the next superblock. */
  funded: Set<string>;
  /** duffs */
  allocated: number;
}

/** Compare display-hex hashes as 256-bit numbers (display hex is big-endian). */
const hashDesc = (a: string, b: string): number => (a.toLowerCase() < b.toLowerCase() ? 1 : a.toLowerCase() > b.toLowerCase() ? -1 : 0);

export function rankProposals<T extends { govHash: string; absYes: number }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => b.absYes - a.absYes || hashDesc(a.govHash, b.govHash));
}

/** CreateSuperblockCandidate's selection: passing proposals in rank order, skipping what doesn't fit or isn't due. */
export function selectBudget(entries: readonly BudgetEntry[], budget: number, threshold: number, sbTime: number): BudgetSelection {
  const ranked = rankProposals(entries.filter((e) => e.absYes >= threshold));
  const funded = new Set<string>();
  let allocated = 0;
  for (const e of ranked) {
    if (allocated + e.amount > budget) continue;
    if (sbTime < e.startEpoch - FUDGE_WINDOW_S || sbTime > e.endEpoch + FUDGE_WINDOW_S) continue;
    allocated += e.amount;
    funded.add(e.govHash);
  }
  return { ranked: ranked.map((e) => e.govHash), funded, allocated };
}
