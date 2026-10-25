// Signed votes the client is still watching (PLAN §5.1 "keep a signed copy so it can re-broadcast elsewhere", §5.2 step 5).
// Kept in this browser (localStorage, per network and identity, encrypted under the keyring: loadWatchedSealed) and, when the
// keyring is saved on Platform, in its encrypted PENDING document so another device can keep watching. The records hold public data
// only (a signed vote becomes public when it is broadcast), but before release they link masternodes together, so they are never
// stored unencrypted.
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
import { MAX_REFS_PER_VOTE, MAX_RELAYS, openLocalRecord, sealLocalRecord, type PendingVote } from '@govhub/auth';
import { bytesToHex } from '@govhub/verify';
import { sha256 } from '@noble/hashes/sha2.js';
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
  /** the relay may have handed it to Core at some point (GET /v1/votes/:id `maybeSent`) */
  maybeSent?: boolean | null;
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
  /**
   * confirmed: first seen in the first bridge's vote set (signature checked here); counted: the recount of that set includes it. Both are
   * that bridge's report, not proof that Dash Core counted the vote.
   */
  seenAt?: number;
  countedAt?: number;
  /** Other configured bridges whose vote set also has this exact vote (signature checked here): agreement from another source. */
  alsoSeenBy?: string[];
  /** at signing: the masternode's weight (1 regular, 4 evonode) and its current vote, for the tally change shown on success */
  weight?: number;
  prev?: { outcome: number; time: number } | null;
  /** signed with a memory-only keyring: kept in this tab only, never written to storage */
  ephemeral?: boolean;
  /**
   * Relays a submission may have reached without us learning the answer (connection reset or refused, timeout, 5xx): they may hold
   * the vote without us knowing its id. It is posted there again (idempotent by vote hash) to find out, and to cancel it.
   */
  maybeAt?: string[];
  /**
   * The user's cancel (or a newer vote's take-back) that a relay has not confirmed yet, because it could not be reached: the signed
   * cancel (signmessage by the voting key over relayCancelMessage; it can cancel this one vote and nothing else), asked again with
   * backoff (`nextCancelAt`) until every relay that may hold the vote answered. `cancelError`: why the last try did not finish.
   */
  cancelSig?: string;
  cancelAttempts?: number;
  nextCancelAt?: number;
  cancelError?: string;
  /** the Core network it is signed for (records from before this field: the network of the list they are stored in) */
  network?: 'mainnet' | 'testnet';
  /**
   * Cancelled at the relay after the relay had already handed it to Core once (a broadcast it re-sends when the vote does not show
   * up): it may already count. Never re-sent from here.
   */
  withdrawn?: boolean;
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
/** Stored records that look like watched votes (a vote hash and a known status). */
const reviveWatched = (a: readonly unknown[]): WatchedVote[] => a.filter(isRecord).map((x) => x as unknown as WatchedVote).filter((x) => STATUSES.has(x.status));
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
  const raw2 = read(keyV2(network, identityId));
  const v2 = raw2 && reviveWatched(raw2);
  const v1 = read(keyV1(network, identityId));
  if (!v1) return v2 ?? [];
  // a tab of the previous version (open across a deploy) may still write v1: its records join v2 instead of being lost
  const known = new Set((v2 ?? []).map((x) => x.voteHash));
  return [...(v2 ?? []), ...migrateV1(v1).filter((x) => !known.has(x.voteHash))];
}

/**
 * Version 3: the list encrypted under the keyring (`localRecordKey`, @govhub/auth keyring/local.ts) for one scope, so signed votes
 * (deferred ones link masternodes until they are released) never sit in plain storage. Plain lists (v1, v2) of the same network and
 * identity are read (loadWatched), saved sealed and then removed (removePlainWatched).
 */
/**
 * One slot per keyring (a tag of the storage key): opening another keyring of the identity (replaced, or planted) never overwrites the
 * list sealed to the first one; that keyring's list comes back when it is opened again.
 */
const keyV3 = (network: string, identityId: string, key: Uint8Array) => `govhub.votes.v3.${network}.${identityId}.${bytesToHex(sha256(key)).slice(0, 16)}`;
export const watchedScope = (platformNetwork: string, network: string, identityId: string): string => `votes|${platformNetwork}|${network}|${identityId}`;
const te = new TextEncoder();
const td = new TextDecoder();

export function loadWatchedSealed(storage: Pick<Storage, 'getItem'>, network: 'mainnet' | 'testnet', identityId: string, scope: string, key: Uint8Array): WatchedVote[] {
  const blob = storage.getItem(keyV3(network, identityId, key));
  const pt = blob ? openLocalRecord(key, scope, blob) : null;
  if (!pt) return [];
  try {
    const v = JSON.parse(td.decode(pt));
    return Array.isArray(v) ? reviveWatched(v).map((x) => ({ ...x, network: x.network ?? network })) : [];
  } catch {
    return [];
  } finally {
    pt.fill(0);
  }
}

export function saveWatchedSealed(storage: Pick<Storage, 'setItem' | 'removeItem'>, network: 'mainnet' | 'testnet', identityId: string, scope: string, key: Uint8Array, all: readonly WatchedVote[]): void {
  const votes = all.filter((v) => !v.ephemeral && (v.network ?? network) === network);
  if (!votes.length) return storage.removeItem(keyV3(network, identityId, key));
  storage.setItem(keyV3(network, identityId, key), sealLocalRecord(key, scope, te.encode(JSON.stringify(votes))));
}

/** Removes the plain (v1/v2) list of an earlier version, once it has been read (loadWatched) and saved sealed. */
export function removePlainWatched(storage: Pick<Storage, 'removeItem'>, network: string, identityId: string): void {
  storage.removeItem(keyV2(network, identityId));
  storage.removeItem(keyV1(network, identityId));
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
 * No relay has or may have it: never sent, or every attempt was refused by the relay itself. Taking it out of this browser's queue is
 * all a cancel (or a newer vote) needs.
 */
export const neverLeft = (v: WatchedVote): boolean => v.status === 'queued' && !v.maybeAt?.length && !v.refs.length && !v.cancelSig;

/** A relay may hold it (by id, or a submission whose answer was lost): a cancel or a newer vote must take it back there. */
export const mayBeAtRelay = (v: WatchedVote): boolean => v.status === 'held' || ((v.status === 'queued' || v.status === 'failed') && !!v.maybeAt?.length);

/**
 * Adds or replaces records by vote hash. A vote signed later for the same (masternode, proposal) drops an older one that never left
 * this browser (it is taken out of the send queue, with a note). Older votes that did leave are NOT marked here: a held one is cancelled
 * by the cast, and one that went out stays what it is until the newer vote actually wins in the bridge (bridgeVerdict).
 */
export function mergeWatched(list: readonly WatchedVote[], add: readonly WatchedVote[]): WatchedVote[] {
  const out = new Map(list.map((v) => [v.voteHash, v]));
  for (const v of add) {
    for (const o of out.values()) {
      // a queued vote whose answer was lost (maybeAt) may be held by that relay: it is not "never sent", so it stays (the cast
      // reconciles it with the relay and cancels it, or times the new vote after it)
      if (sameTarget(o, v) && neverLeft(o) && signedBefore(o, v)) out.set(o.voteHash, { ...o, status: 'dropped', replacedBy: v.voteHash });
    }
    out.set(v.voteHash, { ...out.get(v.voteHash), ...v });
  }
  return [...out.values()];
}

/** A vote that "may already count" (withdrawn) is watched for the bridge this long after its release, then it is finished. */
export const WITHDRAWN_WATCH_S = 6 * 3600;

/** Unresolved for good: cancelled after it may have been sent, or possibly held by a relay that could not be asked. */
const limbo = (v: WatchedVote): boolean => !!v.withdrawn || (v.status === 'queued' && !!v.restored && !!v.maybeAt?.length);

/**
 * Still on its way: in this browser's queue, at a relay, or broadcast and not yet seen. A vote in limbo is not: nothing here can move
 * it any more (it is still shown, and pruned like a finished one).
 */
export const isOpen = (v: WatchedVote): boolean => (v.status === 'queued' || v.status === 'held' || v.status === 'broadcast') && !limbo(v);

/** A withdrawn vote may still show up in the bridge for a while (then it did count): counted as current and watched until then. */
export const maybeCounts = (v: WatchedVote, now: number): boolean => v.status === 'broadcast' && (!v.withdrawn || now - v.releaseAt < WITHDRAWN_WATCH_S);

/** Worth asking the relay and the bridge about: open, or seen and waiting for the recount. */
export const isTracked = (v: WatchedVote, now: number): boolean => isOpen(v) || (!!v.withdrawn && maybeCounts(v, now)) || (v.status === 'confirmed' && !v.countedAt && now - (v.seenAt ?? 0) < COUNT_WATCH_S);

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
  return !v.restored && !v.withdrawn && !v.cancelSig && (v.status === 'held' || v.status === 'broadcast') && v.refs.length > 0 && now >= v.releaseAt + REBROADCAST_AFTER_S * (v.rebroadcasts + 1) && v.rebroadcasts < MAX_REBROADCASTS;
}

/** Whether a queued vote is due for another submission. */
export const sendDue = (v: WatchedVote, now: number): boolean => v.status === 'queued' && !v.restored && !v.cancelSig && (v.nextSendAt ?? 0) <= now;

/** Whether a cancel no relay has confirmed yet is due for another try (a relay that may hold the vote is still to be asked). */
export const cancelDue = (v: WatchedVote, now: number): boolean => !!v.cancelSig && (v.status === 'queued' || v.status === 'held' || !!v.maybeAt?.length) && (v.nextCancelAt ?? 0) <= now;

/**
 * Two records of one vote (this device, an older list, the Platform backup): `winner` is kept, but never loses where the vote may be
 * (maybeAt) or a pending cancel (cancelSig) the other record knows about, or a relay could keep a vote this browser forgot.
 */
export function keepWhereItMayBe(winner: WatchedVote, other: WatchedVote): WatchedVote {
  const maybeAt = [...new Set([...(winner.maybeAt ?? []), ...(other.maybeAt ?? [])])];
  const cancel = !winner.cancelSig && other.cancelSig ? { cancelSig: other.cancelSig, cancelAttempts: other.cancelAttempts, nextCancelAt: other.nextCancelAt, cancelError: other.cancelError } : {};
  return { ...winner, ...cancel, ...(maybeAt.length ? { maybeAt } : {}) };
}

/**
 * The nTimes of our own votes per (masternode, proposal) that reached a relay or may have (cancelled ones too). A new vote never
 * takes one of them: signed with the same time and outcome it would be the same vote (same hash), and a relay that cancelled it once
 * answers with that cancelled record ("voting again reuses the pinned vote time": the one-change-per-hour rule pins the time).
 */
export function ownVoteTimes(list: readonly WatchedVote[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const v of list) {
    if (!v.refs.length && !v.maybeAt?.length && v.status !== 'broadcast' && v.status !== 'confirmed' && v.status !== 'replaced') continue;
    const k = currentKey(v, v.govHash);
    out.set(k, (out.get(k) ?? new Set()).add(v.time));
  }
  return out;
}

/** Relay to use for a re-broadcast: one this vote was not sent to yet, else the first. */
export function pickRebroadcastRelay(v: WatchedVote, relays: readonly string[]): string | null {
  const used = new Set(v.refs.map((r) => r.relay));
  return relays.find((r) => !used.has(r)) ?? relays[0] ?? null;
}

// ---- keyring PENDING document <-> watched votes ----

export function toPending(v: WatchedVote): PendingVote {
  return {
    ...(v.network ? { network: v.network } : {}),
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
    ...(p.network ? { network: p.network } : {}),
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

/**
 * The PENDING backup after a change on `network`: this network's held and broadcast votes (newest signed first), then what the
 * document holds for the OTHER Core network (the Dev and Testnet profiles share one keyring), newest first, cut at `cap` votes and at
 * the format's relay table (MAX_RELAYS). Untagged entries (version-1 documents) are this network's previous backup (which `list`
 * replaces) when `untaggedIsOurs` says so (signed for this network by one of the keyring's keys), else the other network's.
 */
export function pendingBackup(list: readonly WatchedVote[], network: 'mainnet' | 'testnet', existing: readonly PendingVote[], cap: number, untaggedIsOurs: (p: PendingVote) => boolean = () => true): PendingVote[] {
  const newest = (a: { t: number }, b: { t: number }) => b.t - a.t;
  const ours = list
    .filter((v) => (v.status === 'held' || v.status === 'broadcast') && !v.withdrawn && !v.ephemeral && (v.network ?? network) === network)
    .map((v) => ({ t: v.signedAt ?? v.time, p: toPending({ ...v, network }) }))
    .sort(newest);
  const others = existing
    .filter((p) => (p.network ? p.network !== network : !untaggedIsOurs(p)))
    .map((p) => ({ t: p.time, p }))
    .sort(newest);
  const out: PendingVote[] = [];
  const relays = new Set<string>();
  for (const { p } of [...ours, ...others]) {
    if (out.length >= cap) break;
    const more = p.refs.map((r) => r.relay).filter((r) => !relays.has(r));
    if (relays.size + new Set(more).size > MAX_RELAYS) continue; // would not fit the relay table
    more.forEach((r) => relays.add(r));
    out.push(p);
  }
  return out;
}
