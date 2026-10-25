// The vote status model: storage migration, what each state says, the tracker, relay answers, submission errors.
import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@govhub/verify';
import { bridgeVerdict, isOpen, loadWatched, mergeWatched, migrateV1, saveWatched, sendDue, sendRetryDelay, type WatchedVote } from './pending.ts';
import { signPlanned } from './plan.ts';
import { RelayError, type RelayVoteState } from './relay.ts';
import { applyRelayState, classifySubmitError, deferredUnavailable, describeVote, holdText, trackerSteps, voteButtonText } from './status.ts';

const priv = hexToBytes('22'.repeat(32));
const mn = { proTxHash: 'aa'.repeat(32), collateralTxid: 'bb'.repeat(32), collateralIndex: 62 };
const gov = 'cc'.repeat(32);
const NOW = 1_792_875_000;
const R1 = 'https://gov-relay-testnet.dashhq.org';
const R2 = 'https://relay-two.example';
const fmt = (s: number) => `T${s - NOW}`;
const signed = (outcome: 1 | 2 | 3, time: number) => signPlanned({ mn, govHash: gov, outcome, time, releaseAt: time, notes: [] }, priv, true, 'testnet');
const vote = (over: Partial<WatchedVote> = {}, outcome: 1 | 2 | 3 = 2, time = NOW): WatchedVote => ({ ...signed(outcome, time), refs: [], status: 'queued', rebroadcasts: 0, signedAt: time, ...over });
const relayState = (over: Partial<RelayVoteState> = {}): RelayVoteState => ({
  id: 'ab'.repeat(16),
  voteHash: 'cd'.repeat(32),
  status: 'held',
  releaseAt: NOW,
  broadcastAt: null,
  confirmedAt: null,
  lastError: null,
  nextAttemptAt: NOW,
  holdReason: 'release-time',
  sameAsCurrent: false,
  maybeSent: null,
  ...over,
});

class MemStorage {
  m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}

describe('storage migration (v1 -> v2)', () => {
  it('the owner’s case: a never-sent Yes marked superseded and a never-sent No marked held', () => {
    const yes = { ...signed(1, NOW - 3660), refs: [], status: 'superseded', rebroadcasts: 0 };
    const no = { ...signed(2, NOW), refs: [], status: 'held', rebroadcasts: 0 };
    const [y, n] = migrateV1([yes, no]);
    // the newer No is still queued and will be sent; the Yes never left and is dropped, not "superseded"
    expect(n).toMatchObject({ status: 'queued', voteHash: no.voteHash });
    expect(y).toMatchObject({ status: 'dropped', replacedBy: no.voteHash });
  });
  it('keeps what relays hold, and never drops a queued vote that has no newer one', () => {
    const held = { ...signed(1, NOW), refs: [{ relay: R1, id: 'ab'.repeat(16) }], status: 'held', rebroadcasts: 0 };
    const lone = { ...signed(3, NOW), govHash: 'dd'.repeat(32), refs: [], status: 'superseded', rebroadcasts: 0 };
    const out = migrateV1([held, lone]);
    expect(out[0]!.status).toBe('held');
    expect(out[1]!.status).toBe('queued');
    const sentThenSuperseded = { ...signed(1, NOW), refs: [{ relay: R1, id: 'ab'.repeat(16) }], status: 'superseded', rebroadcasts: 0 };
    expect(migrateV1([sentThenSuperseded])[0]).toMatchObject({ status: 'replaced', replacedBy: '' });
    for (const s of ['broadcast', 'confirmed', 'failed', 'cancelled']) expect(migrateV1([{ ...held, status: s }])[0]!.status).toBe(s);
  });
  it('signing order, not nTime, decides which never-sent vote the user wanted', () => {
    // signed second but with the earlier nTime (the first one was an hour-rule or deferred vote)
    const first = { ...signed(1, NOW + 3720), refs: [], status: 'held', rebroadcasts: 0 };
    const second = { ...signed(2, NOW + 600), refs: [], status: 'held', rebroadcasts: 0 };
    const [a, b] = migrateV1([first, second]);
    expect(b!.status).toBe('queued');
    expect(a).toMatchObject({ status: 'dropped', replacedBy: second.voteHash });
  });
  it('merges v1 records a tab of the old version wrote next to v2', () => {
    const st = new MemStorage();
    const kept = vote({}, 1, NOW);
    st.setItem('govhub.votes.v2.testnet.id1', JSON.stringify([kept]));
    const late = { ...signed(3, NOW), govHash: 'dd'.repeat(32), refs: [], status: 'held', rebroadcasts: 0 };
    st.setItem('govhub.votes.v1.testnet.id1', JSON.stringify([late, { ...kept, status: 'held' }]));
    const all = loadWatched(st, 'testnet', 'id1');
    expect(all.map((v) => v.voteHash).sort()).toEqual([kept.voteHash, late.voteHash].sort());
    expect(all.find((v) => v.voteHash === kept.voteHash)!.status).toBe('queued'); // v2's record wins
  });
  it('never stores votes signed with a memory-only keyring', () => {
    const st = new MemStorage();
    saveWatched(st, 'testnet', 'id1', [vote({ ephemeral: true })]);
    expect(st.getItem('govhub.votes.v2.testnet.id1')).toBeNull();
  });
  it('reads v1 when there is no v2, writes v2 and only then removes v1', () => {
    const st = new MemStorage();
    const v1 = [{ ...signed(2, NOW), refs: [], status: 'held', rebroadcasts: 0 }];
    st.setItem('govhub.votes.v1.testnet.id1', JSON.stringify(v1));
    const loaded = loadWatched(st, 'testnet', 'id1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.status).toBe('queued');
    expect(st.getItem('govhub.votes.v1.testnet.id1')).not.toBeNull(); // nothing removed by a read
    saveWatched(st, 'testnet', 'id1', loaded);
    expect(st.getItem('govhub.votes.v1.testnet.id1')).toBeNull();
    expect(loadWatched(st, 'testnet', 'id1')).toEqual(loaded);
  });
  it('a failed v2 write leaves v1 in place', () => {
    const st = new MemStorage();
    st.setItem('govhub.votes.v1.testnet.id1', '[]');
    const failing = { ...st, setItem: () => { throw new Error('quota'); }, removeItem: st.removeItem };
    expect(() => saveWatched(failing, 'testnet', 'id1', [vote()])).toThrow('quota');
    expect(st.getItem('govhub.votes.v1.testnet.id1')).toBe('[]');
  });
});

describe('replacing votes', () => {
  it('a newer vote only drops an older one that never left; one that left waits for the bridge', () => {
    const old = vote({}, 1, NOW - 100);
    const newer = vote({}, 2, NOW);
    expect(mergeWatched([old], [newer]).find((x) => x.voteHash === old.voteHash)).toMatchObject({ status: 'dropped', replacedBy: newer.voteHash });
    const sent = { ...old, status: 'broadcast' as const, refs: [{ relay: R1, id: 'ab'.repeat(16) }] };
    expect(mergeWatched([sent], [newer]).find((x) => x.voteHash === old.voteHash)!.status).toBe('broadcast');
    // another masternode or another proposal is never touched
    const other = { ...vote({}, 1, NOW - 100), govHash: 'ee'.repeat(32) };
    expect(mergeWatched([other], [newer])[0]!.status).toBe('queued');
    // signed earlier but timed later (deferred / hour rule): still dropped by the vote signed after it
    const deferred = vote({ signedAt: NOW - 50 }, 1, NOW + 86400);
    const now = vote({ signedAt: NOW }, 2, NOW);
    expect(mergeWatched([deferred], [now]).find((x) => x.voteHash === deferred.voteHash)!.status).toBe('dropped');
  });
  it('replaced only when the newer vote wins in the bridge (Core keeps the latest nTime)', () => {
    const old = vote({ status: 'broadcast', refs: [{ relay: R1, id: 'ab'.repeat(16) }] }, 1, NOW - 100);
    const mine = vote({ status: 'broadcast', refs: [{ relay: R1, id: 'ef'.repeat(16) }] }, 2, NOW);
    expect(bridgeVerdict(old, { outcome: 1, time: NOW - 100 }, [old, mine])).toEqual({ status: 'confirmed' });
    expect(bridgeVerdict(old, { outcome: 2, time: NOW }, [old, mine])).toEqual({ status: 'replaced', replacedBy: mine.voteHash });
    expect(bridgeVerdict(old, { outcome: 3, time: NOW + 5 }, [old, mine])).toEqual({ status: 'replaced', replacedBy: '' });
    expect(bridgeVerdict(old, { outcome: 2, time: NOW - 500 }, [old])).toBeNull(); // an older current vote: ours has not arrived yet
    // a vote that never left is never "replaced" or "confirmed" by the bridge
    expect(bridgeVerdict(vote({}, 1, NOW - 100), { outcome: 2, time: NOW })).toBeNull();
  });
});

describe('what each state says', () => {
  it('queued: sending, then the reason and the next try', () => {
    expect(describeVote(vote(), NOW, fmt)).toMatchObject({ badge: 'Sending', tone: 'progress' });
    const failed = vote({ lastSendError: 'gov-relay-testnet.dashhq.org is unreachable', nextSendAt: NOW + 20 });
    const d = describeVote(failed, NOW, fmt);
    expect(d).toMatchObject({ badge: 'Not sent yet', tone: 'bad' });
    expect(d.line).toBe('Not accepted by a relay yet: gov-relay-testnet.dashhq.org is unreachable. Kept in this browser. Trying again at T20.');
    expect(describeVote({ ...failed, restored: true }, NOW, fmt).badge).toBe('Signed elsewhere');
  });
  it('held: by which relay, until when, and why', () => {
    const h = applyRelayState(vote(), R1, relayState({ releaseAt: NOW + 600, nextAttemptAt: NOW + 600 }));
    expect(describeVote(h, NOW, fmt)).toEqual({ badge: 'Held by relay', tone: 'wait', line: 'Held by gov-relay-testnet.dashhq.org until T600.' });
    const hour = applyRelayState(vote(), R1, relayState({ holdReason: 'one-change-per-hour', nextAttemptAt: NOW + 3560, lastError: 'hour-rule', sameAsCurrent: true }));
    expect(holdText(hour, NOW, fmt)).toBe('Core allows one vote change per hour per masternode; gov-relay-testnet.dashhq.org sends this at T3560. It repeats the masternode’s current vote, so it only updates the timestamp.');
    expect(holdText(applyRelayState(vote(), R1, relayState()), NOW, fmt)).toBe('Accepted by gov-relay-testnet.dashhq.org, going out now.');
    // planned an hour after the current vote: the relay only knows a release time, the reason comes from the plan
    const planned = applyRelayState(vote({ hourRule: true }), R1, relayState({ releaseAt: NOW + 3660, nextAttemptAt: NOW + 3660 }));
    expect(holdText(planned, NOW, fmt)).toBe('Core allows one vote change per hour per masternode; gov-relay-testnet.dashhq.org sends this at T3660.');
  });
  it('the rest', () => {
    expect(describeVote(vote({ status: 'confirmed' }), NOW, fmt).badge).toBe('Bridge: on the network');
    expect(describeVote(vote({ status: 'confirmed', countedAt: NOW }), NOW, fmt).badge).toBe('Bridge: counted');
    // confirmed is the bridge's report: the line says so, and names any other configured source that agrees
    expect(describeVote(vote({ status: 'confirmed', countedAt: NOW }), NOW, fmt).line).toMatch(/^The bridge reports the network counted it.*That is the bridge’s word/);
    const agreed = describeVote(vote({ status: 'confirmed', alsoSeenBy: ['b2.example'], relayStatus: { 'https://relay-one.example': 'confirmed' } }), NOW, fmt).line;
    expect(agreed).toContain('Also seen by bridge b2.example (its vote set has it, checked here) and relay relay-one.example (it reports its Dash Core node lists it).');
    expect(agreed).not.toContain('bridge’s word');
    expect(agreed).toContain('To be sure, check your own Dash Core node.');
    expect(describeVote(vote({ status: 'failed', failReason: 'gov-relay-testnet.dashhq.org refused it: the masternode is PoSe-banned' }), NOW, fmt).line).toBe('Not sent: gov-relay-testnet.dashhq.org refused it: the masternode is PoSe-banned.');
    expect(describeVote(vote({ status: 'dropped' }), NOW, fmt)).toMatchObject({ badge: 'Not sent', line: 'Never sent: you replaced it with a newer vote before it left this browser.' });
    expect(describeVote(vote({ status: 'replaced', replacedBy: 'x' }), NOW, fmt).line).toMatch(/your newer vote/);
    expect(describeVote(vote({ status: 'replaced', replacedBy: '' }), NOW, fmt).line).toMatch(/not cast in this browser/);
  });
});

describe('tracker', () => {
  const states = (v: WatchedVote) => trackerSteps(v, NOW, fmt).map((s) => s.state);
  it('moves one step at a time', () => {
    expect(states(vote())).toEqual(['done', 'active', 'todo', 'todo', 'todo']);
    const held = applyRelayState(vote(), R1, relayState({ releaseAt: NOW + 600, nextAttemptAt: NOW + 600 }));
    expect(states(held)).toEqual(['done', 'done', 'active', 'todo', 'todo']);
    const out = applyRelayState(held, R1, relayState({ status: 'broadcast', broadcastAt: NOW + 1 }));
    expect(out.status).toBe('broadcast');
    expect(states(out)).toEqual(['done', 'done', 'done', 'active', 'todo']);
    const seen = { ...out, status: 'confirmed' as const, seenAt: NOW + 30 };
    expect(states(seen)).toEqual(['done', 'done', 'done', 'done', 'active']);
    expect(states({ ...seen, countedAt: NOW + 40 })).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(trackerSteps(seen, NOW, fmt)[3]!.detail).toBe('T30, signature verified');
  });
  it('a relay vote that may already be in Core (maybe-broadcast) counts as sent, never as held or cancellable', () => {
    const maybe = applyRelayState(vote(), R1, relayState({ status: 'maybe-broadcast', lastError: 'core-error', nextAttemptAt: NOW + 30, holdReason: 'retrying' }));
    expect(maybe.status).toBe('broadcast');
    expect(states(maybe)).toEqual(['done', 'done', 'done', 'active', 'todo']);
  });
  it('a relay that cannot be reached stops at "accepted by relay"; a refusal after the relay took it stops at broadcast', () => {
    expect(states(vote({ lastSendError: 'unreachable', nextSendAt: NOW + 5 }))).toEqual(['done', 'error', 'todo', 'todo', 'todo']);
    const failed = applyRelayState(vote(), R1, relayState({ status: 'failed', lastError: 'obsolete' }));
    expect(failed).toMatchObject({ status: 'failed', failReason: 'Core already has a newer vote from this masternode' });
    expect(states(failed)).toEqual(['done', 'done', 'error', 'todo', 'todo']);
  });
});

describe('relay answers and submission errors', () => {
  it('applies the furthest relay: one broadcast beats one holding', () => {
    let v = applyRelayState(vote(), R1, relayState());
    v = applyRelayState(v, R2, relayState({ id: 'ef'.repeat(16), status: 'broadcast', broadcastAt: NOW }));
    expect(v.status).toBe('broadcast');
    expect(v.refs).toHaveLength(2);
    expect(applyRelayState({ ...v, status: 'confirmed' }, R1, relayState({ status: 'failed' })).status).toBe('confirmed'); // the bridge decided
  });
  it('maps refusals to plain outcomes', () => {
    expect(classifySubmitError(new RelayError(`relay ${R1} unreachable: Load failed`), R1)).toMatchObject({ kind: 'retry', text: 'gov-relay-testnet.dashhq.org is unreachable', tryOther: true });
    expect(classifySubmitError(new RelayError('slow down', 429, 'rate-limited', undefined, 40), R1)).toMatchObject({ kind: 'retry', afterS: 40 });
    expect(classifySubmitError(new RelayError('full', 503, 'relay-full'), R1)).toMatchObject({ kind: 'retry', tryOther: true });
    expect(classifySubmitError(new RelayError('have it', 409, 'already-current'), R1).kind).toBe('sent');
    expect(classifySubmitError(new RelayError('newer', 409, 'newer-vote-in-core'), R1)).toMatchObject({ kind: 'final', status: 'replaced' });
    expect(classifySubmitError(new RelayError('later', 409, 'later-vote-held'), R1)).toMatchObject({ kind: 'final', status: 'failed' });
    // one relay's view lags: try the other one
    expect(classifySubmitError(new RelayError('Core does not know this governance object', 404, 'unknown-proposal'), R1)).toMatchObject({ kind: 'retry', tryOther: true });
    expect(classifySubmitError(new RelayError(`relay ${R1} unreachable: signal timed out`), R1)).toMatchObject({ kind: 'retry', maybeReceived: true, text: 'gov-relay-testnet.dashhq.org did not answer in time' });
    expect(classifySubmitError(new RelayError('the masternode is PoSe-banned', 409, 'mn-banned'), R1)).toMatchObject({ kind: 'final', status: 'failed', text: 'gov-relay-testnet.dashhq.org refused it: the masternode is PoSe-banned' });
  });
  it('retries queued votes with backoff, never restored ones', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(sendRetryDelay)).toEqual([5, 10, 20, 40, 80, 160, 300, 300]);
    expect(sendDue(vote({ nextSendAt: NOW + 5 }), NOW)).toBe(false);
    expect(sendDue(vote({ nextSendAt: NOW }), NOW)).toBe(true);
    expect(sendDue(vote({ restored: true }), NOW)).toBe(false);
    expect(isOpen(vote())).toBe(true);
    expect(isOpen(vote({ status: 'dropped' }))).toBe(false);
  });
});

describe('composer words', () => {
  it('button and timing', () => {
    expect(voteButtonText(2, 1, false)).toBe('Vote No with 1 masternode');
    expect(voteButtonText(1, 3, true)).toBe('Schedule Yes with 3 masternodes');
    expect(voteButtonText(0, 1, false)).toBe('Choose Yes, No or Abstain');
    expect(deferredUnavailable(NOW + 9 * 60, NOW, 'testnet')).toBe('Voting closes in 9 min, too soon to spread votes out (the last 10 min are kept free); testnet superblocks are hourly.');
    expect(deferredUnavailable(null, NOW, 'testnet')).toMatch(/not known yet/);
    expect(deferredUnavailable(NOW - 5, NOW, 'mainnet')).toMatch(/has closed/);
    expect(deferredUnavailable(NOW + 5 * 86400, NOW, 'mainnet')).toBeNull();
  });
});
