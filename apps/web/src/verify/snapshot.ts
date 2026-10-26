// Which vote set a recount reads: the one behind each published tally (its height and voteSetHash). A tally and its votes are read at
// different moments, and the bridge's live tally changes at the same height whenever a vote arrives, so the votes are asked for by
// the tally's snapshot, and an answer of another snapshot is labelled as such (verdict.ts otherSnapshot), never compared as the tally's.
import { BridgeError, type Bridge, type BridgeVotes } from '../data/bridge.ts';
import type { Tally } from '../data/types.ts';
import type { VoteRun, VoteTarget } from './votes.ts';

/** The vote set a tally commits to: its height and voteSetHash (the shape verdict.ts compares recounts with). */
export type Snapshot = Pick<Tally, 'asOfHeight' | 'voteSetHash'>;

/** A served vote set, and the height it was asked for (null: asked for the live set). */
interface Served {
  votes: BridgeVotes;
  asked: number | null;
}

/** The snapshot a tally is of, its voteSetHash lowercased (what the bridge's label is compared with). */
export const snapshotOf = (t: Snapshot): Snapshot => ({ asOfHeight: t.asOfHeight, voteSetHash: t.voteSetHash.toLowerCase() });

/** Targets grouped by the snapshot their tally is of (height and vote set): each group is recounted from the vote set behind it. */
function bySnapshot(targets: readonly VoteTarget[]): Array<{ want: Snapshot | null; targets: VoteTarget[] }> {
  if (targets.length === 0) return [{ want: null, targets: [] }];
  const groups = new Map<string, { want: Snapshot; targets: VoteTarget[] }>();
  for (const t of targets) {
    const want = snapshotOf(t.tally);
    const key = `${want.asOfHeight}|${want.voteSetHash}`;
    const group = groups.get(key) ?? { want, targets: [] };
    group.targets.push(t);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * The vote set behind a tally, in at most three requests (`order`): the set in force at its height (`?height=`), the set with its
 * voteSetHash (`?height=&voteSetHash=`), and the live set. The tally and its votes are read at different moments and the bridge's live
 * tally changes at the same height whenever a vote arrives, so an answer may be of another snapshot: the first answer whose voteSetHash
 * is the tally's is used (a live answer only while it is still at the tally's height). When none is (a bridge that doesn't keep superseded sets, or one that withholds the set), the first answer is
 * returned and the verdict says another set was served; it is never compared as the tally's set. A 404 moves on to the next request (a
 * bridge no longer holding a height's set may serve its live one); any other failure fails the recount, unless an answer is in hand.
 * `want` is the tally's snapshot, voteSetHash lowercase (snapshotOf); null: no tally, the live set.
 */
export async function voteSetFor(bridge: Bridge, govHash: string, want: Snapshot | null, order: ReadonlyArray<'height' | 'hash' | 'live'>): Promise<Served> {
  if (!want) return { votes: await bridge.votes(govHash), asked: null };
  const queries = { height: { height: want.asOfHeight }, hash: { height: want.asOfHeight, voteSetHash: want.voteSetHash }, live: undefined };
  let first: Served | null = null;
  let missing: BridgeError | null = null;
  for (const how of order) {
    let got: Served;
    try {
      got = { votes: await bridge.votes(govHash, queries[how]), asked: how === 'live' ? null : want.asOfHeight };
    } catch (e) {
      if (e instanceof BridgeError && e.status === 404) {
        missing ??= e;
        continue;
      }
      // a follow-up that fails otherwise (timeout, HTTP 500) does not discard an answer already in hand: it is labelled, and says why
      if (first) return first;
      throw e;
    }
    const label = got.votes.voteSetHash;
    // The live set keeps its voteSetHash across a block with no new vote, but its tally is then of the next height: only the set
    // asked for at the tally's height (or the live one still at it) is that tally's.
    if (label && label.toLowerCase() === want.voteSetHash && (how !== 'live' || got.votes.tallyHeight === want.asOfHeight)) return got;
    first ??= got;
  }
  if (first) return first;
  throw missing ?? new BridgeError('the bridge has no vote set for this proposal', 404);
}

/**
 * One recount per snapshot the targets' tallies are of: the set behind it is fetched (voteSetFor: the set in force at the tally's height
 * first, what a published tally document points at; then by hash; then the live set) and handed to `count`, which recounts it against
 * that group's targets. The run records which set was actually served: the height of its tally record, and its voteSetHash label.
 */
export async function recountSnapshots(
  bridge: Bridge,
  govHash: string,
  targets: readonly VoteTarget[],
  progress: (m: string) => void,
  count: (votes: BridgeVotes, targets: VoteTarget[]) => Promise<Pick<VoteRun, 'result' | 'mnlistHeight' | 'listMatches'>>,
): Promise<VoteRun[]> {
  const runs: VoteRun[] = [];
  for (const g of bySnapshot(targets)) {
    const names = g.targets.map((t) => t.name).join(' and ') || 'the live tally';
    progress(`Fetching the signed votes behind the ${names}${g.want ? ` (block ${g.want.asOfHeight.toLocaleString('en-US')})` : ''} from ${bridge.name}`);
    const { votes, asked } = await voteSetFor(bridge, govHash, g.want, ['height', 'hash', 'live']);
    // votesAsOf is the height of the tally whose set was actually served (<= the requested height), not the height echoed back.
    runs.push({ ...(await count(votes, g.targets)), votesAsOf: votes.tallyHeight, asked, servedVoteSetHash: votes.voteSetHash });
  }
  return runs;
}
