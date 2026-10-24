// Signed votes the client is still watching (PLAN §5.1 "keep a signed copy so it can re-broadcast elsewhere", §5.2 step 5).
// Kept in this browser (localStorage, per network and identity) and, when the keyring is saved on Platform, in its encrypted
// PENDING document so another device can keep watching. The records hold public data only (a signed vote becomes public when it
// is broadcast), but before release they link masternodes together, so they never leave the device unencrypted.
import { MAX_REFS_PER_VOTE, type PendingVote } from '@govhub/auth';
import { base64 } from '@scure/base';
import type { BridgeVote } from '../data/bridge.ts';
import { mnId, type Outcome, type SignedVoteRecord } from './plan.ts';
import type { RelayVoteStatus } from './relay.ts';

export type WatchStatus = 'held' | 'broadcast' | 'confirmed' | 'superseded' | 'failed' | 'cancelled';

export interface WatchedVote extends SignedVoteRecord {
  refs: Array<{ relay: string; id: string }>;
  status: WatchStatus;
  /** last relay status seen, per relay */
  relayStatus?: Record<string, RelayVoteStatus>;
  rebroadcasts: number;
}

/** A vote not visible in the bridge this long after its release is re-sent (to another relay when there is one). */
export const REBROADCAST_AFTER_S = 10 * 60;
export const MAX_REBROADCASTS = 3;
/** Finished records are dropped this long after their release. */
export const KEEP_FINISHED_S = 7 * 24 * 3600;

const key = (network: string, identityId: string | null) => `govhub.votes.v1.${network}.${identityId ?? 'anonymous'}`;

export function loadWatched(storage: Pick<Storage, 'getItem'>, network: string, identityId: string | null): WatchedVote[] {
  try {
    const v = JSON.parse(storage.getItem(key(network, identityId)) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.voteHash === 'string' && /^[0-9a-f]{64}$/.test(x.voteHash)) : [];
  } catch {
    return [];
  }
}

export function saveWatched(storage: Pick<Storage, 'setItem' | 'removeItem'>, network: string, identityId: string | null, votes: readonly WatchedVote[]): void {
  if (!votes.length) storage.removeItem(key(network, identityId));
  else storage.setItem(key(network, identityId), JSON.stringify(votes));
}

/** Adds or replaces records by vote hash; a newer vote for the same (masternode, proposal) supersedes an older held one. */
export function mergeWatched(list: readonly WatchedVote[], add: readonly WatchedVote[]): WatchedVote[] {
  const out = new Map(list.map((v) => [v.voteHash, v]));
  for (const v of add) {
    for (const o of out.values()) {
      if (o.voteHash !== v.voteHash && o.govHash === v.govHash && mnId(o) === mnId(v) && o.time < v.time && (o.status === 'held' || o.status === 'broadcast')) out.set(o.voteHash, { ...o, status: 'superseded' });
    }
    out.set(v.voteHash, { ...out.get(v.voteHash), ...v });
  }
  return [...out.values()];
}

export const isOpen = (v: WatchedVote): boolean => v.status === 'held' || v.status === 'broadcast';

export function pruneWatched(list: readonly WatchedVote[], now: number): WatchedVote[] {
  return list.filter((v) => isOpen(v) || now - v.releaseAt < KEEP_FINISHED_S);
}

/**
 * The bridge's view decides "confirmed": the masternode's current funding vote on the proposal is exactly ours (same nTime and
 * outcome). A later current vote means ours was superseded (by the user, or by another wallet holding the key).
 */
export function bridgeVerdict(v: WatchedVote, current: BridgeVote | undefined): 'confirmed' | 'superseded' | null {
  if (!current) return null;
  if (current.time === v.time && current.outcome === v.outcome) return 'confirmed';
  if (current.time > v.time) return 'superseded';
  return null;
}

/** Whether the watchdog should re-send the vote now. */
export function needsRebroadcast(v: WatchedVote, now: number): boolean {
  return isOpen(v) && now >= v.releaseAt + REBROADCAST_AFTER_S * (v.rebroadcasts + 1) && v.rebroadcasts < MAX_REBROADCASTS;
}

/** Relay to use for a re-broadcast: one this vote was not sent to yet, else the first. */
export function pickRebroadcastRelay(v: WatchedVote, relays: readonly string[]): string | null {
  const used = new Set(v.refs.map((r) => r.relay));
  return relays.find((r) => !used.has(r)) ?? relays[0] ?? null;
}

// ---- keyring PENDING document <-> watched votes ----

export function toPending(v: WatchedVote): PendingVote {
  return {
    collateralTxid: v.collateralTxid,
    collateralIndex: v.collateralIndex,
    govHash: v.govHash,
    outcome: v.outcome,
    time: v.time,
    sig: base64.decode(v.sig),
    releaseAt: v.releaseAt,
    refs: v.refs.slice(0, MAX_REFS_PER_VOTE),
  };
}

export function fromPending(p: PendingVote, proTxHash: string, voteHash: string): WatchedVote {
  return {
    proTxHash,
    collateralTxid: p.collateralTxid,
    collateralIndex: p.collateralIndex,
    govHash: p.govHash,
    outcome: p.outcome as Outcome,
    time: p.time,
    releaseAt: p.releaseAt,
    sig: base64.encode(p.sig),
    voteHash,
    refs: p.refs,
    status: 'held',
    rebroadcasts: 0,
  };
}
