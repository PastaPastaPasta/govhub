// B-S1-1 (D-005 variant): a vote the relay STORED but whose answer the browser lost as a network error ("Failed to fetch", a
// connection reset), a 5xx or a timeout may be held there. It is never shown as "Not sent yet", never discarded locally, and a
// cancel takes it back at the relay (posted again to learn its id, then cancelled). Driven through the real RelayClient over a
// fetch stub that behaves like services/relay (idempotent by vote hash, error bodies with a code).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hexToBytes } from '@govhub/verify';
import { cancelDue, isOpen, keepWhereItMayBe, mayBeAtRelay, mergeWatched, needsRebroadcast, neverLeft, ownVoteTimes, sendDue, type WatchedVote } from './pending.ts';
import { currentKey, planImmediate, signPlanned, untieOwnTimes } from './plan.ts';
import { RelayClient, RelayError, RelayNotSentError, type RelayVoteState } from './relay.ts';
import type { RelayPort } from './sim.ts';
import { submitToRelays } from './send.ts';
import { applyRelayState, cancelAction, classifySubmitError, describeVote, trackerSteps } from './status.ts';
import { REPOST_HOLD_S, withdrawVote, type WithdrawDeps } from './withdraw.ts';

const priv = hexToBytes('44'.repeat(32));
const mn = { proTxHash: 'aa'.repeat(32), collateralTxid: 'bb'.repeat(32), collateralIndex: 12 };
const gov = 'a9'.repeat(32);
const NOW = 1_792_972_000;
const R1 = 'https://gov-relay-testnet.dashhq.org';
const R2 = 'https://relay-two.example';
const fmt = (s: number) => `T${s - NOW}`;
const vote = (over: Partial<WatchedVote> = {}, outcome: 1 | 2 | 3 = 1, time = NOW + 3600): WatchedVote => ({
  ...signPlanned({ mn, govHash: gov, outcome, time, releaseAt: time - 60, notes: [] }, priv, true, 'testnet'),
  refs: [],
  status: 'queued',
  rebroadcasts: 0,
  signedAt: NOW,
  ...over,
});

type Answer = { status: number; body?: unknown; html?: string };
type Lost = 'reset' | 'timeout' | Answer;
/**
 * A relay behind fetch: stores POST /v1/votes by vote hash (a known hash answers 200 with the receipt), cancels held votes, and lets
 * a test break the answer of the next request(s) AFTER the relay handled it (`lose`), or answer instead of the relay (`answer`).
 */
function httpRelay(base: string) {
  const held = new Map<string, RelayVoteState & { releaseAt: number }>();
  const log: string[] = [];
  let lose: Lost[] = [];
  let answer: Answer[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const handle = (path: string, body: Record<string, unknown>): Response => {
    if (path === '/v1/votes') {
      const v = body as unknown as { time: number; releaseAt: number; outcome: string; sig: string };
      // the vote hash of the posted fields: the test's own vote is matched by its signature
      const key = v.sig;
      const known = held.get(key);
      if (known) return json(200, known);
      const st: RelayVoteState = { id: (held.size + 1).toString(16).padStart(32, '0'), voteHash: hashOf.get(key)!, status: 'held', releaseAt: v.releaseAt, broadcastAt: null, confirmedAt: null, lastError: null, nextAttemptAt: v.releaseAt, holdReason: 'one-change-per-hour', sameAsCurrent: false, maybeSent: false };
      held.set(key, st);
      return json(202, { id: st.id, voteHash: st.voteHash, status: 'held', releaseAt: st.releaseAt });
    }
    if (path === '/v1/votes/cancel') {
      const st = [...held.values()].find((x) => x.id === body.id);
      if (!st) return json(404, { error: 'unknown vote id', code: 'unknown-id' });
      if (st.status !== 'held' && st.status !== 'cancelled') return json(409, { error: `the vote is ${st.status}`, code: 'not-held', status: st.status });
      st.status = 'cancelled';
      return json(200, { id: st.id, status: 'cancelled' });
    }
    const id = path.split('/').pop();
    const st = [...held.values()].find((x) => x.id === id);
    return st ? json(200, st) : json(404, { error: 'unknown vote id', code: 'unknown-id' });
  };
  const hashOf = new Map<string, string>();
  const fetchStub = async (url: string, init?: RequestInit): Promise<Response> => {
    if (!url.startsWith(base)) throw new TypeError('Failed to fetch');
    const path = url.slice(base.length);
    log.push(`${init?.method ?? 'GET'} ${path}`);
    const pre = answer.shift();
    if (pre) return pre.html !== undefined ? new Response(pre.html, { status: pre.status, headers: { 'content-type': 'text/html' } }) : json(pre.status, pre.body ?? {});
    const res = handle(path, init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
    const l = lose.shift();
    if (l === 'reset') throw new TypeError('Failed to fetch'); // the relay handled it; the browser never saw the answer
    if (l === 'timeout') throw new DOMException('signal timed out', 'TimeoutError');
    if (l) return l.html !== undefined ? new Response(l.html, { status: l.status }) : json(l.status, l.body ?? {});
    return res;
  };
  return {
    base,
    held,
    log,
    know: (v: WatchedVote) => hashOf.set(v.sig, v.voteHash),
    lose: (...x: Lost[]) => void (lose = x),
    answer: (...x: Answer[]) => void (answer = x),
    fetchStub,
  };
}

/** Routes fetch to several http relays by base URL (any other host: a failed connection). */
function stubFetch(...relays: Array<ReturnType<typeof httpRelay>>) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const r = relays.find((x) => url.startsWith(x.base));
    if (!r) throw new TypeError('Failed to fetch');
    return r.fetchStub(url, init);
  });
}

const ports: Record<string, RelayPort> = { [R1]: new RelayClient(R1, 2000), [R2]: new RelayClient(R2, 2000) };
const sendDeps = { relayFor: (u: string) => ports[u]!, network: 'testnet' as const, now: () => NOW };
const wdDeps: WithdrawDeps = { relayFor: (u) => ports[u]!, network: 'testnet', cancelSig: () => 'c2ln', now: () => NOW };

afterEach(() => void vi.unstubAllGlobals());

describe('B-S1-1: the relay stored the vote, the browser lost its answer as a network error', () => {
  it('"Failed to fetch" after the relay stored it: maybe at the relay, never "Not sent yet", Discard is a real cancel', async () => {
    const r = httpRelay(R1);
    const v = vote();
    r.know(v);
    stubFetch(r);
    r.lose('reset');
    const after = await submitToRelays(v, [R1], sendDeps);
    expect(r.held.size).toBe(1); // the relay holds it
    expect(after).toMatchObject({ status: 'queued', maybeAt: [R1] });
    expect(after.lastSendError).toMatch(/failed before its answer arrived: Failed to fetch/);
    expect(neverLeft(after)).toBe(false);
    expect(mayBeAtRelay(after)).toBe(true);
    const view = describeVote(after, NOW, fmt);
    expect(view.badge).toBe('May be at the relay');
    expect(view.badge + view.line).not.toMatch(/Not sent|unreachable/);
    expect(trackerSteps(after, NOW, fmt).find((s) => s.key === 'relay')!.state).toBe('active');
    expect(cancelAction(after)).toBe('Cancel this vote'); // not "Discard"
    // a newer vote of the same masternode does not drop it as "never sent"
    expect(mergeWatched([after], [vote({ signedAt: NOW + 5 }, 3, NOW + 3601)]).find((x) => x.voteHash === after.voteHash)!.status).toBe('queued');
    // the cancel: posted again (idempotent) to learn the id, then cancelled at the relay
    r.log.length = 0;
    const w = await withdrawVote(after, wdDeps);
    expect(w.result).toBe('cancelled');
    expect(r.log).toEqual(['POST /v1/votes', 'POST /v1/votes/cancel', `GET /v1/votes/${w.vote.refs[0]!.id}`]);
    expect([...r.held.values()][0]!.status).toBe('cancelled');
  });

  it('a lost answer (reset) on the first try, then the next try gets the receipt: held, nothing doubled', async () => {
    const r = httpRelay(R1);
    const v = vote();
    r.know(v);
    stubFetch(r);
    r.lose('reset');
    const first = await submitToRelays(v, [R1], sendDeps);
    const second = await submitToRelays(first, [R1], sendDeps);
    expect(second.status).toBe('held');
    expect(second.maybeAt).toBeUndefined();
    expect(second.lastSendError).toBeUndefined();
    expect(r.held.size).toBe(1);
  });

  it('5xx (with or without the relay’s body, a proxy’s 502/504 page) and a timeout: maybe received', async () => {
    const r = httpRelay(R1);
    stubFetch(r);
    for (const l of [{ status: 502, html: '<html>Bad gateway</html>' }, { status: 504, html: '' }, { status: 500, body: { error: 'internal error', code: 'internal' } }, 'timeout'] as const) {
      r.held.clear();
      const v = vote();
      r.know(v);
      r.lose(l);
      const after = await submitToRelays(v, [R1], sendDeps);
      expect(r.held.size).toBe(1);
      expect(after.maybeAt).toEqual([R1]);
      expect(describeVote(after, NOW, fmt).badge).toBe('May be at the relay');
    }
    // the relay's own coded 503 (full, Core down) comes before it stores anything: retried, but not "maybe at the relay"
    r.answer({ status: 503, body: { error: 'the relay holds as many votes as it accepts', code: 'relay-full' } });
    const full = await submitToRelays(vote(), [R1], sendDeps);
    expect(full.status).toBe('queued');
    expect(full.maybeAt).toBeUndefined();
  });

  it('a definitive refusal the relay wrote (4xx with its code) is "not sent"; a 4xx page without one is not definitive', async () => {
    const r = httpRelay(R1);
    stubFetch(r);
    r.answer({ status: 400, body: { error: 'the signature does not recover to the masternode voting key', code: 'bad-signature' } });
    const refused = await submitToRelays(vote(), [R1], sendDeps);
    expect(refused.status).toBe('failed');
    expect(refused.maybeAt).toBeUndefined();
    expect(describeVote(refused, NOW, fmt).line).toMatch(/^Not sent: gov-relay-testnet\.dashhq\.org refused it/);
    r.answer({ status: 429, body: { error: 'too many requests, slow down', code: 'rate-limited' } });
    const limited = await submitToRelays(vote(), [R1], sendDeps);
    expect(limited).toMatchObject({ status: 'queued' });
    expect(limited.maybeAt).toBeUndefined();
    expect(describeVote(limited, NOW, fmt).badge).toBe('Not sent yet');
    expect(cancelAction(limited)).toBe('Discard');
    // a proxy's 403 page (no relay code): the relay may have seen it
    r.answer({ status: 403, html: '<html>Forbidden</html>' });
    expect((await submitToRelays(vote(), [R1], sendDeps)).maybeAt).toEqual([R1]);
  });

  it('a request that was never made (an unusable relay URL) is not sent', async () => {
    const bad = new RelayClient('not a url');
    const e = await bad.submit(vote(), 'testnet').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RelayNotSentError);
    expect(classifySubmitError(e, 'not a url')).not.toHaveProperty('maybeReceived');
  });

  it('one relay loses the answer while another refuses: not "failed" until the first answers; asked again, it has it', async () => {
    const a = httpRelay(R1);
    const b = httpRelay(R2);
    const v = vote();
    a.know(v);
    stubFetch(a, b);
    a.lose('timeout');
    b.answer({ status: 409, body: { error: 'a vote with a later or equal time for this proposal is already held', code: 'later-vote-held' } });
    const first = await submitToRelays(v, [R1, R2], sendDeps);
    expect(first).toMatchObject({ status: 'queued', maybeAt: [R1] });
    expect(sendDue(first, first.nextSendAt!)).toBe(true); // asked again later
    // the next round: R2 refuses again, R1 answers with the receipt of the vote it stored
    b.answer({ status: 409, body: { error: 'later', code: 'later-vote-held' } });
    const second = await submitToRelays(first, [R2, R1], sendDeps);
    expect(second.status).toBe('held');
    expect(second.refs.map((x) => x.relay)).toEqual([R1]);
  });

  it('every relay that may hold it refused in a way that cannot tell: failed, but it keeps where it may be and can be cancelled', async () => {
    const a = httpRelay(R1);
    stubFetch(a);
    const v = { ...vote(), maybeAt: [R1] };
    a.answer({ status: 400, body: { error: 'stale', code: 'stale-vote' } });
    const out = await submitToRelays(v, [R1], sendDeps);
    expect(out).toMatchObject({ status: 'failed', maybeAt: [R1] });
    expect(describeVote(out, NOW, fmt).line).toMatch(/may still hold it from an earlier try whose answer was lost/);
    expect(cancelAction(out)).toBe('Cancel this vote');
    expect(mayBeAtRelay(out)).toBe(true);
  });

  it('a cancel whose relay cannot be reached is kept and retried (never "discarded"); refusals that cannot tell are not retried', async () => {
    const r = httpRelay(R1);
    stubFetch(r);
    const v = { ...vote(), maybeAt: [R1] };
    r.answer({ status: 502, html: '' });
    const w = await withdrawVote(v, wdDeps);
    expect(w).toMatchObject({ result: 'unknown', lost: true });
    expect(w.vote.maybeAt).toEqual([R1]);
    r.answer({ status: 400, body: { error: 'stale', code: 'stale-vote' } });
    expect(await withdrawVote(v, wdDeps)).toMatchObject({ result: 'unknown', lost: false });
    // the retry state: never sent again, never re-broadcast, asked again when due, shown as "Cancelling"
    const pending: WatchedVote = { ...w.vote, status: 'queued', cancelSig: 'c2ln', nextCancelAt: NOW + 5, cancelError: 'no answer from gov-relay-testnet.dashhq.org' };
    expect(sendDue(pending, NOW + 99)).toBe(false);
    expect(cancelDue(pending, NOW)).toBe(false);
    expect(cancelDue(pending, NOW + 5)).toBe(true);
    expect(isOpen(pending)).toBe(true);
    expect(needsRebroadcast({ ...pending, status: 'held', refs: [{ relay: R1, id: '1'.padStart(32, '0') }] }, NOW + 99_999)).toBe(false);
    const view = describeVote(pending, NOW, fmt);
    expect(view.badge).toBe('Cancelling');
    expect(view.line).toMatch(/^Not cancelled yet: no answer from gov-relay-testnet\.dashhq\.org\. .* keeps asking for the cancel while this page is open \(next try at T5\)/);
    expect(cancelAction(pending)).toBe('Try cancelling again');
    expect(neverLeft(pending)).toBe(false);
    // the relay is back: the retry finds the vote and cancels it
    r.held.clear();
    r.know(v);
    const done = await withdrawVote(pending, wdDeps);
    expect(done.result).toBe('cancelled');
    expect([...r.held.values()][0]!.status).toBe('cancelled');
  });

  it('a cancel that reached one relay but not another that may hold the vote is not "Cancelled" yet', () => {
    const ref = { relay: R2, id: '2'.padStart(32, '0') };
    const v: WatchedVote = { ...vote(), status: 'held', refs: [ref], maybeAt: [R1], cancelSig: 'c2ln' };
    const st: RelayVoteState = { id: ref.id, voteHash: v.voteHash, status: 'cancelled', releaseAt: v.releaseAt, broadcastAt: null, confirmedAt: null, lastError: null, nextAttemptAt: null, holdReason: null, sameAsCurrent: false, maybeSent: false };
    const after = applyRelayState(v, R2, st);
    expect(after.status).toBe('queued');
    expect(cancelDue(after, NOW)).toBe(true);
    expect(describeVote(after, NOW, fmt).badge).toBe('Cancelling');
    // without a pending cancel elsewhere it is simply cancelled
    expect(applyRelayState({ ...v, maybeAt: undefined }, R2, st).status).toBe('cancelled');
  });

  it('a backup record never wipes where the vote may be or a pending cancel', () => {
    const local: WatchedVote = { ...vote(), status: 'queued', maybeAt: [R1], cancelSig: 'c2ln', nextCancelAt: NOW + 5 };
    const backup: WatchedVote = { ...vote(), status: 'held', refs: [{ relay: R2, id: '2'.padStart(32, '0') }], restored: true };
    expect(keepWhereItMayBe(backup, local)).toMatchObject({ status: 'held', maybeAt: [R1], cancelSig: 'c2ln', nextCancelAt: NOW + 5 });
  });

  it('a restored vote that may be at a relay can be cancelled', () => {
    expect(cancelAction({ ...vote(), maybeAt: [R1], restored: true })).toBe('Cancel this vote');
    expect(cancelAction({ ...vote(), restored: true })).toBeNull();
  });

  it('the re-post that learns the id asks for a long hold, within the relay\'s day after the nTime', async () => {
    const posted: number[] = [];
    const port: RelayPort = {
      submit: async (x) => {
        posted.push(x.releaseAt);
        throw new RelayError('relay x unreachable: Failed to fetch');
      },
      status: async () => null,
      cancel: async () => 'cancelled',
      health: async () => ({ ok: true, checkedAt: 0 }),
    };
    const v = { ...vote({}, 1, NOW), maybeAt: [R1] };
    await withdrawVote(v, { ...wdDeps, relayFor: () => port });
    expect(posted[0]).toBe(NOW + REPOST_HOLD_S);
    await withdrawVote(v, { ...wdDeps, relayFor: () => port, now: () => NOW + 86_000 });
    expect(posted[1]).toBe(NOW + 86_400 - 120);
  });

  it('a relay that is full proves it does not hold the vote (it looks the hash up first)', async () => {
    const r = httpRelay(R1);
    stubFetch(r);
    r.answer({ status: 503, body: { error: 'full', code: 'relay-full' } });
    expect((await withdrawVote({ ...vote(), maybeAt: [R1] }, wdDeps)).result).toBe('gone');
  });
});

describe('B-S1-1: voting again while an older vote may be held', () => {
  it('a new vote never reuses the nTime of an own earlier vote that reached a relay (the hour rule pins it)', () => {
    const T = NOW + 3720;
    const own = [{ ...vote({}, 1, T), status: 'cancelled' as const, refs: [{ relay: R1, id: '1'.padStart(32, '0') }] }, { ...vote({}, 2, T + 1), status: 'held' as const, refs: [{ relay: R1, id: '2'.padStart(32, '0') }] }, { ...vote({}, 3, T + 5), status: 'cancelled' as const }];
    const taken = ownVoteTimes(own);
    expect([...taken.get(currentKey(mn, gov))!]).toEqual([T, T + 1]); // the local-only one never reached a relay
    // the hour rule times the new vote from the masternode's current vote: the same nTime as the cancelled Yes, again
    const cur = new Map([[currentKey(mn, gov), { outcome: 3, time: T - 3720 }]]);
    const planned = planImmediate([{ mn: mn as never, govHash: gov, outcome: 1 }], cur, NOW);
    const pinned = { ...planned, ok: planned.ok.map((p) => ({ ...p, time: T, releaseAt: T - 60 })) };
    const out = untieOwnTimes(pinned, taken, NOW, false);
    expect(out.ok[0]).toMatchObject({ time: T + 2, releaseAt: T + 2 - 60 });
    // no collision: unchanged
    expect(untieOwnTimes(planned, new Map(), NOW, false)).toEqual(planned);
  });
});

