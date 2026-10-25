// POST /v1/votes, POST /v1/votes/cancel, GET /v1/votes/:id, GET /v1/status on both vote-signature schemes
// (testnet = hash scheme, mainnet = message scheme).
import { describe, expect, it } from 'vitest';
import type { Network } from '@govhub/verify';
import { T0, World } from './world.ts';

const SCHEMES: Network[] = ['testnet', 'mainnet'];
const other = (n: Network): Network => (n === 'testnet' ? 'mainnet' : 'testnet');

describe.each(SCHEMES)('votes API (%s)', (network) => {
  const world = (env: Record<string, string> = {}) => new World(network, env);

  it('happy path, immediate: held -> broadcast -> confirmed', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const body = w.voteBody(mn, { govHash: gov });
    const r = await w.post('/v1/votes', body);
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), voteHash: w.voteHashOf(mn, gov, 'yes', T0), status: 'held', releaseAt: T0 });
    expect(r.body.id).not.toBe(r.body.voteHash);

    const id = r.body.id as string;
    expect((await w.get(`/v1/votes/${id}`)).body).toEqual({ id, voteHash: r.body.voteHash, status: 'held', releaseAt: T0, broadcastAt: null, confirmedAt: null, attempts: 0, lastError: null, nextAttemptAt: T0, holdReason: 'release-time', sameAsCurrent: false });

    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(1);
    expect(w.core.calls.find((c) => c.method === 'voteraw')!.params).toEqual([mn.txid, 0, gov, 'funding', 'yes', T0, body.sig]);
    const sent = (await w.get(`/v1/votes/${id}`)).body;
    expect(sent).toMatchObject({ status: 'broadcast', broadcastAt: T0, attempts: 1, lastError: null });

    w.clock.advance(30);
    await w.broadcaster.tickConfirm();
    expect((await w.get(`/v1/votes/${id}`)).body).toMatchObject({ status: 'confirmed', confirmedAt: T0 + 30 });
  });

  it('happy path, deferred: released a minute before the signed time, never earlier', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const time = T0 + 5 * 86400;
    const r = await w.submit(mn, { govHash: gov, time, outcome: 'no' });
    expect(r.releaseAt).toBe(time - 60);

    await w.broadcaster.tickBroadcast();
    w.clock.advance(5 * 86400 - 61);
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(0);
    expect(w.row(r.id).status).toBe('held');

    w.clock.advance(1);
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(1);
    expect(w.row(r.id).status).toBe('broadcast');
    expect(w.core.votes.size).toBe(1);
  });

  it('honours an explicit releaseAt (and a releaseAt in the past means now)', async () => {
    const w = world();
    const mn = w.mn();
    const g1 = w.proposal();
    const g2 = w.proposal();
    const time = T0 + 7200;
    expect((await w.submit(mn, { govHash: g1, time, releaseAt: time - 1800 })).releaseAt).toBe(time - 1800);
    expect((await w.submit(mn, { govHash: g2, time: T0 + 1000, releaseAt: T0 - 500 })).releaseAt).toBe(T0);
  });

  it('rejects another network (wrong-network) before anything else', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const body = { ...w.voteBody(mn, { govHash: gov }), network: other(network) };
    const r = await w.post('/v1/votes', body);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('wrong-network');
    expect((await w.post('/v1/votes', { junk: true })).body.code).toBe('wrong-network');
    expect(w.core.calls.length).toBe(0);
  });

  it('rejects malformed requests (bad-request): types, unknown keys, bad base64, bad JSON', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const good = w.voteBody(mn, { govHash: gov });
    const bad: Array<Record<string, unknown>> = [
      { ...good, extra: 1 },
      { ...good, collateralIndex: '0' },
      { ...good, collateralIndex: -1 },
      { ...good, collateralTxid: 'zz' },
      { ...good, govHash: 'ab' },
      { ...good, time: 1.5 },
      { ...good, time: String(T0) },
      { ...good, signal: 'nonsense' },
      { ...good, outcome: 1 },
      { ...good, sig: 12 },
      { ...good, sig: 'AAAA' },
      { ...good, releaseAt: 'soon' },
    ];
    for (const b of bad) {
      const r = await w.post('/v1/votes', b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.body.code).toBe('bad-request');
    }
    for (const raw of ['not json', '[]', 'null', '"x"']) {
      const r = await w.post('/v1/votes', raw);
      expect(r.status).toBe(400);
      expect(['bad-request', 'wrong-network']).toContain(r.body.code);
    }
    expect(w.core.calls.length).toBe(0);
  });

  it('accepts only funding yes/no/abstain votes that Core would take (bad-vote)', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const good = w.voteBody(mn, { govHash: gov });
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...good, signal: 'valid' }, /funding/],
      [{ ...good, signal: 'delete' }, /funding/],
      [{ ...good, signal: 'none' }, /signal/],
      [{ ...good, outcome: 'none' }, /outcome/],
      [{ ...good, time: T0 + 3_456_001 }, /ahead/],
      [{ ...good, time: 0 }, /positive/],
      [{ ...good, time: -5 }, /positive/],
    ];
    for (const [b, re] of cases) {
      const r = await w.post('/v1/votes', b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.body.code).toBe('bad-vote');
      expect(r.body.error).toMatch(re);
    }
  });

  it('bounds releaseAt (bad-release)', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const time = T0 + 10_000;
    for (const releaseAt of [time - 3600 + 59, time + 86401, T0 + 3_456_001]) {
      const r = await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, time, releaseAt }));
      expect(r.status, String(releaseAt)).toBe(400);
      expect(r.body.code).toBe('bad-release');
    }
    expect((await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, time, releaseAt: time - 3600 + 60 }))).status).toBe(202);
    // the hold limit applies to the release too
    const far = T0 + 3_456_000;
    const g2 = w.proposal();
    expect((await w.post('/v1/votes', w.voteBody(mn, { govHash: g2, time: far, releaseAt: far + 10 }))).body.code).toBe('bad-release');
    expect((await w.post('/v1/votes', w.voteBody(mn, { govHash: g2, time: far, releaseAt: far }))).status).toBe(202);
  });

  it('refuses unknown and PoSe-banned masternodes', async () => {
    const w = world();
    const gov = w.proposal();
    const stranger = w.mn();
    w.core.mns.clear();
    const r1 = await w.post('/v1/votes', w.voteBody(stranger, { govHash: gov }));
    expect(r1.status).toBe(404);
    expect(r1.body.code).toBe('unknown-mn');

    // a miss refreshes the list at most once per 10 s
    const banned = w.mn({ banned: true });
    expect((await w.post('/v1/votes', w.voteBody(banned, { govHash: gov }))).body.code).toBe('unknown-mn');
    expect(w.core.count('protx')).toBe(1);
    w.clock.advance(11);
    const r2 = await w.post('/v1/votes', w.voteBody(banned, { govHash: gov, time: w.clock.t }));
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('mn-banned');
    expect(w.core.count('protx')).toBe(2);
  });

  it('refuses signatures from another key or for the other network scheme (bad-signature)', async () => {
    const w = world();
    const mn = w.mn();
    const intruder = w.mn();
    const gov = w.proposal();
    const wrongKey = await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, signWith: intruder.priv }));
    expect(wrongKey.status).toBe(400);
    expect(wrongKey.body.code).toBe('bad-signature');
    const wrongScheme = await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, signAs: other(network) }));
    expect(wrongScheme.status).toBe(400);
    expect(wrongScheme.body.code).toBe('bad-signature');
    // a signature over different vote content
    const tampered = w.voteBody(mn, { govHash: gov });
    const r = await w.post('/v1/votes', { ...tampered, outcome: 'no' });
    expect(r.body.code).toBe('bad-signature');
    expect(w.store.countHeld()).toBe(0);
  });

  it('needs a proposal Core knows (unknown-proposal / not-a-proposal), and caches the verdict for 60 s', async () => {
    const w = world();
    const mn = w.mn();
    const unknown = 'ab'.repeat(32);
    const r1 = await w.post('/v1/votes', w.voteBody(mn, { govHash: unknown }));
    expect(r1.status).toBe(404);
    expect(r1.body.code).toBe('unknown-proposal');
    const trigger = w.proposal(2);
    const r2 = await w.post('/v1/votes', w.voteBody(mn, { govHash: trigger }));
    expect(r2.status).toBe(400);
    expect(r2.body.code).toBe('not-a-proposal');

    // the verdict is cached: the proposal appearing now is not seen for 60 s
    w.core.gobjects.set(unknown, { ObjectType: 1 });
    const gets = w.core.count('gobject', 'get');
    expect((await w.post('/v1/votes', w.voteBody(mn, { govHash: unknown }))).status).toBe(404);
    expect(w.core.count('gobject', 'get')).toBe(gets);
    w.clock.advance(61);
    expect((await w.post('/v1/votes', w.voteBody(mn, { govHash: unknown, time: w.clock.t }))).status).toBe(202);
  });

  it('answers 503 core-unavailable while Core is down', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    w.core.down = true;
    const r = await w.post('/v1/votes', w.voteBody(mn, { govHash: gov }));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('core-unavailable');
  });

  it('is idempotent: the same signed vote returns the stored record, in any state', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const body = w.voteBody(mn, { govHash: gov });
    const first = await w.post('/v1/votes', body);
    expect(first.status).toBe(202);
    const again = await w.post('/v1/votes', body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);

    await w.broadcaster.tickBroadcast();
    const later = await w.post('/v1/votes', body);
    expect(later.status).toBe(200);
    expect(later.body).toMatchObject({ id: first.body.id, status: 'broadcast' });
    expect(w.store.db.prepare('SELECT COUNT(*) n FROM votes').get()).toEqual({ n: 1 });
    expect(w.core.count('voteraw')).toBe(1);
  });

  it('GET /v1/votes/by-hash/:voteHash: the record and relay id of a vote whose POST answer was lost; 404, 400 and the IP limit', async () => {
    const w = world({ RATE_IP_PER_MIN: '4', CLIENT_IP_HEADER: 'X-Test-IP' });
    const mn = w.mn();
    const gov = w.proposal();
    const body = w.voteBody(mn, { govHash: gov });
    const voteHash = w.voteHashOf(mn, gov, 'yes', T0);
    const hdr = { 'x-test-ip': '203.0.113.20' };
    expect((await w.get(`/v1/votes/by-hash/${voteHash}`, hdr)).body).toMatchObject({ code: 'unknown-vote' });
    const first = await w.post('/v1/votes', body, { 'x-test-ip': '203.0.113.21' }); // the client never sees this answer
    const found = await w.get(`/v1/votes/by-hash/${voteHash.toUpperCase()}`, hdr);
    expect(found.status).toBe(200);
    expect(found.body).toEqual((await w.get(`/v1/votes/${first.body.id}`)).body);
    expect(found.body).toMatchObject({ id: first.body.id, voteHash, status: 'held' });
    await w.broadcaster.tickBroadcast();
    expect((await w.get(`/v1/votes/by-hash/${voteHash}`, hdr)).body).toMatchObject({ id: first.body.id, status: 'broadcast' });
    expect((await w.get('/v1/votes/by-hash/xyz', hdr)).body).toMatchObject({ code: 'bad-request' });
    const limited = await w.get(`/v1/votes/by-hash/${voteHash}`, hdr);
    expect(limited.status).toBe(429);
    expect((await w.app.request(`/v1/votes/by-hash/${voteHash}`, { method: 'POST' })).status).toBe(405);
  });

  it('replaces a held vote with a later one, and refuses an earlier or equal one (later-vote-held)', async () => {
    const w = world();
    const mn = w.mn();
    const gov = w.proposal();
    const t = T0 + 7200;
    const a = await w.submit(mn, { govHash: gov, time: t, outcome: 'yes' });
    const b = await w.submit(mn, { govHash: gov, time: t + 10, outcome: 'no' });
    expect(b.id).not.toBe(a.id);
    expect(w.row(a.id).status).toBe('superseded');
    expect(w.row(b.id).status).toBe('held');

    for (const [time, outcome] of [[t + 5, 'abstain'], [t + 10, 'abstain'], [t, 'no']] as const) {
      const r = await w.post('/v1/votes', w.voteBody(mn, { govHash: gov, time, outcome }));
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('later-vote-held');
    }
    expect((await w.get(`/v1/votes/${a.id}`)).body.status).toBe('superseded');
    expect(w.store.countHeld()).toBe(1);

    // the superseded vote is never sent
    w.clock.advance(7200);
    await w.broadcaster.tickBroadcast();
    expect(w.core.count('voteraw')).toBe(1);
    expect(w.core.calls.find((c) => c.method === 'voteraw')!.params[4]).toBe('no');
  });

  it('limits requests per client IP with a token bucket and Retry-After', async () => {
    const w = world({ RATE_IP_PER_MIN: '3', CLIENT_IP_HEADER: 'X-Test-IP' });
    const mn = w.mn();
    const gov = w.proposal();
    const hdr = { 'x-test-ip': '203.0.113.7' };
    const body = w.voteBody(mn, { govHash: gov });
    for (let i = 0; i < 3; i++) expect((await w.post('/v1/votes', body, hdr)).status).toBe(i === 0 ? 202 : 200);
    const limited = await w.post('/v1/votes', body, hdr);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('rate-limited');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // another address has its own bucket
    expect((await w.post('/v1/votes', body, { 'x-test-ip': '203.0.113.8' })).status).toBe(200);
    // the bucket refills (3 per minute = one token per 20 s)
    w.clock.advance(20);
    expect((await w.post('/v1/votes', body, hdr)).status).toBe(200);
    // it also guards cancel
    const hdr2 = { 'x-test-ip': '203.0.113.9' };
    for (let i = 0; i < 3; i++) expect((await w.post('/v1/votes/cancel', {}, hdr2)).status).toBe(400);
    expect((await w.post('/v1/votes/cancel', {}, hdr2)).status).toBe(429);
  });

  it('limits accepted votes per masternode per rolling hour (rate-limited)', async () => {
    const w = world({ RATE_MN_PER_HOUR: '2' });
    const mn = w.mn();
    const [g1, g2, g3] = [w.proposal(), w.proposal(), w.proposal()] as [string, string, string];
    await w.submit(mn, { govHash: g1 });
    w.clock.advance(1800);
    await w.submit(mn, { govHash: g2, time: w.clock.t });
    const r = await w.post('/v1/votes', w.voteBody(mn, { govHash: g3, time: w.clock.t }));
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('rate-limited');
    expect(Number(r.headers.get('retry-after'))).toBe(1800);
    // an idempotent retry of an accepted vote is not counted and not refused
    expect((await w.post('/v1/votes', w.voteBody(mn, { govHash: g2, time: w.clock.t }))).status).toBe(200);
    w.clock.advance(1801); // the first submission leaves the window
    expect((await w.post('/v1/votes', w.voteBody(mn, { govHash: g3, time: w.clock.t }))).status).toBe(202);
  });

  it('limits held votes per masternode (too-many-held), but a replacement does not count', async () => {
    const w = world({ MAX_HELD_PER_MN: '2', RATE_MN_PER_HOUR: '100' });
    const mn = w.mn();
    const other_ = w.mn();
    const gs = [w.proposal(), w.proposal(), w.proposal()] as [string, string, string];
    const time = T0 + 7200;
    await w.submit(mn, { govHash: gs[0], time });
    await w.submit(mn, { govHash: gs[1], time });
    const r = await w.post('/v1/votes', w.voteBody(mn, { govHash: gs[2], time }));
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('too-many-held');
    expect((await w.post('/v1/votes', w.voteBody(mn, { govHash: gs[0], time: time + 1, outcome: 'no' }))).status).toBe(202);
    expect((await w.post('/v1/votes', w.voteBody(other_, { govHash: gs[2], time }))).status).toBe(202);
  });

  describe('cancel', () => {
    it('drops a held vote with the voting key, idempotently, and it is never broadcast', async () => {
      const w = world();
      const mn = w.mn();
      const gov = w.proposal();
      const { id, voteHash } = await w.submit(mn, { govHash: gov, time: T0 + 1800 });
      const r = await w.post('/v1/votes/cancel', w.cancelBody(mn, id, voteHash));
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ id, status: 'cancelled' });
      expect((await w.post('/v1/votes/cancel', w.cancelBody(mn, id, voteHash))).body).toEqual({ id, status: 'cancelled' });
      expect((await w.get(`/v1/votes/${id}`)).body.status).toBe('cancelled');
      expect(w.store.countHeld()).toBe(0);
      w.clock.advance(3600);
      await w.broadcaster.tickBroadcast();
      expect(w.core.count('voteraw')).toBe(0);
    });

    it('needs the current voting key of that masternode', async () => {
      const w = world();
      const mn = w.mn();
      const intruder = w.mn();
      const gov = w.proposal();
      const { id, voteHash } = await w.submit(mn, { govHash: gov, time: T0 + 1800 });
      const wrongKey = await w.post('/v1/votes/cancel', w.cancelBody(mn, id, voteHash, { signWith: intruder.priv }));
      expect(wrongKey.status).toBe(403);
      expect(wrongKey.body.code).toBe('bad-signature');
      const wrongNet = await w.post('/v1/votes/cancel', w.cancelBody(mn, id, voteHash, { net: other(network) }));
      expect(wrongNet.status).toBe(403);
      const wrongVote = await w.post('/v1/votes/cancel', w.cancelBody(mn, id, 'ee'.repeat(32)));
      expect(wrongVote.status).toBe(403);
      expect(w.row(id).status).toBe('held');
    });

    it('follows a voting key change (the key at cancel time counts)', async () => {
      const w = world();
      const mn = w.mn();
      const gov = w.proposal();
      const { id, voteHash } = await w.submit(mn, { govHash: gov, time: T0 + 1800 });
      const successor = w.mn();
      w.core.mns.set(`${mn.txid}-${mn.n}`, { txid: mn.txid, n: mn.n, votingAddress: successor.address, banned: false });
      w.clock.advance(61); // MN_LIST_TTL_S
      expect((await w.post('/v1/votes/cancel', w.cancelBody(mn, id, voteHash))).status).toBe(403);
      expect((await w.post('/v1/votes/cancel', w.cancelBody(mn, id, voteHash, { signWith: successor.priv }))).status).toBe(200);
    });

    it('refuses a vote that left the held state (not-held), and reports unknown ids', async () => {
      const w = world();
      const mn = w.mn();
      const gov = w.proposal();
      const { id, voteHash } = await w.submit(mn, { govHash: gov });
      await w.broadcaster.tickBroadcast();
      const r = await w.post('/v1/votes/cancel', w.cancelBody(mn, id, voteHash));
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: 'not-held', status: 'broadcast' });
      expect(w.row(id).status).toBe('broadcast');

      expect((await w.post('/v1/votes/cancel', w.cancelBody(mn, '00'.repeat(16), voteHash))).status).toBe(404);
      expect((await w.post('/v1/votes/cancel', { id: 'nope', sig: 'x' })).body.code).toBe('bad-request');
      expect((await w.post('/v1/votes/cancel', { ...w.cancelBody(mn, id, voteHash), more: 1 })).body.code).toBe('bad-request');
    });
  });

  describe('GET /v1/votes/:id and /v1/status', () => {
    it('validates and finds ids', async () => {
      const w = world();
      expect((await w.get('/v1/votes/xyz')).status).toBe(400);
      expect((await w.get('/v1/votes/' + 'A'.repeat(32))).status).toBe(400);
      const r = await w.get('/v1/votes/' + 'a'.repeat(32));
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('unknown-id');
    });

    it('reports Core state and the held count, 200 even when Core is down', async () => {
      const w = world();
      const mn = w.mn();
      const gov = w.proposal();
      await w.submit(mn, { govHash: gov, time: T0 + 1800 });
      const up = await w.get('/v1/status');
      expect(up.status).toBe(200);
      expect(up.body).toEqual({ service: 'govhub-relay', version: '0.1.0', network, core: { reachable: true, height: w.core.height }, held: 1, proposalSubmit: true });
      w.core.down = true;
      w.clock.advance(10);
      const down = await w.get('/v1/status');
      expect(down.status).toBe(200);
      expect(down.body.core).toEqual({ reachable: false, height: null });
    });
  });
});

describe('HTTP behaviour', () => {
  it('sets nosniff everywhere, CORS on the documented methods, 413 above 4096 bytes, JSON 404/405', async () => {
    const w = new World('testnet');
    const mn = w.mn();
    const gov = w.proposal();
    const check = (r: { headers: Headers }) => {
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
    };
    check(await w.get('/v1/status'));
    check(await w.get('/nope'));
    check(await w.post('/v1/votes', w.voteBody(mn, { govHash: gov })));

    const big = await w.post('/v1/votes', { ...w.voteBody(mn, { govHash: gov }), pad: 'x'.repeat(5000) });
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('too-large');
    check(big);
    expect((await w.post('/v1/votes', JSON.stringify({ pad: 'x'.repeat(4096) }))).status).toBe(413);
    expect(w.core.count('protx')).toBe(1); // only the first request got as far as Core

    const nf = await w.get('/v1/nothing');
    expect(nf.status).toBe(404);
    expect(nf.body.code).toBe('not-found');

    for (const [method, path] of [['GET', '/v1/votes'], ['PUT', '/v1/votes'], ['GET', '/v1/votes/cancel'], ['DELETE', '/v1/votes/' + 'a'.repeat(32)], ['POST', '/v1/status'], ['GET', '/v1/proposals/submit']] as const) {
      const r = await w.app.request(path, { method });
      expect(r.status, `${method} ${path}`).toBe(405);
      expect(r.headers.get('allow')).toBeTruthy();
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(((await r.json()) as any).code).toBe('method-not-allowed');
    }

    const pre = await w.app.request('/v1/votes', { method: 'OPTIONS', headers: { Origin: 'https://gov.dashhq.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET,POST,OPTIONS');
    expect(pre.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(pre.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
