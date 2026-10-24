// View model: joins a proposal with its tallies and the cycle into what a card / page shows.
import type { Cycle, Proposal, Provenance, Sourced, Tally } from '../data/types.ts';
import { absoluteYes, fundingThreshold, passState, paymentSchedule, type GovParams, type PassState, type PaymentSchedule } from './governance.ts';

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
}

export function pickTally(platform: Sourced<Tally> | null | undefined, bridge: Sourced<Tally> | null | undefined): Sourced<Tally> | null {
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
): Row {
  const platformTally = platform.get(p.value.govHash) ?? null;
  const bridgeTally = bridge.get(p.value.govHash) ?? null;
  const tally = pickTally(platformTally, bridgeTally);
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
  };
}

/** DashCentral order: rank from the tally (1 = best), unranked last, then absolute yes. */
export function byRank(a: Row, b: Row): number {
  const ra = a.tally?.value.rank || Number.MAX_SAFE_INTEGER;
  const rb = b.tally?.value.rank || Number.MAX_SAFE_INTEGER;
  return ra - rb || (b.absYes ?? -Infinity) - (a.absYes ?? -Infinity) || a.p.value.name.localeCompare(b.p.value.name);
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
