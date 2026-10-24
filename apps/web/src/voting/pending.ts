// Signed votes the client is still watching (PLAN §5.1 "keep a signed copy so it can re-broadcast elsewhere", §5.2 step 5).
// Kept in this browser (localStorage, per network and identity) and, when the keyring is saved on Platform, in its encrypted
// PENDING document so another device can keep watching. The records hold public data only (a signed vote becomes public when it
// is broadcast), but before release they link masternodes together, so they never leave the device unencrypted.
//
// Status model (what the user sees, voting/status.ts words it):
//   queued     signed in this browser, no relay has accepted it yet (sent with backoff while the page is open)
//   held       a relay accepted it and holds it until its release (or Core's one-change-per-hour rule)
//   broadcast  a relay handed it to Core (voteraw answered "Voted successfully"), not yet seen in the bridge
//   confirmed  the bridge's vote set has it as the masternode's current vote, signature checked against our key here
//   failed     will not go out (the reason says why)
//   replaced   a newer vote of the same masternode on the same proposal won (Core keeps the latest nTime)
//   dropped    replaced by a newer vote of yours before it ever left this browser: never sent
//   cancelled  withdrawn from every relay that held it
import { MAX_REFS_PER_VOTE, type PendingVote } from '@govhub/auth';
import { base64 } from '@scure/base';
import type { BridgeVote } from '../data/bridge.ts';
import { currentKey, mnId, type Outcome, type SignedVoteRecord } from './plan.ts';
import type { HoldReason, RelayVoteStatus } from './relay.ts';

export type WatchStatus = 'queued' | 'held' | 'broadcast' | 'confirmed' | 'failed' | 'replaced' | 'dropped' | 'cancelled';

/** What one relay last said about the vote (GET /v1/votes/:id). */
export interface RelayInfo {
  releaseAt?: number;
  nextAttemptAt?: number | null;
  holdReason?: HoldReason | null;
  lastError?: string | null;
  broadcastAt?: number | null;
  sameAsCurrent?: boolean | null;
}

export interface WatchedVote extends SignedVoteRecord {
  refs: Array<{ relay: string; id: string }>;
  status: WatchStatus;
  /** last relay status seen, per relay */
  relayStatus?: Record<string, RelayVoteStatus>;
  relayInfo?: Record<string, RelayInfo>;
  rebroadcasts: number;
  /**
   * Restored from the keyring's PENDING backup on another device or session. Never re-broadcast from here: only a relay that still
   * holds it sends it (the user may have cancelled or replaced it since the backup was written).
   */
  restored?: boolean;
  /** unix s: a relay asked us to wait (429 Retry-After) before the next re-send */
  retryAt?: number;
  /** unix s, when it was signed here (absent on records from before this field) */
  signedAt?: number;
  /** queued: failed submissions so far, the next try (unix s) and the last reason in plain words */
  sendAttempts?: number;
  nextSendAt?: number;
  lastSendError?: string;
  /** failed: why, in plain words */
  failReason?: string;
  /** replaced / dropped: the vote hash that replaced it ('' = a vote not cast in this browser) */
  replacedBy?: string;
  /** confirmed: first seen in the bridge's verified vote set; counted: the recount of that set includes it */
  seenAt?: number;
  countedAt?: number;
  /** at signing: the masternode's weight (1 regular, 4 evonode) and its current vote, for the tally change shown on success */
  weight?: number;
  prev?: { outcome: number; time: number } | null;
  /** signed with a memory-only keyring: kept in this tab only, never written to storage */
  ephemeral?: boolean;
  /** relays a submission timed out at: they may hold the vote without us knowing its id (a cancel cannot be sure) */
  maybeAt?: string[];
  /** planned later than asked because of Core's one-change-per-hour rule (the masternode voted on this proposal < 1 h ago) */
  hourRule?: boolean;
  /** counted: the proposal's weighted tally without and with this vote (the recount), for the success card */
  tally?: { before: { yes: number; no: number; abstain: number }; after: { yes: number; no: number; abstain: number } };
}

/** A queued vote is first retried after 5 s, then doubling up to 5 min (while the page is open; "Retry now" skips the wait). */
const SEND_RETRY_BASE_S = 5;
const SEND_RETRY_CAP_S = 300;
export const sendRetryDelay = (attempts: number): number => Math.min(SEND_RETRY_CAP_S, SEND_RETRY_BASE_S * 2 ** Math.max(0, attempts - 1));

/** A vote not visible in the bridge this long after its release is re-sent (to another relay when there is one). */
const REBROADCAST_AFTER_S = 10 * 60;
const MAX_REBROADCASTS = 3;
/** Finished records are dropped this long after their release. */
const KEEP_FINISHED_S = 7 * 24 * 3600;
/** After it is seen, a vote is watched this long for the recount (the "counted" step). */
const COUNT_WATCH_S = 3600;

const keyV1 = (network: string, identityId: string | null) => `govhub.votes.v1.${network}.${identityId ?? 'anonymous'}`;
const keyV2 = (network: string, identityId: string | null) => `govhub.votes.v2.${network}.${identityId ?? 'anonymous'}`;

const STATUSES = new Set<WatchStatus>(['queued', 'held', 'broadcast', 'confirmed', 'failed', 'replaced', 'dropped', 'cancelled']);
const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && /^[0-9a-f]{64}$/.test(String((x as { voteHash?: unknown }).voteHash));

/**
 * Version-1 records to version 2. v1 used `held` both for "a relay holds it" and "never left this browser", and marked a never-sent
 * vote `superseded` as soon as a newer one was signed. Nothing is lost: a never-sent vote stays queued (it is sent once a relay is
 * reachable) unless the user signed another vote of the same masternode on the same proposal after it (list order, not nTime: an
 * hour-rule or deferred vote can carry a later nTime than one signed after it), which is what the user wanted to go out.
 */
type V1Vote = Omit<WatchedVote, 'status'> & { status: string };

export function migrateV1(list: readonly Record<string, unknown>[]): WatchedVote[] {
  const votes = list.map((x) => x as unknown as V1Vote);
  const newest = new Map<string, V1Vote>();
  for (const v of votes) {
    const k = currentKey(v, v.govHash);
    newest.set(k, v); // v1 appended each new vote: the last one for a target is the one the user signed last
  }
  return votes.map((v): WatchedVote => {
    const refs = Array.isArray(v.refs) ? v.refs : [];
    const sent = refs.length > 0;
    const newer = newest.get(currentKey(v, v.govHash));
    const replacedBy = newer && newer.voteHash !== v.voteHash ? newer.voteHash : undefined;
    const base: WatchedVote = { ...v, refs, rebroadcasts: v.rebroadcasts ?? 0, status: 'queued' };
    switch (v.status) {
      case 'held':
        if (sent) return { ...base, status: 'held' };
        return replacedBy ? { ...base, status: 'dropped', replacedBy } : base;
      case 'superseded':
        if (!sent) return replacedBy ? { ...base, status: 'dropped', replacedBy } : base;
        return { ...base, status: 'replaced', replacedBy: replacedBy ?? '' };
      case 'broadcast':
      case 'confirmed':
      case 'failed':
      case 'cancelled':
        return { ...base, status: v.status };
      default:
        return sent ? { ...base, status: 'held' } : base;
    }
  });
}

export function loadWatched(storage: Pick<Storage, 'getItem'>, network: string, identityId: string | null): WatchedVote[] {
  const read = (k: string): Record<string, unknown>[] | null => {
    try {
      const raw = storage.getItem(k);
      if (raw === null) return null;
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter(isRecord) : [];
    } catch {
      return [];
    }
  };
  const v2 = read(keyV2(network, identityId))?.map((x) => x as unknown as WatchedVote).filter((x) => STATUSES.has(x.status)) ?? null;
  const v1 = read(keyV1(network, identityId));
  if (!v1) return v2 ?? [];
  // a tab of the previous version (open across a deploy) may still write v1: its records join v2 instead of being lost
  const known = new Set((v2 ?? []).map((x) => x.voteHash));
  return [...(v2 ?? []), ...migrateV1(v1).filter((x) => !known.has(x.voteHash))];
}

/** Writes version 2 and only then removes a version-1 list, so a failed write never loses the queued votes. */
export function saveWatched(storage: Pick<Storage, 'setItem' | 'removeItem'>, network: string, identityId: string | null, all: readonly WatchedVote[]): void {
  const votes = all.filter((v) => !v.ephemeral); // signed with a memory-only keyring: never stored
  if (!votes.length) storage.removeItem(keyV2(network, identityId));
  else storage.setItem(keyV2(network, identityId), JSON.stringify(votes));
  storage.removeItem(keyV1(network, identityId));
}

const sameTarget = (a: WatchedVote, b: WatchedVote): boolean => a.voteHash !== b.voteHash && a.govHash.toLowerCase() === b.govHash.toLowerCase() && mnId(a) === mnId(b);

/** Signed before `b` (signing order; nTime breaks ties, since an hour-rule or deferred vote's nTime says nothing about when it was signed). */
const signedBefore = (a: WatchedVote, b: WatchedVote): boolean => (a.signedAt ?? 0) < (b.signedAt ?? 0) || ((a.signedAt ?? 0) === (b.signedAt ?? 0) && a.time < b.time);

/**
 * Adds or replaces records by vote hash. A vote signed later for the same (masternode, proposal) drops an older one that never left
 * this browser (it is taken out of the send queue, with a note). Older votes that did leave are NOT marked here: a held one is cancelled
 * by the cast, and one that went out stays what it is until the newer vote actually wins in the bridge (bridgeVerdict).
 */
export function mergeWatched(list: readonly WatchedVote[], add: readonly WatchedVote[]): WatchedVote[] {
  const out = new Map(list.map((v) => [v.voteHash, v]));
  for (const v of add) {
    for (const o of out.values()) {
      if (sameTarget(o, v) && o.status === 'queued' && signedBefore(o, v)) out.set(o.voteHash, { ...o, status: 'dropped', replacedBy: v.voteHash });
    }
    out.set(v.voteHash, { ...out.get(v.voteHash), ...v });
  }
  return [...out.values()];
}

/** Still on its way: in this browser's queue, at a relay, or broadcast and not yet seen. */
export const isOpen = (v: WatchedVote): boolean => v.status === 'queued' || v.status === 'held' || v.status === 'broadcast';

/** Worth asking the relay and the bridge about: open, or seen and waiting for the recount. */
export const isTracked = (v: WatchedVote, now: number): boolean => isOpen(v) || (v.status === 'confirmed' && !v.countedAt && now - (v.seenAt ?? 0) < COUNT_WATCH_S);

export function pruneWatched(list: readonly WatchedVote[], now: number): WatchedVote[] {
  return list.filter((v) => isOpen(v) || now - v.releaseAt < KEEP_FINISHED_S);
}

/**
 * The bridge's view, after a signature check against the voting key that signed our own vote, decides "confirmed": the masternode's
 * current funding vote on the proposal is exactly ours (same nTime and outcome). A later current vote means ours was replaced: by a
 * newer vote of ours when `ours` lists it, otherwise by another wallet holding the key. Never applied to a vote that did not leave.
 */
export function bridgeVerdict(
  v: WatchedVote,
  current: Pick<BridgeVote, 'outcome' | 'time'> | undefined,
  ours: readonly WatchedVote[] = [],
): { status: 'confirmed' } | { status: 'replaced'; replacedBy: string } | null {
  if (!current || v.status === 'queued' || v.status === 'dropped' || v.status === 'cancelled') return null;
  if (current.time === v.time && current.outcome === v.outcome) return { status: 'confirmed' };
  if (current.time > v.time) {
    const winner = ours.find((o) => sameTarget(o, v) && o.time === current.time && o.outcome === current.outcome);
    return { status: 'replaced', replacedBy: winner?.voteHash ?? '' };
  }
  return null;
}

/** Whether the watchdog should re-send a vote a relay already took (not seen in the bridge long after its release). */
export function needsRebroadcast(v: WatchedVote, now: number): boolean {
  return !v.restored && (v.status === 'held' || v.status === 'broadcast') && v.refs.length > 0 && now >= v.releaseAt + REBROADCAST_AFTER_S * (v.rebroadcasts + 1) && v.rebroadcasts < MAX_REBROADCASTS;
}

/** Whether a queued vote is due for another submission. */
export const sendDue = (v: WatchedVote, now: number): boolean => v.status === 'queued' && !v.restored && (v.nextSendAt ?? 0) <= now;

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
    status: p.refs.length ? 'held' : 'queued',
    rebroadcasts: 0,
    restored: true,
  };
}
