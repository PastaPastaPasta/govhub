// View model: joins a proposal with its tallies and the cycle into what a card / page shows.
import type { Cycle, Proposal, Provenance, ProvenanceKind, Sourced, Tally } from '../data/types.ts';
import { contentFailure, isFailed, type CheckState } from '../verify/checks.ts';
import { isLameDuck, remainingWithSlack } from './lameDuck.ts';
import { absoluteYes, compareRank, fundingThreshold, passState, paymentSchedule, type GovParams, type PassState, type PaymentSchedule } from './governance.ts';

export interface Row {
  p: Sourced<Proposal>;
  /** The tally shown: the fresher of the Platform (proof) and bridge (reported) tallies. */
  tally: Sourced<Tally> | null;
  platformTally: Sourced<Tally> | null;
  bridgeTally: Sourced<Tally> | null;
  absYes: number | null;
  threshold: Sourced<number> | null;
  state: PassState | null;
  schedule: PaymentSchedule | null;
  /** Active, but no superblock left can pay it (lib/lameDuck.ts): listed apart, outside the budget numbers. */
  lameDuck: boolean;
  /**
   * Synchronous content check (no network): the gov hash recomputes and the displayed fields equal the
   * hashed data. When false, a lying source changed what the card shows; links must not be followed.
   */
  content: { ok: boolean; problem?: string };
}

const STRENGTH: Record<ProvenanceKind, number> = { mismatch: 0, fixture: 1, reported: 2, proof: 3, verified: 4 };

/** The weaker of two provenances: a value computed from both is only as trustworthy as the worse one. */
export function weakest(a: Provenance, b: Provenance): Provenance {
  return STRENGTH[b.kind] < STRENGTH[a.kind] ? b : a;
}

function contentCheck(p: Proposal): Row['content'] {
  const problem = contentFailure(p);
  return problem ? { ok: false, problem } : { ok: true };
}

/**
 * The tally to show: the fresher of the two (lists), or with `prefer: 'platform'` the Platform document whenever there is one (the
 * proposal page: its recount is checked against the proven record, never against the bridge's own live tally).
 */
export function pickTally(platform: Sourced<Tally> | null | undefined, bridge: Sourced<Tally> | null | undefined, prefer: 'fresher' | 'platform' = 'fresher'): Sourced<Tally> | null {
  if (prefer === 'platform' && platform) return platform;
  if (bridge && (!platform || bridge.value.asOfHeight > platform.value.asOfHeight)) return bridge;
  return platform ?? null;
}

export function thresholdOf(cycle: Sourced<Cycle> | null, params: GovParams): Sourced<number> | null {
  if (!cycle) return null;
  const prov: Provenance = { ...cycle.prov, detail: `max(${params.minQuorum}, ${cycle.value.validWeighted} weighted valid MNs / 10)` };
  return { value: fundingThreshold(cycle.value.validWeighted, params), prov };
}

export function deriveRow(
  p: Sourced<Proposal>,
  platform: ReadonlyMap<string, Sourced<Tally>>,
  bridge: ReadonlyMap<string, Sourced<Tally>>,
  cycle: Sourced<Cycle> | null,
  params: GovParams,
  nowS: number,
  prefer: 'fresher' | 'platform' = 'fresher',
): Row {
  const platformTally = platform.get(p.value.govHash) ?? null;
  const bridgeTally = bridge.get(p.value.govHash) ?? null;
  const tally = pickTally(platformTally, bridgeTally, prefer);
  const threshold = thresholdOf(cycle, params);
  const absYes = tally ? absoluteYes(tally.value) : null;
  return {
    p,
    tally,
    platformTally,
    bridgeTally,
    absYes,
    threshold,
    state: absYes !== null && threshold ? passState(absYes, threshold.value, tally!.value.inNextBudget) : null,
    schedule: cycle ? paymentSchedule(p.value, cycle.value, params, nowS) : null,
    lameDuck: isLameDuck(p.value, cycle ? remainingWithSlack(p.value, cycle.value, params, nowS) : null, nowS, !!tally?.value.inNextBudget),
    content: contentCheck(p.value),
  };
}

/** Core's funding order (absYes desc, then hash desc), computed here so Platform and bridge ranks never mix; no tally last. */
export function byRank(a: Row, b: Row): number {
  if (a.absYes === null && b.absYes === null) return a.p.value.name.localeCompare(b.p.value.name);
  if (a.absYes === null) return 1;
  if (b.absYes === null) return -1;
  return compareRank({ govHash: a.p.value.govHash, absYes: a.absYes }, { govHash: b.p.value.govHash, absYes: b.absYes });
}

/** Canonical link: /p/<name> unless the name is ambiguous among `names`, then /p/h/<govHash>. */
export function proposalHref(p: Proposal, nameCounts?: ReadonlyMap<string, number>): string {
  return nameCounts && (nameCounts.get(p.name) ?? 0) > 1 ? `/p/h/${p.govHash}` : `/p/${encodeURIComponent(p.name)}`;
}

export function countNames(ps: readonly Proposal[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of ps) m.set(p.name, (m.get(p.name) ?? 0) + 1);
  return m;
}

export interface Checked<T> {
  item: T;
  check: CheckState;
}

/**
 * Splits a list into what is shown by default and what failed local verification (hidden behind a toggle). Pending and
 * inconclusive checks stay shown: a list must not flicker or empty out while checks run, or when the network is down.
 */
export function partitionByCheck<T>(items: readonly T[], stateOf: (t: T) => CheckState): { shown: Checked<T>[]; failed: Checked<T>[] } {
  const shown: Checked<T>[] = [];
  const failed: Checked<T>[] = [];
  for (const item of items) {
    const check = stateOf(item);
    (isFailed(check) ? failed : shown).push({ item, check });
  }
  return { shown, failed };
}

export interface BudgetView {
  /** Shown proposals in the next budget, in rank order. */
  funded: Row[];
  /** duffs: what `funded` asks for */
  fundedSum: number;
  /** duffs: the cycle document's allocation, as published (never a sum over cards, whose flags a source could set) */
  allocated: number;
  /** shown active proposals */
  active: number;
}

/**
 * The budget header's numbers. Proposals that failed verification are not in the budget strip and not active; lame ducks (nothing
 * left to pay) are not active either, and never count toward the next budget.
 */
export function budgetView(shown: readonly Row[], cycle: Pick<Cycle, 'allocated'>): BudgetView {
  const live = shown.filter((r) => !r.lameDuck);
  const funded = live.filter((r) => r.tally?.value.inNextBudget);
  const fundedSum = funded.reduce((sum, r) => sum + r.p.value.paymentAmount, 0);
  return { funded, fundedSum, allocated: cycle.allocated, active: live.length };
}
