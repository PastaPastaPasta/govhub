// Security review fixes: H3 (replayed public votes), M5 (cancel vs in-flight voteraw), L3 (client IP bucketing).
import { describe, expect, it, vi } from 'vitest';
import { isKnownVote } from '../src/broadcaster.ts';
import { ipBucket, peerTrust, resolveClientIp, validateProxyList } from '../src/clientip.ts';
import { loadConfig } from '../src/config.ts';
import { CoreRpcError } from '../src/core/rpc.ts';
import { Broadcaster } from '../src/broadcaster.ts';
import { T0, World } from './world.ts';

const world = (env: Record<string, string> = {}) => new World('testnet', env);
const rpcErr = (msg: string) => new CoreRpcError('voteraw', -32603, msg);
const getCurrentVotesCalls = (w: World) => w.core.calls.filter((c) => c.method === 'gobject' && c.params[0] === 'getcurrentvotes');

describe('H3: replayed public votes', () => {
  it('refuses a vote older than MAX_PAST_S (stale-vote) before asking Core anything', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const r = await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, time: T0 - 86401 }));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('stale-vote');
    expect(w.core.calls.length).toBe(0);
    expect((await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, time: T0 - 86400 }))).status).toBe(202);

    const tight = world({ MAX_PAST_S: '600' });
    const m2 = tight.mn();
    const g2 = tight.proposal();
    expect((await tight.post('/v1/votes', tight.voteBody(m2, { govHash: g2, time: T0 - 601 }))).body.code).toBe('stale-vote');
    expect((await tight.post('/v1/votes', tight.voteBody(m2, { govHash: g2, time: T0 - 600 }))).status).toBe(202);
  });

  it('409 already-current when Core has this vote: nothing stored, no slot or hourly count used', async () => {
    const w = world({ RATE_MN_PER_HOUR: '1', MAX_HELD_PER_MN: '1' });
    const mn = w.mn();
    const gov = w.proposal();
    w.core.addCurrentVote(mn, gov, 'yes', T0);
    for (let i = 0; i < 3; i++) {
      const r = await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, time: T0, outcome: 'yes' }));
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('already-current');
    }
    expect(w.store.countHeld()).toBe(0);
    expect(w.store.db.prepare('SELECT COUNT(*) n FROM votes').get()).toEqual({ n: 0 });
    expect(getCurrentVotesCalls(w)[0]!.params).toEqual(['getcurrentvotes', gov, mn.txid, '0']); // vout is a string
    // the masternode still has its whole hourly allowance and its held slot
    expect((await w.post('/v1/votes', w.voteBody(mn, { govHash: w.proposal(), time: T0 }))).status).toBe(202);
  });

  it('409 newer-vote-in-core when Core has a funding vote of the masternode at or after this time', async () => {
    const w = world({ RATE_MN_PER_HOUR: '1' });
    const mn = w.mn();
    const gov = w.proposal();
    w.core.addCurrentVote(mn, gov, 'yes', T0 + 100);
    for (const [time, outcome] of [[T0, 'yes'], [T0 + 50, 'no'], [T0 + 100, 'no']] as const) {
      const r = await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, time, outcome }));
      expect(r.status, `time ${time - T0}`).toBe(409);
      expect(r.body.code).toBe('newer-vote-in-core');
    }
    expect(w.store.db.prepare('SELECT COUNT(*) n FROM votes').get()).toEqual({ n: 0 });
    // a genuinely newer vote goes through, and was the only one to use the hourly allowance
    expect((await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, time: T0 + 101, outcome: 'no' }))).status).toBe(202);
  });

  it('only this masternode and this proposal count', async () => {
    const w = world();
    const [a, b] = [w.mn(), w.mn()];
    const [g1, g2] = [w.proposal(), w.proposal()];
    w.core.addCurrentVote(a, g1, 'yes', T0 + 100);
    expect((await w.post('/v1/votes', w.voteBody(b, { govHash: g1, time: T0 }))).status).toBe(202);
    expect((await w.post('/v1/votes', w.voteBody(a, { govHash: g2, time: T0 }))).status).toBe(202);
  });

  it('a failing getcurrentvotes never blocks a submission', async () => {
    for (const err of [new CoreRpcError('gobject', -32603, 'boom'), new Error('fetch failed: ECONNREFUSED'), 'not even an error']) {
      const w = world();
      const mn = w.mn();
      const gov = w.proposal();
      w.core.addCurrentVote(mn, gov, 'yes', T0 + 100);
      w.core.currentVotesError = err;
      expect((await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, time: T0 }))).status).toBe(202);
    }
  });

  it('keeps core-unavailable when the checks that need Core fail', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    w.core.down = true;
    const r = await w.post('/v1/votes', w.voteBody(mn, { govHash: gov }));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('core-unavailable');
  });

  it('an exact duplicate is still the idempotent 200, without asking Core again', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const body = w.voteBody(mn, { govHash: gov });
    expect((await w.post('/v1/votes', body)).status).toBe(202);
    const before = getCurrentVotesCalls(w).length;
    expect((await w.post('/v1/votes', body)).status).toBe(200);
    expect(getCurrentVotesCalls(w).length).toBe(before);
  });

  it('MAX_HELD_TOTAL: 503 relay-full for a new vote, but a replacement still fits', async () => {
    const w = world({ MAX_HELD_TOTAL: '2', RATE_MN_PER_HOUR: '100' });
    const [a, b, c] = [w.mn(), w.mn(), w.mn()];
    const gov = w.proposal();
    const time = T0 + 7200;
    expect((await w.post('/v1/votes', w.voteBody(a, { govHash: gov, time }))).status).toBe(202);
    expect((await w.post('/v1/votes', w.voteBody(b, { govHash: gov, time }))).status).toBe(202);
    const r = await w.post('/v1/votes', w.voteBody(c, { govHash: gov, time }));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('relay-full');
    expect(r.headers.get('retry-after')).toBe('60');
    expect((await w.post('/v1/votes', w.voteBody(a, { govHash: gov, time: time + 1, outcome: 'no' }))).status).toBe(202);
    expect(w.store.countHeld()).toBe(2);
  });

  describe('voteraw says Core already has the vote', () => {
    it.each([['Error voting : '], ['Error voting :'], ['Error voting : CGovernanceObject::ProcessVote -- Already known valid vote']])('%j is not an error', (msg) => {
      expect(isKnownVote(msg)).toBe(true);
    });
    it.each([
      ['Error voting : CGovernanceObject::ProcessVote -- Obsolete vote'],
      ['Error voting : CGovernanceObject::ProcessVote -- Masternode voting too often, MN outpoint = x'],
      ['Failure to verify vote.'],
      ['Governance object not found'],
    ])('%j is something else', (msg) => {
      expect(isKnownVote(msg)).toBe(false);
    });

    it('empty "Error voting : " (the exact hash is known): broadcast, then the confirmer confirms; no core-error retries', async () => {
      const w = world();
      const mn = w.mn();
      const gov = w.proposal();
      w.core.currentVotesError = new Error('down'); // let the submit through although Core has the vote (another relay sent it meanwhile)
      const { id } = await w.submit(mn, { govHash: gov });
      w.core.currentVotesError = null;
      w.core.addCurrentVote(mn, gov, 'yes', T0);
      await w.broadcaster.tickBroadcast();
      expect(w.row(id)).toMatchObject({ status: 'broadcast', fail_n: 0, last_error: null });
      expect(w.core.count('voteraw')).toBe(1);
      await w.broadcaster.tickConfirm();
      expect(w.row(id).status).toBe('confirmed');
    });

    it('"Already known valid vote" with a later vote in Core: broadcast, then superseded', async () => {
      const w = world();
      const mn = w.mn();
      const gov = w.proposal();
      const { id } = await w.submit(mn, { govHash: gov });
      w.core.voterawErrors.push(rpcErr('Error voting : CGovernanceObject::ProcessVote -- Already known valid vote'));
      await w.broadcaster.tickBroadcast();
      expect(w.row(id)).toMatchObject({ status: 'broadcast', fail_n: 0 });
      w.core.addCurrentVote(mn, gov, 'no', T0 + 900);
      w.clock.advance(60);
      await w.broadcaster.tickConfirm();
      expect(w.row(id).status).toBe('superseded');
    });

    it('a known vote that never shows up is re-broadcast and finally fails as unconfirmed, not as core-error', async () => {
      const w = world({ CONFIRM_TIMEOUT_S: '100' });
      const mn = w.mn();
      const gov = w.proposal();
      const { id } = await w.submit(mn, { govHash: gov });
      for (let i = 0; i < 5; i++) w.core.voterawErrors.push(rpcErr('Error voting : '));
      for (let i = 0; i < 20; i++) {
        await w.broadcaster.tickBroadcast();
        w.clock.advance(101);
        await w.broadcaster.tickConfirm();
      }
      expect(w.row(id)).toMatchObject({ status: 'failed', last_error: 'unconfirmed' });
    });
  });

  it('due votes are ordered by next_attempt_at, then release_at, so retries do not starve fresh votes', () => {
    const w = world();
    const mk = (id: string, release_at: number) => ({
      id, vote_hash: id.repeat(64).slice(0, 64), collateral_txid: 'a'.repeat(64), collateral_n: 0, gov_hash: id.repeat(64).slice(0, 64),
      signal: 1, outcome: 1, time: release_at, sig_b64: 'x', release_at, received_hour: 0,
    });
    w.store.insert(mk('1', 100)); // old release, retried: next attempt only now due
    w.store.reschedule('1', 5000, 'core-error');
    w.store.insert(mk('2', 4000));
    w.store.insert(mk('3', 4000));
    w.store.reschedule('3', 4000, null);
    expect(w.store.dueHeld(6000, 3).map((r) => r.id)).toEqual(['2', '3', '1']);
    expect(w.store.dueHeld(6000, 1).map((r) => r.id)).toEqual(['2']);
  });
});

describe('M5: cancel vs in-flight voteraw', () => {
  async function inFlight(env: Record<string, string> = {}) {
    const w = world(env);
    const mn = w.mn();
    const gov = w.proposal();
    const sub = await w.submit(mn, { govHash: gov });
    let release!: () => void;
    w.core.voterawGate = new Promise<void>((r) => (release = r));
    const tick = w.broadcaster.tickBroadcast();
    await vi.waitFor(() => expect(w.row(sub.id).status).toBe('sending'));
    return { w, mn, gov, sub, tick, release };
  }

  it('a vote is `sending` while voteraw runs: cancel is 409 not-held with status sending, GET shows it, then it ends broadcast', async () => {
    const { w, mn, sub, tick, release } = await inFlight();
    const r = await w.post('/v1/votes/cancel', w.cancelBody(mn, sub.id, sub.voteHash));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'not-held', status: 'sending' });
    expect((await w.get(`/v1/votes/${sub.id}`)).body.status).toBe('sending');
    expect(w.store.countHeld()).toBe(1); // still occupies a slot
    release();
    await tick;
    expect(w.row(sub.id)).toMatchObject({ status: 'broadcast', attempts: 1 });
    expect(w.core.count('voteraw')).toBe(1);
  });

  it('sending -> held when Core answers "wait" or an error, sending -> maybe-broadcast without an answer, sending -> failed when Core refuses for good', async () => {
    const cases: Array<[unknown, Record<string, unknown>]> = [
      [rpcErr('Error voting : CGovernanceObject::ProcessVote -- Masternode voting too often, MN outpoint = x'), { status: 'held', last_error: 'too-often', next_attempt_at: T0 + 3630 }],
      [rpcErr('Something Core has never said before'), { status: 'held', last_error: 'core-error', next_attempt_at: T0 + 30, fail_n: 1, maybe_sent: 0 }],
      // no answer: the vote may be in Core (review SR-07)
      [new Error('fetch failed: ECONNREFUSED'), { status: 'maybe-broadcast', last_error: 'core-error', next_attempt_at: T0 + 30, fail_n: 1, maybe_sent: 1 }],
      [rpcErr('Failure to verify vote.'), { status: 'failed', last_error: 'bad-signature' }],
    ];
    for (const [err, expected] of cases) {
      const w = world();
      const mn = w.mn();
      const gov = w.proposal();
      const sub = await w.submit(mn, { govHash: gov });
      w.core.voterawErrors.push(err);
      let release!: () => void;
      w.core.voterawGate = new Promise<void>((r) => (release = r));
      const tick = w.broadcaster.tickBroadcast();
      await vi.waitFor(() => expect(w.row(sub.id).status).toBe('sending'));
      release();
      await tick;
      expect(w.row(sub.id)).toMatchObject(expected);
    }
  });

  it('a newer vote for the same key while the older one is in flight: older-or-equal is refused, newer is queued and the older never goes back out', async () => {
    const { w, mn, gov, sub, tick, release } = await inFlight({ RATE_MN_PER_HOUR: '100' });
    const older = await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, time: T0 - 5, outcome: 'no' }));
    expect(older.status).toBe(409);
    expect(older.body.code).toBe('later-vote-held');
    expect((await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, time: T0, outcome: 'no' }))).body.code).toBe('later-vote-held');
    const newer = await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, time: T0 + 1, outcome: 'no' }));
    expect(newer.status).toBe(202);
    expect(w.row(sub.id).status).toBe('sending'); // never superseded under voteraw's feet
    w.core.voterawErrors.push(new Error('fetch failed: ECONNREFUSED'));
    release();
    await tick; // the in-flight send gets no answer: waiting again (maybe-broadcast) next to the newer vote
    expect(w.row(sub.id).status).toBe('maybe-broadcast');
    w.clock.advance(31);
    w.core.voterawGate = null;
    await w.broadcaster.tickBroadcast();
    expect(w.row(sub.id).status).toBe('superseded');
    expect(w.row(newer.body.id).status).toBe('broadcast');
    expect(w.core.count('voteraw')).toBe(2); // the failed attempt of the older vote, then the newer one
  });

  it('SR-07: a cancel racing a broadcast whose answer was lost is refused (409 maybe-broadcast), never reported as cancelled', async () => {
    const { w, mn, sub, tick, release } = await inFlight();
    // the cancel arrives while voteraw runs: refused
    expect((await w.post('/v1/votes/cancel', w.cancelBody(mn, sub.id, sub.voteHash))).body).toMatchObject({ code: 'not-held', status: 'sending' });
    // Core takes the vote, but the answer is lost (timeout)
    w.core.voterawErrors.push(new Error('This operation was aborted'));
    w.core.voterawAcceptsBeforeError = true;
    release();
    await tick;
    expect(w.row(sub.id)).toMatchObject({ status: 'maybe-broadcast', maybe_sent: 1 });
    expect(w.core.votes.size).toBe(1); // it is in Core
    // a second cancel (the client retrying) is refused with a reason it can show, also after a restart and a Core error
    for (let i = 0; i < 2; i++) {
      const r = await w.post('/v1/votes/cancel', w.cancelBody(mn, sub.id, sub.voteHash));
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'maybe-broadcast', status: 'maybe-broadcast' });
      expect(typeof r.body.reason).toBe('string');
      w.store.reschedule(sub.id, w.clock.t, 'too-often'); // Core answering "wait" does not make it cancellable again
      new Broadcaster({ cfg: w.cfg, store: w.store, core: w.core, mns: w.relay.mns, clock: w.clock.now });
    }
    expect(w.row(sub.id).status).toBe('maybe-broadcast');
    // the next attempt: Core says it already has it, the confirmer confirms
    w.core.voterawGate = null;
    w.clock.advance(31);
    await w.broadcaster.tickBroadcast();
    expect(w.row(sub.id).status).toBe('broadcast');
    await w.broadcaster.tickConfirm();
    expect(w.row(sub.id).status).toBe('confirmed');
  });

  it('a cancel that wins before the broadcaster claims the vote stops it: nothing is sent', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id, voteHash } = await w.submit(mn, { govHash: gov });
    expect((await w.post('/v1/votes/cancel', w.cancelBody(mn, id, voteHash))).status).toBe(200);
    expect(w.store.markSending(id)).toBe(false);
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(0);
    expect(w.row(id).status).toBe('cancelled');
  });

  it('final states are never overwritten by the broadcaster/confirmer updates', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id, voteHash } = await w.submit(mn, { govHash: gov, time: T0 + 1800 });
    await w.post('/v1/votes/cancel', w.cancelBody(mn, id, voteHash));
    const row = w.row(id);
    w.store.finish(id, 'failed', T0 + 5, 'core-error');
    w.store.reschedule(id, T0 + 99, 'too-often');
    w.store.retryLater(id, T0 + 99, 'core-error');
    w.store.markSent(row, T0 + 5);
    expect(w.row(id)).toMatchObject({ status: 'cancelled', last_error: null });
  });

  it('start-up puts rows left in `sending` by a crash back to waiting as maybe-broadcast, due at once', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id } = await w.submit(mn, { govHash: gov });
    w.store.db.prepare(`UPDATE votes SET status = 'sending' WHERE id = ?`).run(id);
    w.clock.advance(7);
    const restarted = new Broadcaster({ cfg: w.cfg, store: w.store, core: w.core, mns: w.relay.mns, clock: w.clock.now });
    expect(w.row(id)).toMatchObject({ status: 'maybe-broadcast', maybe_sent: 1, next_attempt_at: T0 + 7 });
    await restarted.tickBroadcast();
    expect(w.row(id).status).toBe('broadcast');
  });

  it('a crash after Core accepted the vote: the retry hears "already known" and the vote is confirmed', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const { id } = await w.submit(mn, { govHash: gov });
    await w.broadcaster.tickBroadcast(); // Core has it now
    // the answer was lost in the crash: the row says sending and nothing was recorded
    w.store.db.prepare(`UPDATE votes SET status = 'sending', broadcast_at = NULL, attempts = 0 WHERE id = ?`).run(id);
    w.store.db.prepare('DELETE FROM last_broadcast').run();
    const restarted = new Broadcaster({ cfg: w.cfg, store: w.store, core: w.core, mns: w.relay.mns, clock: w.clock.now });
    await restarted.tickBroadcast();
    expect(w.row(id).status).toBe('broadcast');
    await restarted.tickConfirm();
    expect(w.row(id).status).toBe('confirmed');
  });
});

describe('L3: client IP', () => {
  const send = async (w: World, ip: Record<string, string>, peer?: string): Promise<number> => {
    const init = { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', ...ip } };
    return (await w.app.request('/v1/votes/cancel', init, peer ? { incoming: { socket: { remoteAddress: peer } } } : undefined)).status;
  };

  it('x-forwarded-for: the rightmost entry (appended by our proxy) is the client; forged left entries change nothing', async () => {
    const w = world({ CLIENT_IP_HEADER: 'X-Forwarded-For', RATE_IP_PER_MIN: '2' });
    expect(await send(w, { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })).toBe(400);
    expect(await send(w, { 'x-forwarded-for': '2.2.2.2, 9.9.9.9, 203.0.113.7' })).toBe(400);
    expect(await send(w, { 'x-forwarded-for': '3.3.3.3, 203.0.113.7' })).toBe(429);
    expect(await send(w, { 'x-forwarded-for': '1.1.1.1, 203.0.113.8' })).toBe(400); // other real client
    expect(await send(w, { 'x-forwarded-for': '203.0.113.7' })).toBe(429); // single entry
  });

  it('cf-connecting-ip: the single value', async () => {
    const w = world({ CLIENT_IP_HEADER: 'cf-connecting-ip', RATE_IP_PER_MIN: '1' });
    expect(await send(w, { 'cf-connecting-ip': '203.0.113.7' })).toBe(400);
    expect(await send(w, { 'cf-connecting-ip': '203.0.113.7' })).toBe(429);
    expect(await send(w, { 'cf-connecting-ip': '203.0.113.8' })).toBe(400);
  });

  it('IPv6 clients share one bucket per /64; IPv4 and IPv4-mapped IPv6 are bucketed by the full address', async () => {
    const w = world({ CLIENT_IP_HEADER: 'x-real-ip', RATE_IP_PER_MIN: '1' });
    expect(await send(w, { 'x-real-ip': '2001:db8:1:2::1' })).toBe(400);
    expect(await send(w, { 'x-real-ip': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' })).toBe(429);
    expect(await send(w, { 'x-real-ip': '2001:0DB8:0001:0002:0:0:0:5' })).toBe(429);
    expect(await send(w, { 'x-real-ip': '2001:db8:1:3::1' })).toBe(400); // next /64
    expect(await send(w, { 'x-real-ip': '203.0.113.7' })).toBe(400);
    expect(await send(w, { 'x-real-ip': '::ffff:203.0.113.7' })).toBe(429);
    expect(await send(w, { 'x-real-ip': '::ffff:203.0.113.8' })).toBe(400);
  });

  it('ipBucket', () => {
    expect(ipBucket('2001:db8:1:2:3:4:5:6')).toBe(ipBucket('2001:db8:1:2::'));
    expect(ipBucket('2001:db8:1:2::1')).not.toBe(ipBucket('2001:db8:1:20::1'));
    expect(ipBucket('fe80::1%eth0')).toBe(ipBucket('fe80::2'));
    expect(ipBucket('::1')).toBe(ipBucket('::2'));
    expect(ipBucket('::ffff:c000:201')).toBe('192.0.2.1');
    expect(ipBucket('192.0.2.1')).toBe('192.0.2.1');
    // every spelling of an IPv4-mapped address, and ports/brackets, collapse to the plain IPv4 address
    for (const v of ['0:0:0:0:0:ffff:192.0.2.1', '::FFFF:192.0.2.1', '::ffff:c000:201', '192.0.2.1:54321', '[::ffff:192.0.2.1]:443']) expect(ipBucket(v), v).toBe('192.0.2.1');
    expect(ipBucket('[2001:db8::1]:443')).toBe(ipBucket('2001:db8::2'));
    expect(ipBucket('::1')).not.toBe('192.0.2.1');
    expect(ipBucket('unknown')).toBe('unknown');
  });

  it('TRUSTED_PROXY_CIDRS: the header counts only from a listed socket peer, else the socket address is the client', async () => {
    const w = world({ CLIENT_IP_HEADER: 'x-test-ip', RATE_IP_PER_MIN: '1', TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 2001:db8::7' });
    // trusted peer: the header decides
    expect(await send(w, { 'x-test-ip': '203.0.113.1' }, '10.1.2.3')).toBe(400);
    expect(await send(w, { 'x-test-ip': '203.0.113.2' }, '10.1.2.3')).toBe(400);
    expect(await send(w, { 'x-test-ip': '203.0.113.1' }, '10.9.9.9')).toBe(429);
    expect(await send(w, { 'x-test-ip': '203.0.113.3' }, '::ffff:10.0.0.1')).toBe(400); // mapped peer inside the CIDR
    expect(await send(w, { 'x-test-ip': '203.0.113.4' }, '2001:db8::7')).toBe(400);
    // untrusted peer: the header is ignored, one bucket per socket address
    expect(await send(w, { 'x-test-ip': '203.0.113.50' }, '198.51.100.9')).toBe(400);
    expect(await send(w, { 'x-test-ip': '203.0.113.51' }, '198.51.100.9')).toBe(429);
    expect(await send(w, { 'x-test-ip': '203.0.113.52' }, '198.51.100.10')).toBe(400);
    // the bucket of the forged header value was not touched by the untrusted requests
    expect(await send(w, { 'x-test-ip': '203.0.113.50' }, '10.0.0.1')).toBe(400);
    // no socket information at all counts as untrusted when a list is set
    expect(await send(w, { 'x-test-ip': '203.0.113.60' })).toBe(400);
    expect(await send(w, { 'x-test-ip': '203.0.113.61' })).toBe(429);
  });

  it('empty TRUSTED_PROXY_CIDRS trusts the header from any peer', async () => {
    const w = world({ CLIENT_IP_HEADER: 'x-test-ip', RATE_IP_PER_MIN: '1' });
    expect(await send(w, { 'x-test-ip': '203.0.113.1' }, '198.51.100.9')).toBe(400);
    expect(await send(w, { 'x-test-ip': '203.0.113.2' }, '198.51.100.9')).toBe(400);
    expect(await send(w, { 'x-test-ip': '203.0.113.1' }, '192.0.2.5')).toBe(429);
  });

  it('peerTrust / resolveClientIp / config validation', () => {
    const trust = peerTrust(['192.168.0.0/16', '172.16.5.4', '100.64.0.0/10']);
    expect(trust('192.168.77.1')).toBe(true);
    expect(trust('192.169.0.1')).toBe(false);
    expect(trust('172.16.5.4')).toBe(true);
    expect(trust('172.16.5.5')).toBe(false);
    expect(trust('100.127.255.255')).toBe(true);
    expect(trust('100.128.0.0')).toBe(false);
    expect(trust(undefined)).toBe(false);
    expect(peerTrust([])(undefined)).toBe(true);
    expect(peerTrust(['0.0.0.0/0'])('8.8.8.8')).toBe(true);
    expect(peerTrust(['2001:db8::7'])('2001:0db8:0:0:0:0:0:7')).toBe(true);
    expect(peerTrust(['2001:db8::7'])('2001:db8::8')).toBe(false);

    const get = (h: Record<string, string>) => (n: string) => h[n];
    expect(resolveClientIp({ header: '', get: get({}), peer: '1.2.3.4', trusted: () => true })).toBe('1.2.3.4');
    expect(resolveClientIp({ header: 'x-forwarded-for', get: get({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8 , 7.7.7.7 ' }), peer: '1.2.3.4', trusted: () => true })).toBe('7.7.7.7');
    expect(resolveClientIp({ header: 'x-forwarded-for', get: get({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8,' }), peer: '1.2.3.4', trusted: () => true })).toBe('8.8.8.8');
    // a value that is not an address falls back to the socket
    expect(resolveClientIp({ header: 'x-forwarded-for', get: get({ 'x-forwarded-for': '9.9.9.9, <script>' }), peer: '1.2.3.4', trusted: () => true })).toBe('1.2.3.4');
    expect(resolveClientIp({ header: 'cf-connecting-ip', get: get({ 'cf-connecting-ip': '9.9.9.9' }), peer: '1.2.3.4', trusted: () => false })).toBe('1.2.3.4');
    expect(resolveClientIp({ header: 'cf-connecting-ip', get: get({}), peer: undefined, trusted: () => true })).toBe('unknown');

    for (const bad of ['1.2.3.4/33', '1.2.3.4/', '1.2.3/24', 'example.com', '2001:db8::/32', '1.2.3.4/8/8']) expect(() => validateProxyList([bad]), bad).toThrow(/TRUSTED_PROXY_CIDRS/);
    expect(() => loadConfig({ TRUSTED_PROXY_CIDRS: '10.0.0.0/8,nope' })).toThrow(/TRUSTED_PROXY_CIDRS/);
    expect(loadConfig({ TRUSTED_PROXY_CIDRS: ' 10.0.0.0/8 , 2001:db8::1 ,' }).trustedProxyCidrs).toEqual(['10.0.0.0/8', '2001:db8::1']);
    expect(loadConfig({}).trustedProxyCidrs).toEqual([]);
    expect(loadConfig({})).toMatchObject({ maxPastS: 86400, maxHeldTotal: 100000 });
  });
});
