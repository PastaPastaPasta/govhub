// Broadcaster / confirmer / purge against the fake Core, driven tick by tick on a fake clock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreRpcError } from '../src/core/rpc.ts';
import { log } from '../src/log.ts';
import { T0, World, type Mn } from './world.ts';

const world = (env: Record<string, string> = {}) => new World('testnet', env);
const rpcErr = (msg: string, code = -32603) => new CoreRpcError('voteraw', code, msg);
const key = (m: Mn, gov: string) => `${m.txid}-${m.n}|${gov}|1`;

describe('voteraw outcomes', () => {
  it('too often: waits an hour and a half minute, not counted as a failure', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    // the operator voted directly just now
    w.core.votes.set(key(mn, gov), { hash: 'aa'.repeat(32), time: T0 - 100, outcome: 2, signal: 1, txid: mn.txid, n: mn.n, lastUpdate: T0 });
    const { id } = await w.submit(mn, { govHash: gov });

    await w.broadcaster.tickBroadcast();
    expect(w.row(id)).toMatchObject({ status: 'held', last_error: 'too-often', attempts: 0, fail_n: 0, next_attempt_at: T0 + 3630 });
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(1);

    w.clock.advance(3629);
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(1);
    w.clock.advance(1);
    await w.broadcaster.tickBroadcast();
    expect(w.row(id)).toMatchObject({ status: 'broadcast', attempts: 1, last_error: null });
  });

  it('obsolete vote: failed, never retried', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    w.core.votes.set(key(mn, gov), { hash: 'aa'.repeat(32), time: T0 + 500, outcome: 2, signal: 1, txid: mn.txid, n: mn.n, lastUpdate: T0 - 99999 });
    // the submit-time check would refuse this (newer-vote-in-core); with getcurrentvotes failing the relay accepts and voteraw decides
    w.core.currentVotesError = new CoreRpcError('gobject', -32603, 'boom');
    const { id } = await w.submit(mn, { govHash: gov });
    w.core.currentVotesError = null;
    await w.broadcaster.tickBroadcast();
    expect(w.row(id)).toMatchObject({ status: 'failed', last_error: 'obsolete', finished_at: T0 });
    w.clock.advance(7200);
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(1);
    expect((await w.get(`/v1/votes/${id}`)).body).toMatchObject({ status: 'failed', lastError: 'obsolete' });
  });

  it('maps Core errors to terminal codes', async () => {
    const w = world();
    const cases: Array<[string, string]> = [
      ['Failure to find masternode in list : abc-0', 'mn-not-valid'],
      ['Failure to verify vote.', 'bad-signature'],
      ['Error voting : CGovernanceObject::ProcessVote -- Obsolete vote', 'obsolete'],
    ];
    const mns = cases.map(() => w.mn()); // register before the first request: a miss refreshes the list at most every 10 s
    for (const [i, [msg, code]] of cases.entries()) {
      const mn = mns[i]!;
      const gov = w.proposal();
      const { id } = await w.submit(mn, { govHash: gov });
      w.core.voterawErrors.push(rpcErr(msg));
      await w.broadcaster.tickBroadcast();
      expect(w.row(id)).toMatchObject({ status: 'failed', last_error: code });
    }
  });

  it('re-checks the masternode before sending: gone and banned votes fail', async () => {
    const w = world();
    const gone = w.mn();
    const banned = w.mn();
    const gov = w.proposal();
    const a = await w.submit(gone, { govHash: gov, time: T0 + 1800 });
    const b = await w.submit(banned, { govHash: gov, time: T0 + 1800 });
    w.core.mns.delete(`${gone.txid}-${gone.n}`);
    w.core.mns.get(`${banned.txid}-${banned.n}`)!.banned = true;
    w.clock.advance(1800);
    await w.broadcaster.tickBroadcast();
    expect(w.row(a.id)).toMatchObject({ status: 'failed', last_error: 'mn-gone' });
    expect(w.row(b.id)).toMatchObject({ status: 'failed', last_error: 'mn-banned' });
    expect(w.core.count('voteraw')).toBe(0);
  });

  it('unknown proposal: retries 60 s, 120 s, 240 s ... and gives up 6 h after the release', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id } = await w.submit(mn, { govHash: gov });
    w.core.gobjects.delete(gov);

    await w.broadcaster.tickBroadcast();
    expect(w.row(id)).toMatchObject({ status: 'held', last_error: 'unknown-proposal', next_attempt_at: T0 + 60, attempts: 1 });
    w.clock.advance(60);
    await w.broadcaster.tickBroadcast();
    expect(w.row(id).next_attempt_at).toBe(T0 + 60 + 120);
    w.clock.advance(120);
    await w.broadcaster.tickBroadcast();
    expect(w.row(id).next_attempt_at).toBe(T0 + 180 + 240);

    w.clock.advance(6 * 3600);
    await w.broadcaster.tickBroadcast();
    expect(w.row(id)).toMatchObject({ status: 'failed', last_error: 'unknown-proposal' });
  });

  it('proposal appearing late: the held vote goes out on a retry', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id } = await w.submit(mn, { govHash: gov });
    w.core.gobjects.delete(gov);
    await w.broadcaster.tickBroadcast();
    w.core.gobjects.set(gov, { ObjectType: 1 });
    w.clock.advance(60);
    await w.broadcaster.tickBroadcast();
    expect(w.row(id)).toMatchObject({ status: 'broadcast', last_error: null, fail_n: 0 });
  });

  it('transport errors: backoff 30 s, 60 s, 120 s, then success; an unanswered voteraw leaves the vote maybe-broadcast', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id } = await w.submit(mn, { govHash: gov });
    w.core.voterawErrors.push(new Error('fetch failed'), new Error('HTTP 502 bad gateway'), new CoreRpcError('voteraw', -28, 'Loading block index...'));

    await w.broadcaster.tickBroadcast();
    // no answer: Core may have it, so it waits as maybe-broadcast (never cancellable again), not as held
    expect(w.row(id)).toMatchObject({ status: 'maybe-broadcast', maybe_sent: 1, last_error: 'core-error', next_attempt_at: T0 + 30, attempts: 1 });
    await w.broadcaster.tickBroadcast(); // not due yet
    expect(w.core.count('voteraw')).toBe(1);
    w.clock.advance(30);
    await w.broadcaster.tickBroadcast();
    expect(w.row(id).next_attempt_at).toBe(T0 + 30 + 60);
    w.clock.advance(60);
    await w.broadcaster.tickBroadcast();
    expect(w.row(id).next_attempt_at).toBe(T0 + 90 + 120);
    w.clock.advance(120);
    await w.broadcaster.tickBroadcast();
    expect(w.row(id)).toMatchObject({ status: 'broadcast', attempts: 4, fail_n: 0, last_error: null });
  });

  it('transport errors: backoff is capped at 30 min and the vote fails after 50 attempts', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id } = await w.submit(mn, { govHash: gov });
    w.core.voterawErrors.push(...Array.from({ length: 60 }, () => new Error('fetch failed')));
    const gaps: number[] = [];
    for (let i = 1; i <= 49; i++) {
      await w.broadcaster.tickBroadcast();
      const r = w.row(id);
      expect(r.status).toBe('maybe-broadcast');
      expect(r.attempts).toBe(i);
      gaps.push(r.next_attempt_at - w.clock.t);
      w.clock.t = r.next_attempt_at;
    }
    expect(gaps.slice(0, 7)).toEqual([30, 60, 120, 240, 480, 960, 1800]);
    expect(new Set(gaps.slice(6))).toEqual(new Set([1800]));
    await w.broadcaster.tickBroadcast();
    expect(w.row(id)).toMatchObject({ status: 'failed', last_error: 'core-error', attempts: 50 });
  });

  it('keeps outpoints, vote hashes and Core messages out of the logs', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => (lines.push(String(s)), true)) as never);
    log.setLevel('warn');
    try {
      const w = world();
      const mn = w.mn();
      const gov = w.proposal();
      const a = await w.submit(mn, { govHash: gov });
      w.core.voterawErrors.push(new Error('fetch failed'), rpcErr(`Error voting : Obsolete vote ${mn.txid}-0 ${gov}`));
      await w.broadcaster.tickBroadcast();
      w.clock.advance(30);
      await w.broadcaster.tickBroadcast();
      const out = lines.join('');
      expect(out).toContain(a.id);
      for (const secret of [mn.txid, gov, a.voteHash]) expect(out).not.toContain(secret);
      expect(w.row(a.id).last_error).toBe('obsolete');
    } finally {
      log.setLevel('error');
      spy.mockRestore();
    }
  });
});

describe('Core rules', () => {
  it('one change per hour: a second vote of the same masternode on the same proposal waits for 1 h + 30 s', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const a = await w.submit(mn, { govHash: gov, outcome: 'yes' });
    await w.broadcaster.tickBroadcast();
    expect(w.row(a.id).status).toBe('broadcast');

    w.clock.advance(10);
    const b = await w.submit(mn, { govHash: gov, outcome: 'no', time: T0 + 10 });
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(1); // not even tried: Core would have said "voting too often"
    expect(w.row(b.id)).toMatchObject({ status: 'held', next_attempt_at: T0 + 3630, last_error: 'hour-rule', attempts: 0 });
    // the client is told why, and until when, in plain terms
    expect((await w.get(`/v1/votes/${b.id}`)).body).toMatchObject({ status: 'held', holdReason: 'one-change-per-hour', nextAttemptAt: T0 + 3630 });

    w.clock.t = T0 + 3629;
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(1);
    w.clock.t = T0 + 3630;
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(2);
    expect(w.row(b.id).status).toBe('broadcast');
    expect(w.core.votes.get(key(mn, gov))!.outcome).toBe(2);

    // the confirmer sees that B replaced A
    await w.broadcaster.tickConfirm();
    expect(w.row(a.id).status).toBe('superseded');
    expect(w.row(b.id).status).toBe('confirmed');
  });

  it('other proposals and other masternodes are not delayed by the rule', async () => {
    const w = world();
    const mn = w.mn();
    const mn2 = w.mn();
    const g1 = w.proposal();
    const g2 = w.proposal();
    await w.submit(mn, { govHash: g1 });
    await w.submit(mn, { govHash: g2 });
    await w.submit(mn2, { govHash: g1 });
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(3);
  });

  it('never sends a vote Core would refuse as too far in the future', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const time = T0 + 3600;
    const id = 'f'.repeat(32);
    w.store.insert({
      id,
      vote_hash: w.voteHashOf(mn, gov, 'yes', time),
      collateral_txid: mn.txid,
      collateral_n: mn.n,
      gov_hash: gov,
      signal: 1,
      outcome: 1,
      time,
      sig_b64: (w.voteBody(mn, { govHash: gov, time }).sig as string),
      release_at: T0,
      received_hour: T0 - (T0 % 3600),
    });
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(0);
    expect(w.row(id)).toMatchObject({ status: 'held', next_attempt_at: time - 3540 });
    w.clock.t = time - 3540;
    await w.broadcaster.tickBroadcast();
    expect(w.row(id).status).toBe('broadcast');
  });

  it('releases in release order, at most 50 per tick', async () => {
    const w = world({ RATE_IP_PER_MIN: '1000', RATE_MN_PER_HOUR: '1000', MAX_HELD_PER_MN: '1000' });
    const mn = w.mn();
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) ids.push((await w.submit(mn, { govHash: w.proposal() })).id);
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(50);
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(52);
  });
});

describe('confirmer', () => {
  it('confirms a vote that shows up in getcurrentvotes (vout is passed as a string)', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id } = await w.submit(mn, { govHash: gov });
    await w.broadcaster.tickBroadcast();
    w.clock.advance(5);
    await w.broadcaster.tickConfirm();
    expect(w.row(id)).toMatchObject({ status: 'confirmed', confirmed_at: T0 + 5, finished_at: T0 + 5 });
    expect(w.core.calls.find((c) => c.params[0] === 'getcurrentvotes')!.params).toEqual(['getcurrentvotes', gov, mn.txid, '0']);
  });

  it('marks a vote superseded when the masternode has a later funding vote', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id } = await w.submit(mn, { govHash: gov });
    await w.broadcaster.tickBroadcast();
    w.core.votes.set(key(mn, gov), { hash: 'cc'.repeat(32), time: T0 + 900, outcome: 2, signal: 1, txid: mn.txid, n: mn.n, lastUpdate: T0 + 900 });
    w.clock.advance(60);
    await w.broadcaster.tickConfirm();
    expect(w.row(id)).toMatchObject({ status: 'superseded', finished_at: T0 + 60 });
  });

  it('leaves a vote alone while Core cannot be asked', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id } = await w.submit(mn, { govHash: gov });
    await w.broadcaster.tickBroadcast();
    w.core.down = true;
    w.clock.advance(5000);
    await w.broadcaster.tickConfirm();
    expect(w.row(id).status).toBe('broadcast');
  });

  it('re-broadcasts a vote that never shows up, at most 3 times, then fails as unconfirmed', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id } = await w.submit(mn, { govHash: gov });
    w.core.blackhole = true;
    await w.broadcaster.tickBroadcast();
    expect(w.row(id).status).toBe('broadcast');

    w.clock.advance(599);
    await w.broadcaster.tickConfirm();
    expect(w.row(id).status).toBe('broadcast'); // CONFIRM_TIMEOUT_S not reached

    for (let n = 1; n <= 3; n++) {
      w.clock.t = w.row(id).broadcast_at! + 600;
      await w.broadcaster.tickConfirm();
      expect(w.row(id)).toMatchObject({ status: 'maybe-broadcast', rebroadcasts: n });
      await w.broadcaster.tickBroadcast();
      expect(w.row(id)).toMatchObject({ status: 'broadcast', attempts: n + 1, broadcast_at: w.clock.t });
    }
    expect(w.core.count('voteraw')).toBe(4);
    w.clock.t = w.row(id).broadcast_at! + 600;
    await w.broadcaster.tickConfirm();
    expect(w.row(id)).toMatchObject({ status: 'failed', last_error: 'unconfirmed' });
  });

  it('a re-broadcast that Core now accepts ends up confirmed', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id } = await w.submit(mn, { govHash: gov });
    w.core.blackhole = true;
    await w.broadcaster.tickBroadcast();
    w.clock.advance(600);
    await w.broadcaster.tickConfirm();
    w.core.blackhole = false;
    await w.broadcaster.tickBroadcast();
    await w.broadcaster.tickConfirm();
    expect(w.row(id)).toMatchObject({ status: 'confirmed', rebroadcasts: 1 });
  });

  it('a vote waiting for a re-broadcast cannot be cancelled (it may be on the network) but can be replaced', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id, voteHash } = await w.submit(mn, { govHash: gov });
    w.core.blackhole = true;
    await w.broadcaster.tickBroadcast();
    w.clock.advance(600);
    await w.broadcaster.tickConfirm();
    expect(w.row(id).status).toBe('maybe-broadcast');
    const c = await w.post('/v1/votes/cancel', w.cancelBody(mn, id, voteHash));
    expect(c.status).toBe(409);
    expect(c.body).toMatchObject({ code: 'maybe-broadcast', status: 'maybe-broadcast', reason: expect.stringMatching(/cannot be cancelled/) });
    expect(w.row(id).status).toBe('maybe-broadcast'); // never reported or stored as cancelled
    expect((await w.get(`/v1/votes/${id}`)).body).toMatchObject({ status: 'maybe-broadcast', holdReason: 'retrying', nextAttemptAt: w.clock.t });
    // a newer vote replaces it: the older one is never sent again
    w.core.blackhole = false;
    w.clock.advance(3700);
    const newer = await w.submit(mn, { govHash: gov, time: w.clock.t, outcome: 'no' });
    await w.broadcaster.tickBroadcast();
    expect(w.row(id).status).toBe('superseded');
    expect(w.row(newer.id).status).toBe('broadcast');
  });
});

describe('scheduler and purge', () => {
  it('tick() releases, then confirms (every 30 s) and purges (hourly)', async () => {
    const w = world();
    const mn = w.mn();
    const mn2 = w.mn();
    const gov = w.proposal();
    const { id } = await w.submit(mn, { govHash: gov });
    await w.broadcaster.tick();
    expect(w.row(id).status).toBe('confirmed');

    const g2 = w.proposal();
    const b = await w.submit(mn2, { govHash: g2, time: w.clock.t });
    w.core.blackhole = true;
    await w.broadcaster.tick(); // broadcast; the confirmer ran < 30 s ago
    w.clock.advance(10);
    await w.broadcaster.tick();
    expect(w.row(b.id).status).toBe('broadcast');
    w.core.blackhole = false;
    w.core.votes.set(key(mn2, g2), { hash: w.voteHashOf(mn2, g2, 'yes', T0), time: T0, outcome: 1, signal: 1, txid: mn2.txid, n: mn2.n, lastUpdate: T0 });
    w.clock.advance(25);
    await w.broadcaster.tick();
    expect(w.row(b.id).status).toBe('confirmed');
  });

  it('purges finished votes after RETENTION_DAYS, and last_broadcast rows after 2 h; held votes stay', async () => {
    const w = world();
    const mn = w.mn();
    const g = [w.proposal(), w.proposal(), w.proposal(), w.proposal()] as const;
    const confirmed = await w.submit(mn, { govHash: g[0] });
    await w.broadcaster.tickBroadcast();
    await w.broadcaster.tickConfirm();
    const cancelled = await w.submit(mn, { govHash: g[1], time: T0 + 1800 });
    await w.post('/v1/votes/cancel', w.cancelBody(mn, cancelled.id, cancelled.voteHash));
    const held = await w.submit(mn, { govHash: g[2], time: T0 + 30 * 86400 });
    expect(w.store.db.prepare('SELECT COUNT(*) n FROM last_broadcast').get()).toEqual({ n: 1 });

    w.clock.advance(3 * 3600);
    expect(w.broadcaster.tickPurge()).toEqual({ votes: 0, lastBroadcast: 1, proposals: 0 });

    w.clock.t = T0 + 6 * 86400;
    const recent = await w.submit(mn, { govHash: g[3], time: w.clock.t + 1800 });
    await w.post('/v1/votes/cancel', w.cancelBody(mn, recent.id, recent.voteHash));

    w.clock.t = T0 + 7 * 86400;
    expect(w.broadcaster.tickPurge().votes).toBe(0); // finished_at == now - 7 d exactly: kept
    w.clock.t = T0 + 7 * 86400 + 1;
    expect(w.broadcaster.tickPurge().votes).toBe(2);
    expect(w.store.get(confirmed.id)).toBeUndefined();
    expect(w.store.get(cancelled.id)).toBeUndefined();
    expect(w.store.get(recent.id)?.status).toBe('cancelled');
    expect(w.store.get(held.id)?.status).toBe('held');
    // purged ids behave like unknown ones
    expect((await w.get(`/v1/votes/${confirmed.id}`)).status).toBe(404);
  });

  it('start() and stop() wire a timer without leaking it', () => {
    const w = world();
    expect(() => {
      w.broadcaster.start();
      w.broadcaster.start();
      w.broadcaster.stop();
      w.broadcaster.stop();
    }).not.toThrow();
  });
});
