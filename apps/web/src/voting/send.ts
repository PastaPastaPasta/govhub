// One submission attempt for a vote no relay has accepted yet (POST /v1/votes): every configured relay in turn until one takes it.
// A relay whose answer was lost (connection reset or refused, timeout, 5xx) may have stored the vote, so it is remembered in
// `maybeAt` until a relay answer settles it; a vote is never ended ("failed", "replaced") while such a relay may still hold it.
import { sendRetryDelay, type WatchedVote } from './pending.ts';
import { RelayError } from './relay.ts';
import type { RelayPort } from './sim.ts';
import { applyRelayState, classifySubmitError, type SubmitOutcome } from './status.ts';
import { provesNotHeld } from './withdraw.ts';

export interface SendDeps {
  relayFor(url: string): RelayPort;
  network: 'mainnet' | 'testnet';
  now(): number;
  /** a relay answered (ok) or could not be reached (not ok, why) */
  noteHealth?(url: string, ok: boolean, err?: string): void;
}

/**
 * Returns the updated record: held (or further) with the relay's id, a final state for a refusal, or still queued with the next retry
 * time. A refusal from one relay while another may hold the vote from a lost answer only asks that other relay again; the vote ends
 * only when every such relay refused too (it then keeps `maybeAt`, so a cancel still takes it back there).
 */
export async function submitToRelays(v: WatchedVote, relays: readonly string[], d: SendDeps): Promise<WatchedVote> {
  let last: string | null = null;
  let afterS = 0;
  let final: Extract<SubmitOutcome, { kind: 'final' }> | null = null;
  const maybeAt = new Set(v.maybeAt ?? []);
  // relays in maybeAt that answered this round with a refusal that cannot tell whether they hold it
  const refusedHere = new Set<string>();
  const withMaybe = (x: WatchedVote): WatchedVote => {
    const { maybeAt: _m, ...rest } = x;
    return maybeAt.size ? { ...rest, maybeAt: [...maybeAt] } : rest;
  };
  for (const relay of relays) {
    // after a refusal, only a relay that may hold the vote is asked again (to find it there)
    if (final && !maybeAt.has(relay)) continue;
    try {
      const st = await d.relayFor(relay).submit(v, d.network);
      d.noteHealth?.(relay, true);
      maybeAt.delete(relay);
      const { lastSendError: _e, nextSendAt: _n, ...rest } = v;
      return withMaybe(applyRelayState({ ...rest, status: 'held' }, relay, st));
    } catch (e) {
      const c = classifySubmitError(e, relay);
      if (provesNotHeld(e)) maybeAt.delete(relay);
      if (c.kind === 'sent') return withMaybe({ ...v, status: 'broadcast', lastSendError: undefined });
      if (c.kind === 'retry' && c.maybeReceived) maybeAt.add(relay);
      if (!(e instanceof RelayError && e.status !== undefined)) d.noteHealth?.(relay, false, c.text);
      if (c.kind === 'final') {
        final ??= c;
        if (maybeAt.has(relay)) refusedHere.add(relay);
        continue;
      }
      last = c.text;
      afterS = Math.max(afterS, c.afterS ?? 0);
      if (!c.tryOther) break;
    }
  }
  // a refusal ends the vote unless a configured relay that may hold it did not answer this round (it is asked again later)
  if (final && ![...maybeAt].some((r) => relays.includes(r) && !refusedHere.has(r))) {
    return withMaybe({ ...v, status: final.status, failReason: final.text, ...(final.status === 'failed' ? {} : { replacedBy: '' }) });
  }
  const attempts = (v.sendAttempts ?? 0) + 1;
  return withMaybe({ ...v, status: 'queued', sendAttempts: attempts, lastSendError: last ?? final?.text ?? 'no relay is configured (Settings, Relays)', nextSendAt: d.now() + Math.max(afterS, sendRetryDelay(attempts)) });
}
