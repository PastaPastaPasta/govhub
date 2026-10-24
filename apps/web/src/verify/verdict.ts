// Turns a vote recount into what the UI may claim. "Verified" needs both a matching tally AND
// voting keys confirmed by the DAPI masternode list; a match on bridge-supplied keys only proves
// the bridge is self-consistent.
import type { Provenance, Tally } from '../data/types.ts';
import type { TargetResult, VoteCheckResult } from './votes.ts';

export const PLATFORM_TARGET = 'Platform tally';
export const BRIDGE_TARGET = 'Bridge live tally';

export type VoteLevel = 'verified' | 'keys-reported' | 'different-height' | 'mismatch' | 'no-tally';

export interface VoteVerdict {
  level: VoteLevel;
  matched?: TargetResult;
}

export function voteVerdict(r: VoteCheckResult, votesAsOf: number): VoteVerdict {
  const matched = r.targets.find((t) => t.matches);
  if (matched) return { level: r.keysFrom === 'sml' ? 'verified' : 'keys-reported', matched };
  if (r.targets.length === 0) return { level: 'no-tally' };
  // Votes newer than the tally snapshot are expected to differ: that is not evidence of a lie.
  if (r.targets.every((t) => t.asOfHeight !== votesAsOf)) return { level: 'different-height' };
  return { level: 'mismatch' };
}

/** Provenance of a shown tally after a recount; unchanged unless the recount says something about it. */
export function tallyProvenance(shown: { name: string; prov: Provenance; tally: Tally }, r: VoteCheckResult | undefined, votesAsOf: number): Provenance {
  const target = r?.targets.find((t) => t.name === shown.name);
  if (!r || !target) return shown.prov;
  const src = `recount of ${r.verified} signed votes`;
  if (target.matches) {
    return r.keysFrom === 'sml'
      ? { kind: 'verified', source: src, detail: 'every field and the voteSetHash match; voting keys confirmed by two DAPI nodes' }
      : { ...shown.prov, detail: `${shown.prov.detail ? `${shown.prov.detail}; ` : ''}recount matches, but the voting keys are as the bridge reports them` };
  }
  if (target.asOfHeight !== votesAsOf) {
    return { ...shown.prov, detail: `${shown.prov.detail ? `${shown.prov.detail}; ` : ''}votes are as of block ${votesAsOf}, this tally as of block ${target.asOfHeight}` };
  }
  return { kind: 'mismatch', source: src, detail: target.compare.filter((c) => !c.ok).map((c) => c.field).join(', ') };
}
