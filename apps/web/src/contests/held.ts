// Signed contest votes waiting to go out, and when. "Now" votes go at once, one after another. "Spread out" votes each get their own
// random time before the contest closes, so watchers of Platform do not see one operator's masternodes vote together. There is no
// relay for Platform votes: this browser sends them, so they only go out while govhub is open here. A vote whose time passed while
// govhub was closed (or the computer slept) gets a new random time soon after, so overdue votes never go out as one burst.
// Only votes still to send (or being sent) are stored, in localStorage, per data mode and network; a sent or failed one is dropped
// from storage at once. Each vote names its owner (the signed-in identity, or "guest" for pasted keys): pages show a reader only
// their own, though the sender sends every stored vote (they were signed to go out).
import type { CoreNetwork } from '../data/types.ts';
import { uniform, type Window } from '../voting/plan.ts';
import type { Choice } from './vote.ts';

export const GUEST_OWNER = 'guest';

export interface HeldVote {
  id: string;
  network: CoreNetwork;
  /** the signed-in identity that signed it, or GUEST_OWNER (keys pasted without an account) */
  owner: string;
  label: string;
  proTxHash: string;
  /** the masternode's voting identity (base58) */
  voterId: string;
  choice: Choice;
  /** the signed transition, base64 (empty in demo mode) */
  st: string;
  /** its identity nonce, decimal */
  nonce: string;
  mode: 'now' | 'spread';
  /** ms: not sent before this */
  releaseAt: number;
  /** ms, when the contest closes (null: not known) */
  endsAt: number | null;
  status: 'waiting' | 'sending' | 'sent' | 'failed';
  /** ms: when a tab started sending it (a vote left "sending" longer than SENDING_LEASE_MS is taken up again) */
  sendingSince?: number;
  tries: number;
  /** ms: after a failed try, not before this */
  nextTryAt?: number;
  /** why it failed, or what it is waiting for */
  note?: string;
}

/** The last moment a spread-out vote may be scheduled: this long before the contest closes, so a failed send can still be retried. */
const CLOSE_MARGIN_MS: Record<CoreNetwork, number> = { mainnet: 2 * 3_600_000, testnet: 10 * 60_000 };
/** The default spread when the contest closes later than this. */
export const DEFAULT_SPREAD_MS = 6 * 3_600_000;
const MIN_DELAY_MS = 60_000;
/** A vote this late is overdue (govhub was not open, or the computer slept, at its time): it gets a new time in the next RESPREAD_MS. */
export const OVERDUE_MS = 2 * 60_000;
const RESPREAD_MS = 15 * 60_000;
/** A send takes seconds; one "sending" for longer was cut off (the tab closed) and is tried again. */
export const SENDING_LEASE_MS = 3 * 60_000;

/** When spread-out votes may go (ms): from a minute from now to the margin before the close. Null when that leaves no room. */
export function spreadWindow(nowMs: number, endsAt: number | null, network: CoreNetwork): Window | null {
  if (endsAt === null) return null;
  const earliest = nowMs + MIN_DELAY_MS;
  const latest = endsAt - CLOSE_MARGIN_MS[network];
  return latest > earliest + MIN_DELAY_MS ? { earliest, latest } : null;
}

/** One independent random time per vote, uniform in the window (seconds resolution). */
export function releaseTimes(n: number, w: Window, rand32: () => number): number[] {
  const a = Math.ceil(w.earliest / 1000);
  const b = Math.floor(w.latest / 1000);
  return Array.from({ length: n }, () => uniform(a, b, rand32) * 1000);
}

/** Overdue spread-out votes get a new random time in the next few minutes (never past the close); "now" votes stay due. */
export function respreadOverdue(list: readonly HeldVote[], nowMs: number, rand32: () => number): HeldVote[] {
  return list.map((v) => {
    if (v.status !== 'waiting' || v.mode !== 'spread' || v.releaseAt > nowMs - OVERDUE_MS) return v;
    const end = v.endsAt === null ? nowMs + RESPREAD_MS : Math.min(nowMs + RESPREAD_MS, v.endsAt - MIN_DELAY_MS);
    const releaseAt = end > nowMs ? uniform(Math.ceil(nowMs / 1000), Math.floor(end / 1000), rand32) * 1000 : nowMs;
    return { ...v, releaseAt };
  });
}

/** Votes to send now, earliest first. */
export const dueVotes = (list: readonly HeldVote[], nowMs: number): HeldVote[] =>
  list.filter((v) => v.status === 'waiting' && v.releaseAt <= nowMs && (v.nextTryAt ?? 0) <= nowMs).sort((a, b) => a.releaseAt - b.releaseAt);

/** The wait before trying a vote again after `tries` failures: 15 s, doubling, at most 5 min. */
export const retryDelayMs = (tries: number): number => Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, tries - 1));

// ---- storage ---------------------------------------------------------------------------------
/** Demo (fixture) votes never share a list with real ones. */
export const storageKey = (live: boolean, network: CoreNetwork) => `govhub.contestVotes.v1.${live ? 'live' : 'demo'}.${network}`;

const isChoice = (c: unknown): c is Choice => {
  const x = c as { kind?: unknown; identityId?: unknown } | null;
  return !!x && (x.kind === 'abstain' || x.kind === 'lock' || (x.kind === 'contender' && typeof x.identityId === 'string'));
};

const isHeld = (v: unknown): v is HeldVote => {
  const x = v as Partial<HeldVote> | null;
  return (
    !!x &&
    typeof x.id === 'string' &&
    (x.network === 'mainnet' || x.network === 'testnet') &&
    typeof x.owner === 'string' &&
    typeof x.label === 'string' &&
    typeof x.proTxHash === 'string' &&
    typeof x.voterId === 'string' &&
    typeof x.st === 'string' &&
    /^\d+$/.test(x.nonce ?? '') &&
    typeof x.releaseAt === 'number' &&
    (x.mode === 'now' || x.mode === 'spread') &&
    (x.status === 'waiting' || x.status === 'sending') &&
    isChoice(x.choice)
  );
};

/** The stored votes. One left "sending" past its lease (the tab closed mid-send) is waiting again: Platform takes it once at most. */
export function loadHeld(store: Pick<Storage, 'getItem'> | undefined, live: boolean, network: CoreNetwork, nowMs: number): HeldVote[] {
  try {
    const raw: unknown = JSON.parse(store?.getItem(storageKey(live, network)) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(isHeld)
      .filter((v) => v.network === network)
      .map((v) => (v.status === 'sending' && nowMs - (v.sendingSince ?? 0) > SENDING_LEASE_MS ? { ...v, status: 'waiting' as const, sendingSince: undefined } : v));
  } catch {
    return [];
  }
}

/** Stores the votes still to send (or being sent); everything else is not kept. Throws when storage refuses. */
export function saveHeld(store: Pick<Storage, 'setItem' | 'removeItem'> | undefined, live: boolean, network: CoreNetwork, list: readonly HeldVote[]): void {
  const keep = list.filter((v) => v.network === network && (v.status === 'waiting' || v.status === 'sending'));
  if (keep.length) store?.setItem(storageKey(live, network), JSON.stringify(keep));
  else store?.removeItem(storageKey(live, network));
}

/**
 * The next nonce for a voter: past Platform's (its low 40 bits) and past every vote of this voter stored here (waiting or being sent,
 * on any name: a waiting vote that is replaced just leaves a gap, which Platform allows). Null when that would be more than
 * NONCE_WINDOW past Platform's: too many votes of this masternode are waiting.
 */
export function nextNonce(onChain: bigint, held: readonly HeldVote[], voterId: string, window: bigint, mask: bigint): bigint | null {
  const base = onChain & mask;
  const top = held.filter((v) => v.voterId === voterId && (v.status === 'waiting' || v.status === 'sending')).reduce((m, v) => (BigInt(v.nonce) > m ? BigInt(v.nonce) : m), base);
  const next = top + 1n;
  return next - base > window ? null : next;
}
