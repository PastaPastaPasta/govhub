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

/** Core's superblock-time estimate (signing.cpp:59): the same 2.62 minutes per block on every network. */
const BLOCK_SECONDS = 2.62 * 60;

/** Chain parameters per network: the fallback until the bridge reports `getgovernanceinfo` for the network actually in use. */
export const GOV_PARAMS: Record<CoreNetwork, GovParams> = {
  mainnet: { superblockCycle: 16616, maturityWindow: 1662, minQuorum: 10, blockSeconds: BLOCK_SECONDS },
  testnet: { superblockCycle: 24, maturityWindow: 8, minQuorum: 1, blockSeconds: BLOCK_SECONDS },
};

/**
 * `getgovernanceinfo` as a bridge's `/v1/cycle` relays it (`governance`): superblockcycle, superblockmaturitywindow and
 * governanceminquorum. Null when any is missing or implausible, so the caller keeps the chain parameters.
 */
export function parseGovParams(info: unknown): GovParams | null {
  if (!info || typeof info !== 'object') return null;
  const o = info as Record<string, unknown>;
  const pos = (k: string): number | null => (typeof o[k] === 'number' && Number.isSafeInteger(o[k]) && (o[k] as number) > 0 ? (o[k] as number) : null);
  const superblockCycle = pos('superblockcycle');
  const maturityWindow = pos('superblockmaturitywindow');
  const minQuorum = pos('governanceminquorum');
  if (superblockCycle === null || maturityWindow === null || minQuorum === null || maturityWindow >= superblockCycle) return null;
  return { superblockCycle, maturityWindow, minQuorum, blockSeconds: BLOCK_SECONDS };
}

/**
 * Roughly how often a superblock comes, from the network's cycle and block spacing: "hourly" on testnet (24 blocks), "monthly" on
 * mainnet (16616 blocks), otherwise "every ~N hours/days". Used to label amounts: a proposal pays once per superblock, not per month.
 */
export function superblockCadence(params: Pick<GovParams, 'superblockCycle' | 'blockSeconds'>): string {
  const hours = (params.superblockCycle * params.blockSeconds) / 3600;
  const near = (unit: number) => Math.abs(hours - unit) <= unit * 0.25;
  if (hours >= 0.75 && hours < 1.5) return 'hourly';
  if (near(24)) return 'daily';
  if (near(24 * 7)) return 'weekly';
  if (near(24 * 30.4)) return 'monthly';
  const every = (n: number, unit: string) => `every ~${n} ${unit}${n === 1 ? '' : 's'}`;
  if (hours < 0.75) return every(Math.max(1, Math.round(hours * 60)), 'minute');
  return hours < 48 ? every(Math.round(hours), 'hour') : every(Math.round(hours / 24), 'day');
}

/** "per month" (mainnet) or "per hour" (testnet); otherwise "per payment (every ~N days)". Amounts are paid once per superblock. */
export function perPayment(params: Pick<GovParams, 'superblockCycle' | 'blockSeconds'>): string {
  const c = superblockCadence(params);
  const unit = { hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month' }[c];
  return unit ? `per ${unit}` : `per payment (${c})`;
}

/** The unit an amount is paid per, e.g. "per superblock (~monthly)"; the same words on cards and in the proposal table. */
export const perSuperblock = (params: Pick<GovParams, 'superblockCycle' | 'blockSeconds'>): string => {
  const c = superblockCadence(params);
  // "every ~N days" carries its own tilde
  return `per superblock (${c.startsWith('every') ? c : `~${c}`})`;
};

/** "monthly superblock" (mainnet), "hourly superblock" (testnet), or "superblock (every ~N days)": how a sentence names the payout event. */
export const superblockPhrase = (params: Pick<GovParams, 'superblockCycle' | 'blockSeconds'>): string => {
  const c = superblockCadence(params);
  return c.startsWith('every') ? `superblock (${c})` : `${c} superblock`;
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

/** Core's funding order: absYes desc, then hash desc (display hex is big-endian, so string order is numeric order). */
export function compareRank(a: { govHash: string; absYes: number }, b: { govHash: string; absYes: number }): number {
  if (a.absYes !== b.absYes) return b.absYes - a.absYes;
  const ah = a.govHash.toLowerCase();
  const bh = b.govHash.toLowerCase();
  return ah < bh ? 1 : ah > bh ? -1 : 0;
}

export function rankProposals<T extends { govHash: string; absYes: number }>(entries: readonly T[]): T[] {
  return [...entries].sort(compareRank);
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
