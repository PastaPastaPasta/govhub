// HTTP surface: CORS without credentials, no caching, body limit, JSON errors, and a full token round trip.
import { describe, expect, it } from 'vitest';
import { base64ToBytes } from '@govhub/badge';
import { createApp } from '../src/server.ts';
import { clientRequest, E, fakeMn, finishBadge, P, world } from './helpers.ts';

async function app() {
  const w = await world();
  const counters = new Map<string, number>();
  const a = createApp({ network: 'testnet', params: P, issuerId: w.issuerId, contractId: '2aYj4Dkix7xXBUTZFCDBjpcqqLi9Tg5oUwBgHUJBNGCU', service: w.service, epochs: { status: { height: 1, issuingEpoch: E, keyId: 'ab', ready: true, problem: null } }, challengeTtlSec: 600, counters });
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
    expect(info).toMatchObject({ variant: 'RSABSSA-SHA384-PSS-Randomized', network: 'testnet', issuingEpoch: E, ready: true });
    expect((await a.fetch(new Request('http://x/nope'))).status).toBe(404);
    expect((await a.fetch(post('/v1/token', '{not json'))).status).toBe(400);
    expect((await a.fetch(post('/v1/token', { request: 'x'.repeat(5000) }))).status).toBe(413);
  });

});
