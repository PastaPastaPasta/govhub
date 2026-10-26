// Signed contest votes waiting to go out, and when. "Now" votes go at once, one after another. "Spread out" votes each get their own
// random time before the contest closes, so a watcher of Platform does not see one operator's masternodes vote together. There is no
// relay for Platform votes: this browser sends them, so they only go out while govhub is open here. A vote whose time passed while
// govhub was closed gets a new random time soon after it is opened again (several overdue votes sent at once would be a burst).
// Only votes still to be sent are stored (localStorage); a sent or failed one is dropped from storage at once.
import { uniform } from '../voting/plan.ts';
import type { Choice } from './vote.ts';

export type Network = 'mainnet' | 'testnet';

export interface HeldVote {
  id: string;
  network: Network;
  label: string;
  proTxHash: string;
  /** the masternode's voting identity (base58) */
  voterId: string;
  /** 1, or 4 for an evonode */
  weight: number;
  choice: Choice;
  /** the signed transition, base64 */
  st: string;
  /** its identity nonce, decimal */
  nonce: string;
  mode: 'now' | 'spread';
  /** ms: not sent before this */
  releaseAt: number;
  /** ms, when the contest closes (null: not known) */
  endsAt: number | null;
  status: 'waiting' | 'sending' | 'sent' | 'failed';
  tries: number;
  /** ms: after a failed try, not before this */
  nextTryAt?: number;
  /** why it failed, or what it is waiting for */
  note?: string;
  doneAt?: number;
}

/** The last moment a spread-out vote may be scheduled: this long before the contest closes, so a failed send can still be retried. */
export const CLOSE_MARGIN_MS: Record<Network, number> = { mainnet: 2 * 3_600_000, testnet: 10 * 60_000 };
/** The default spread when the contest closes later than this. */
export const DEFAULT_SPREAD_MS = 6 * 3_600_000;
const MIN_DELAY_MS = 60_000;
/** A vote this late is overdue (govhub was not open at its time): it gets a new time in the next RESPREAD_MS. */
const OVERDUE_MS = 2 * 60_000;
const RESPREAD_MS = 15 * 60_000;

export interface Window {
  earliest: number;
  latest: number;
}

/** When spread-out votes may go: from a minute from now to the margin before the close. Null when that leaves no room. */
export function spreadWindow(nowMs: number, endsAt: number | null, network: Network): Window | null {
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
    const end = v.endsAt === null ? nowMs + RESPREAD_MS : Math.min(nowMs + RESPREAD_MS, v.endsAt - 60_000);
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
export const storageKey = (network: Network) => `govhub.contestVotes.v1.${network}`;

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
    typeof x.label === 'string' &&
    typeof x.proTxHash === 'string' &&
    typeof x.voterId === 'string' &&
    typeof x.st === 'string' &&
    typeof x.nonce === 'string' &&
    typeof x.releaseAt === 'number' &&
    (x.mode === 'now' || x.mode === 'spread') &&
    (x.status === 'waiting' || x.status === 'sending') &&
    isChoice(x.choice)
  );
};

/** The stored votes of this network. A vote left "sending" (the tab closed mid-send) is tried again: Platform takes it once at most. */
export function loadHeld(store: Pick<Storage, 'getItem'> | undefined, network: Network): HeldVote[] {
  try {
    const raw: unknown = JSON.parse(store?.getItem(storageKey(network)) ?? '[]');
    return Array.isArray(raw) ? raw.filter(isHeld).filter((v) => v.network === network).map((v) => (v.status === 'sending' ? { ...v, status: 'waiting' as const } : v)) : [];
  } catch {
    return [];
  }
}

/** Stores the votes still to send (or being sent); everything else is not kept. */
export function saveHeld(store: Pick<Storage, 'setItem' | 'removeItem'> | undefined, network: Network, list: readonly HeldVote[]): void {
  const keep = list.filter((v) => v.network === network && (v.status === 'waiting' || v.status === 'sending'));
  if (keep.length) store?.setItem(storageKey(network), JSON.stringify(keep));
  else store?.removeItem(storageKey(network));
}
