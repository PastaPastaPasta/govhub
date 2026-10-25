// Taking back a vote of ours before a newer one replaces it (a cast) or because the user cancels it. A vote a relay may hold must be
// cancelled there, or the relay can release it later and, being timed later, override the newer vote. That includes a vote whose
// submission timed out (`maybeAt`): the relay may have stored it without us learning its id. It is posted again, which is idempotent
// by vote hash (a relay that has it answers with its receipt; one that does not takes it now), and then cancelled with that id.
import type { WatchedVote } from './pending.ts';
import { RelayError } from './relay.ts';
import type { RelayPort } from './sim.ts';
import { applyRelayState, everLeft } from './status.ts';

/**
 * - cancelled: every relay that held it cancelled it, and none may have sent it before
 * - gone:      no relay holds it (it never reached one): it was never sent
 * - sent:      a relay already broadcast it (or is broadcasting it)
 * - maybe:     no relay will send it now, but one may have handed it to Core before: it may count
 * - unknown:   a relay may hold it, and could not be asked (its answers keep getting lost)
 */
export type WithdrawResult = 'cancelled' | 'gone' | 'sent' | 'maybe' | 'unknown';

export interface WithdrawDeps {
  relayFor(url: string): RelayPort;
  network: 'mainnet' | 'testnet';
  /** the signed cancel for this vote (signmessage by its voting key) */
  cancelSig(v: WatchedVote): string;
  now(): number;
}

/** A vote posted again only to learn its relay id is held at least this long, so it is cancelled before any relay can send it. */
export const REPOST_HOLD_S = 300;
/** Relay answers that prove it does not hold the vote (it refused it against another vote of the masternode). */
const NOT_HELD = new Set(['later-vote-held', 'newer-vote-in-core']);

/** Thrown when a relay could not be reached; `vote` carries what was learned (relay ids), which the caller should keep. */
export class WithdrawError extends Error {
  constructor(
    readonly reason: unknown,
    readonly vote: WatchedVote,
  ) {
    super('a relay could not be reached');
    this.name = 'WithdrawError';
  }
}

/**
 * Learns the vote's id at each relay whose answer was lost, by posting the same signed vote again (idempotent by vote hash: a relay
 * that has it answers with its receipt). The release time is pushed out (it is not signed), so a relay that never had the vote and
 * takes it now holds it until it is cancelled instead of broadcasting it. `inCore`: a relay said Core already has this vote.
 */
export async function reconcileMaybe(v: WatchedVote, d: WithdrawDeps): Promise<{ vote: WatchedVote; inCore: boolean }> {
  const unsure: string[] = [];
  let inCore = false;
  for (const relay of v.maybeAt ?? []) {
    if (v.refs.some((r) => r.relay === relay)) continue;
    try {
      v = applyRelayState(v, relay, await d.relayFor(relay).submit({ ...v, releaseAt: Math.max(v.releaseAt, d.now() + REPOST_HOLD_S) }, d.network));
    } catch (e) {
      if (e instanceof RelayError && e.code === 'already-current') inCore = true;
      else if (!(e instanceof RelayError && NOT_HELD.has(e.code ?? ''))) unsure.push(relay); // anything else: it may hold it
    }
  }
  const { maybeAt: _m, ...rest } = v;
  return { vote: unsure.length ? { ...rest, maybeAt: unsure } : rest, inCore };
}

export async function withdrawVote(v0: WatchedVote, d: WithdrawDeps): Promise<{ result: WithdrawResult; vote: WatchedVote }> {
  const r0 = await reconcileMaybe(v0, d);
  let v = r0.vote;
  const unsure = !!v.maybeAt?.length;
  if (!v.refs.length) return { result: r0.inCore ? 'sent' : unsure ? 'unknown' : 'gone', vote: v };
  const sig = d.cancelSig(v);
  let sent = r0.inCore;
  let firstError: unknown = null;
  // every relay is tried even when one fails, so one unreachable relay never leaves the others holding the vote
  for (const r of v.refs) {
    const port = d.relayFor(r.relay);
    try {
      await port.cancel(r.id, sig);
    } catch (e) {
      if (e instanceof RelayError && e.status === 404) continue; // it never held it
      // 409 not-held: sending / broadcast / confirmed mean the vote went (or is going) out; failed, superseded and cancelled are
      // final, but may still have been sent once (the relay's maybeSent, read below)
      if (e instanceof RelayError && e.status === 409) {
        if (['sending', 'broadcast', 'confirmed'].includes(e.voteStatus ?? '')) sent = true;
      } else {
        firstError ??= e;
        continue;
      }
    }
    // what the relay says now: maybeSent (or, on older relays, a broadcastAt kept when it moved a broadcast back to `held`)
    const st = await port.status(r.id).catch(() => null);
    v = st ? applyRelayState(v, r.relay, st) : { ...v, relayStatus: { ...v.relayStatus, [r.relay]: 'cancelled' } };
  }
  if (firstError) throw new WithdrawError(firstError, v);
  if (sent) return { result: 'sent', vote: v };
  if (unsure) return { result: 'unknown', vote: v };
  // what each relay says now (maybeSent), with the relay statuses seen before the cancel
  if (everLeft({ status: v0.status, relayStatus: v0.relayStatus, relayInfo: v.relayInfo })) return { result: 'maybe', vote: v };
  return { result: 'cancelled', vote: v };
}
