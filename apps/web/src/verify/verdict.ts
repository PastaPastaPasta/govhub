// Turns vote recounts into what the UI may claim. "Verified" needs both a matching tally AND
// voting keys confirmed by the DAPI masternode list; a match on bridge-supplied keys only proves
// the bridge is self-consistent.
import type { Provenance, Tally } from '../data/types.ts';
import { excludedText, type TargetResult, type VoteRun } from './votes.ts';

export const PLATFORM_TARGET = 'Platform tally';
export const BRIDGE_TARGET = 'Bridge live tally';

/**
 * `excluded`: the tally matches the votes the bridge served, but only with votes this browser couldn't prove (left out here).
 * `changed`: for the tally's block the bridge served another vote set (voteSetHash) than the tally's, even when asked by hash: votes
 * arrived while checking, or the bridge does not serve that set. Never a mismatch: the recount is not of that tally's votes.
 */
export type VoteLevel = 'verified' | 'keys-reported' | 'excluded' | 'changed' | 'different-height' | 'mismatch' | 'no-tally';

export interface VoteVerdict {
  level: VoteLevel;
  matched?: TargetResult;
}

type RunRef = Pick<VoteRun, 'votesAsOf' | 'asked' | 'servedVoteSetHash'>;
type TargetRef = Pick<TargetResult, 'asOfHeight' | 'voteSetHash'>;

/** A tally that neither the count here nor the bridge's full served set reproduces: the votes and the tally contradict each other. */
export const contradicts = (run: RunRef, t: TargetRef & Pick<TargetResult, 'matches' | 'servedMatches'>): boolean =>
  comparable(run, t) && !t.matches && !t.servedMatches;

/** The bridge served its tally record at the tally's very height, or the record in force at it when asked for that height. */
const sameHeight = (run: RunRef, t: Pick<TargetResult, 'asOfHeight'>): boolean =>
  t.asOfHeight === run.votesAsOf || (run.asked === t.asOfHeight && run.votesAsOf <= t.asOfHeight);

/**
 * For the tally's block, the bridge served a set it labels with another voteSetHash than the tally commits to: another snapshot. The
 * live tally changes at the same height whenever a vote arrives, so an honest bridge does this when a vote lands between reading the
 * tally and reading its votes; a dishonest one can do it to withhold the set (as it can by not answering). Either way the recount is
 * not of this tally's votes: it neither confirms nor contradicts it.
 */
export const otherSnapshot = (run: RunRef, t: TargetRef): boolean =>
  sameHeight(run, t) && !!run.servedVoteSetHash && !!t.voteSetHash && run.servedVoteSetHash.toLowerCase() !== t.voteSetHash.toLowerCase();

/**
 * Whether a recount is of the vote set behind tally `t`: of its height (above), and the set the bridge served is, by the bridge's own
 * label, the one `t` commits to (an unlabelled set is taken at its height). Any other recount says nothing about `t`: votes move on
 * between updates. A comparable recount that differs from `t` is a contradiction between the votes served and the published tally:
 * the bridge said "these are the votes behind it", and they are not.
 */
export const comparable = (run: RunRef, t: TargetRef): boolean => sameHeight(run, t) && !otherSnapshot(run, t);

/** Whether a recount's target is this very tally (name, height and vote set): a newer live tally at the same height is another. */
export const isTally = (t: Pick<TargetResult, 'name' | 'asOfHeight' | 'voteSetHash'>, shown: { name: string; tally: Pick<Tally, 'asOfHeight' | 'voteSetHash'> }): boolean =>
  t.name === shown.name && t.asOfHeight === shown.tally.asOfHeight && t.voteSetHash === shown.tally.voteSetHash.toLowerCase();

export function voteVerdict(runs: readonly VoteRun[]): VoteVerdict {
  const pairs = runs.flatMap((run) => run.result.targets.map((t) => ({ run, t })));
  if (pairs.length === 0) return { level: 'no-tally' };
  // A tally that a recount of its own vote set contradicts is a failure, even if another tally matched.
  if (pairs.some(({ run, t }) => contradicts(run, t))) return { level: 'mismatch' };
  const hit = pairs.find(({ t }) => t.matches);
  if (hit) return { level: hit.run.result.keysFrom === 'sml' ? 'verified' : 'keys-reported', matched: hit.t };
  const excluded = pairs.find(({ t }) => t.servedMatches);
  if (excluded) return { level: 'excluded', matched: excluded.t };
  if (pairs.some(({ run, t }) => otherSnapshot(run, t))) return { level: 'changed' };
  return { level: 'different-height' };
}

/** Provenance of a shown tally after the recounts; unchanged unless a recount says something about it. */
export function tallyProvenance(shown: { name: string; prov: Provenance; tally: Tally }, runs: readonly VoteRun[] | undefined): Provenance {
  // Only a recount of THIS tally counts: a reloaded live tally (newer block) must not inherit the verdict on its predecessor.
  const hit = (runs ?? []).flatMap((run) => run.result.targets.map((t) => ({ run, t }))).find(({ t }) => isTally(t, shown));
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
  if (otherSnapshot(run, target)) return more(`the bridge served another vote set than this tally's for its block (usually a vote arrived while checking); not compared`);
  if (!comparable(run, target)) return more(`votes are as of block ${run.votesAsOf}, this tally as of block ${target.asOfHeight}`);
  if (target.servedMatches) return more(`it counts votes this browser couldn't prove: ${excludedText(r)}`);
  return { kind: 'mismatch', source: src, detail: target.compare.filter((c) => !c.ok).map((c) => c.field).join(', ') };
}
