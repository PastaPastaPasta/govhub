// Taking back a vote of ours before a newer one replaces it (a cast) or because the user cancels it. A vote a relay may hold must be
// cancelled there, or the relay can release it later and, being timed later, override the newer vote. That includes a vote whose
// submission timed out (`maybeAt`): the relay may have stored it without us learning its id, so it is first looked up by vote hash.
import type { WatchedVote } from './pending.ts';
import { RelayError } from './relay.ts';
import type { RelayPort } from './sim.ts';
import { applyRelayState, everLeft } from './status.ts';

/**
 * - cancelled: every relay that held it cancelled it, and none had sent it before
 * - gone:      no relay holds it (it never reached one): it was never sent
 * - sent:      a relay already broadcast it (or is broadcasting it)
 * - maybe:     cancelled now, but a relay had handed it to Core before (it re-sends a vote that does not show up): it may count
 * - unknown:   a relay may hold it under an id we cannot learn (its answer was lost and it cannot be looked up)
 */
export type WithdrawResult = 'cancelled' | 'gone' | 'sent' | 'maybe' | 'unknown';

export interface WithdrawDeps {
  relayFor(url: string): RelayPort;
  network: 'mainnet' | 'testnet';
  /** the signed cancel for this vote (signmessage by its voting key) */
  cancelSig(v: WatchedVote): string;
  now(): number;
}

/** A vote whose answer was lost is re-submitted to learn its id (then cancelled) only when its release is at least this far away. */
export const SAFE_RESUBMIT_S = 300;

/** Thrown when a relay could not be reached; `vote` carries what was learned (refs found by hash), which the caller should keep. */
export class WithdrawError extends Error {
  constructor(
    readonly reason: unknown,
    readonly vote: WatchedVote,
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = 'WithdrawError';
  }
}

/** Finds the vote at the relays whose submission timed out: by hash, or (release still far off) by sending it again for its id. */
export async function reconcileMaybe(v: WatchedVote, d: WithdrawDeps): Promise<WatchedVote> {
  const unsure: string[] = [];
  for (const relay of v.maybeAt ?? []) {
    if (v.refs.some((r) => r.relay === relay)) continue;
    const port = d.relayFor(relay);
    let st = port.byHash ? await port.byHash(v.voteHash).catch(() => 'error' as const) : ('unsupported' as const);
    if (st === 'unsupported' && v.releaseAt > d.now() + SAFE_RESUBMIT_S) {
      // the relay keeps it until its release in any case; sending it again only tells us its id, and it is cancelled right after
      st = await port.submit(v, d.network).catch(() => 'error' as const);
    }
    if (st === null) continue; // the relay answered that it does not have it
    if (st === 'unsupported' || st === 'error') unsure.push(relay);
    else v = applyRelayState(v, relay, st);
  }
  const { maybeAt: _m, ...rest } = v;
  return unsure.length ? { ...rest, maybeAt: unsure } : rest;
}

export async function withdrawVote(v0: WatchedVote, d: WithdrawDeps): Promise<{ result: WithdrawResult; vote: WatchedVote }> {
  let v = await reconcileMaybe(v0, d);
  const unsure = !!v.maybeAt?.length;
  if (!v.refs.length) return { result: unsure ? 'unknown' : 'gone', vote: v };
  const sig = d.cancelSig(v);
  let sent = false;
  let firstError: unknown = null;
  // every relay is tried even when one fails, so one unreachable relay never leaves the others holding the vote
  for (const r of v.refs) {
    const port = d.relayFor(r.relay);
    try {
      await port.cancel(r.id, sig);
      // what the relay says now: a vote it had broadcast and then moved back to `held` keeps its broadcastAt
      const st = await port.status(r.id).catch(() => null);
      v = st ? applyRelayState(v, r.relay, st) : { ...v, relayStatus: { ...v.relayStatus, [r.relay]: 'cancelled' } };
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) continue; // it never held it
      // 409 not-held: only sending / broadcast / confirmed mean the vote went (or is going) out; failed, superseded and
      // cancelled are dead
      if (e instanceof RelayError && e.status === 409) {
        if (['sending', 'broadcast', 'confirmed'].includes(e.voteStatus ?? '')) sent = true;
        continue;
      }
      firstError ??= e;
    }
  }
  if (firstError) throw new WithdrawError(firstError, v);
  if (sent) return { result: 'sent', vote: v };
  if (unsure) return { result: 'unknown', vote: v };
  if (everLeft(v0, v0.relayInfo) || everLeft(v, v.relayInfo)) return { result: 'maybe', vote: v };
  return { result: 'cancelled', vote: v };
}
