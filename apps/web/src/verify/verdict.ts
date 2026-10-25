// Turns vote recounts into what the UI may claim. "Verified" needs both a matching tally AND
// voting keys confirmed by the DAPI masternode list; a match on bridge-supplied keys only proves
// the bridge is self-consistent.
import type { Provenance, Tally } from '../data/types.ts';
import type { TargetResult, VoteRun } from './votes.ts';

export const PLATFORM_TARGET = 'Platform tally';
export const BRIDGE_TARGET = 'Bridge live tally';

export type VoteLevel = 'verified' | 'keys-reported' | 'different-height' | 'mismatch' | 'no-tally';

export interface VoteVerdict {
  level: VoteLevel;
  matched?: TargetResult;
}

/**
 * Whether a recount is of the vote set behind tally `t`: the bridge served its tally record at that very height, or the record in
 * force at it (the newest at or below it) when asked for that height. Any other recount says nothing about `t`: votes move on between
 * updates. A comparable recount that differs from `t` is a contradiction between the votes served and the published tally.
 */
export const comparable = (run: Pick<VoteRun, 'votesAsOf' | 'asked'>, t: Pick<TargetResult, 'asOfHeight'>): boolean =>
  t.asOfHeight === run.votesAsOf || (run.asked === t.asOfHeight && run.votesAsOf <= t.asOfHeight);

export function voteVerdict(runs: readonly VoteRun[]): VoteVerdict {
  const pairs = runs.flatMap((run) => run.result.targets.map((t) => ({ run, t })));
  if (pairs.length === 0) return { level: 'no-tally' };
  // A tally that a recount of its own vote set contradicts is a failure, even if another tally matched.
  if (pairs.some(({ run, t }) => comparable(run, t) && !t.matches)) return { level: 'mismatch' };
  const hit = pairs.find(({ t }) => t.matches);
  if (hit) return { level: hit.run.result.keysFrom === 'sml' ? 'verified' : 'keys-reported', matched: hit.t };
  return { level: 'different-height' };
}

/** Provenance of a shown tally after the recounts; unchanged unless a recount says something about it. */
export function tallyProvenance(shown: { name: string; prov: Provenance; tally: Tally }, runs: readonly VoteRun[] | undefined): Provenance {
  // Only a recount of THIS tally counts: a reloaded live tally (newer block) must not inherit the verdict on its predecessor.
  const hit = (runs ?? []).flatMap((run) => run.result.targets.map((t) => ({ run, t }))).find(({ t }) => t.name === shown.name && t.asOfHeight === shown.tally.asOfHeight);
  if (!hit) return shown.prov;
  const { run, t: target } = hit;
  const r = run.result;
  const src = `recount of ${r.verified} signed votes`;
  const more = (s: string) => ({ ...shown.prov, detail: `${shown.prov.detail ? `${shown.prov.detail}; ` : ''}${s}` });
  if (target.matches) {
    return r.keysFrom === 'sml'
      ? { kind: 'verified', source: src, detail: 'every field and the voteSetHash match; voting keys, types and collateral confirmed by the proven masternode list and each voter\'s registration. Votes the bridge did not serve cannot be detected' }
      : more('recount matches, but the voting keys are as the bridge reports them');
  }
  if (!comparable(run, target)) return more(`votes are as of block ${run.votesAsOf}, this tally as of block ${target.asOfHeight}`);
  return { kind: 'mismatch', source: src, detail: target.compare.filter((c) => !c.ok).map((c) => c.field).join(', ') };
}
