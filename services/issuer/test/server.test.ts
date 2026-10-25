// HTTP surface: CORS without credentials, no caching, body limit, JSON errors, and a full token round trip.
import { describe, expect, it } from 'vitest';
import { base64ToBytes, sha256 } from '@govhub/badge';
import { createApp } from '../src/server.ts';
import { clientRequest, E, fakeMn, fakeProposal, finishBadge, finishStarter, mnSubject, P, proposalSubject, rnd, starterRequest, starterWorld, world } from './helpers.ts';

async function app() {
  const w = await world();
  const counters = new Map<string, number>();
  const a = createApp({ network: 'testnet', params: P, issuerId: w.issuerId, contractId: '2aYj4Dkix7xXBUTZFCDBjpcqqLi9Tg5oUwBgHUJBNGCU', service: w.service, epochs: { status: { height: 1, issuingEpochs: [E - 1, E], keyIds: { [E]: 'ab' }, ready: true, problem: null } }, challengeTtlSec: 600, counters });
  return { w, a, counters };
}
const post = (path: string, body: unknown) => new Request(`http://x${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('issuer HTTP API', () => {
  it('challenge -> token -> finalize', async () => {
    const { w, a, counters } = await app();
    const mn = w.core.add(fakeMn());
    const ch = await (await a.fetch(post('/v1/challenge', {}))).json();
    expect(ch.nonce).toMatch(/^[0-9a-f]{80}$/);
    const r = await clientRequest(w, mn);
    const res = await a.fetch(post('/v1/token', r.body));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    const j = await res.json();
    expect(j.epoch).toBe(E);
    expect(await finishBadge(w, r, base64ToBytes(j.blindSig))).toBe(true);
    expect(counters.get('issued')).toBe(1);
    const dup = await a.fetch(post('/v1/token', (await clientRequest(w, mn)).body));
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe('already-issued');
  });

  it('preflight, info, 404, bad JSON, oversized body', async () => {
    const { a } = await app();
    const pre = await a.fetch(new Request('http://x/v1/token', { method: 'OPTIONS', headers: { origin: 'https://gov.dashhq.org', 'access-control-request-method': 'POST' } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    const info = await (await a.fetch(new Request('http://x/v1/info'))).json();
    expect(info).toMatchObject({ variant: 'RSABSSA-SHA384-PSS-Randomized', network: 'testnet', issuingEpochs: [E - 1, E], ready: true, problem: null });
    expect((await a.fetch(new Request('http://x/nope'))).status).toBe(404);
    expect((await a.fetch(post('/v1/token', '{not json'))).status).toBe(400);
    expect((await a.fetch(post('/v1/token', { request: 'x'.repeat(5000) }))).status).toBe(413);
  });

});

describe('starter HTTP API', () => {
  async function starterApp() {
    const w = await world();
    const sw = await starterWorld();
    const spki = sw.signer.spki;
    const keys = [{ epoch: E, keyId: await sha256(spki), spki }];
    const counters = new Map<string, number>();
    const a = createApp({
      network: 'testnet',
      params: P,
      issuerId: w.issuerId,
      contractId: '2aYj4Dkix7xXBUTZFCDBjpcqqLi9Tg5oUwBgHUJBNGCU',
      service: w.service,
      epochs: { status: { height: 1, issuingEpochs: [E - 1, E], keyIds: {}, ready: true, problem: null } },
      challengeTtlSec: 600,
      counters,
      starter: { issuerId: sw.issuerId, service: sw.service, manager: { status: { height: 123, issuingEpochs: [E - 1, E], keyIds: {}, ready: true, problem: null }, keys: () => keys }, challengeTtlSec: 1800 },
    });
    return { sw, a, counters, spki };
  }

  it('404 for every starter route when the starter is not configured', async () => {
    const { a } = await app();
    for (const r of [new Request('http://x/v1/starter/info'), post('/v1/starter/challenge', {}), post('/v1/starter/token', {})]) expect((await a.fetch(r)).status).toBe(404);
  });

  it('info: the starter identity, issuing epochs and the redeemable keys', async () => {
    const { sw, a } = await starterApp();
    const res = await a.fetch(new Request('http://x/v1/starter/info'));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const info = await res.json();
    expect(Object.keys(info).sort()).toEqual(['challengeTtlSec', 'contractId', 'epochParams', 'height', 'issuerId', 'issuingEpochs', 'keys', 'network', 'note', 'problem', 'ready', 'variant']);
    expect(info).toMatchObject({ variant: 'RSABSSA-SHA384-PSS-Randomized', network: 'testnet', issuerId: sw.issuerId, contractId: '2aYj4Dkix7xXBUTZFCDBjpcqqLi9Tg5oUwBgHUJBNGCU', epochParams: P, height: 123, issuingEpochs: [E - 1, E], ready: true, challengeTtlSec: 1800 });
    expect(info.keys).toEqual([{ epoch: E, keyId: expect.stringMatching(/^[0-9a-f]{64}$/), spki: expect.any(String) }]);
    expect(base64ToBytes(info.keys[0].spki)).toEqual(sw.signer.spki);
  });

  it('challenge -> token -> finalize for an MN and a proposal; duplicates and errors are counted under starter-', async () => {
    const { sw, a, counters } = await starterApp();
    const ch = await (await a.fetch(post('/v1/starter/challenge', {}))).json();
    expect(ch.nonce).toMatch(/^[0-9a-f]{80}$/);
    expect(ch.expiresAt).toBe(sw.now.sec + 1800);
    const mn = sw.core.add(fakeMn());
    const p = sw.core.addProposal(fakeProposal());
    for (const subject of [mnSubject(mn), proposalSubject(p)]) {
      const r = await starterRequest(sw, subject);
      const res = await a.fetch(post('/v1/starter/token', r.body));
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const j = await res.json();
      expect(j.epoch).toBe(E);
      expect(await finishStarter(sw, r, base64ToBytes(j.blindSig))).toBe(true);
      const dup = await a.fetch(post('/v1/starter/token', (await starterRequest(sw, subject)).body));
      expect(dup.status).toBe(409);
      expect((await dup.json()).error).toBe('already-issued');
    }
    const unavailable = await a.fetch(post('/v1/starter/token', (await starterRequest(sw, mnSubject(sw.core.add(fakeMn())), { epoch: E - 1 })).body));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('retry-after')).toBe('5');
    const wrongEpoch = await (await a.fetch(post('/v1/starter/token', (await starterRequest(sw, mnSubject(mn), { epoch: E + 1 })).body))).json();
    expect(wrongEpoch).toMatchObject({ error: 'wrong-epoch', issuingEpoch: E - 1 });
    expect((await a.fetch(post('/v1/starter/token', '{nope'))).status).toBe(400);
    expect((await a.fetch(post('/v1/starter/token', { request: 'x'.repeat(5000) }))).status).toBe(413);
    expect((await a.fetch(post('/v1/starter/token', { ...(await starterRequest(sw, mnSubject(mn), { signWith: rnd(32) })).body }))).status).toBe(403);
    expect(Object.fromEntries(counters)).toEqual({ 'starter-issued': 2, 'starter-already-issued': 2, 'starter-unavailable': 1, 'starter-wrong-epoch': 1, 'starter-bad-request': 1, 'starter-unauthorized': 1 });
  });
});
