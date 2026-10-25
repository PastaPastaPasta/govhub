// Logging policy (docs/TRUST.md section 7, docs/PLAN.md "No linkable logs"): nothing that could link a request to a client reaches
// stdout or stderr (which Docker's json-file driver keeps): no IP address, user agent, or the proposal / height a client asked for.
// This drives every endpoint of the HTTP API, error paths included (the API logs only on those), at the most verbose log level,
// and searches everything that was written.
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerQuorumProof } from '../src/api/quorumproof.ts';
import { createApi } from '../src/api/server.ts';
import { loadConfig } from '../src/config.ts';
import { log } from '../src/log.ts';
import { votesFixture } from './helpers.ts';
import { fixtureBridge } from './world.ts';

const CF_IP = '203.0.113.77';
const FWD_IP = '198.51.100.23';
const FWD_FORGED = '192.0.2.99'; // left of the proxy's own entry: client-controlled, still must not be logged
const HDR_IP = '203.0.113.200';
const V6_IP = '2001:db8:bad:cafe::17';
const IPS = [CF_IP, FWD_IP, FWD_FORGED, HDR_IP, '2001:db8:bad:cafe'];
const UA = 'Mozilla/5.0 (bridge-log-test; distinctive-agent-7731)';
const IP_HEADER = 'x-test-ip';
const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
  'cf-connecting-ip': CF_IP,
  'x-forwarded-for': `${FWD_FORGED}, ${FWD_IP}`,
  [IP_HEADER]: HDR_IP,
  'user-agent': UA,
  ...extra,
});

// what a client asks for
const KNOWN_HASH = votesFixture().proposals[votesFixture().proposals.length - 1]!.govHash; // archived, with votes
const UNKNOWN_HASH = '5eed'.repeat(16);
const SECRET_HEIGHT = '7654321'; // above the latest tally: 404, and not a number the bridge ever logs
const CHECKPOINTS = Array.from({ length: 6 }, (_, i) => `${(0xc0 + i).toString(16)}${'ab'.repeat(31)}${i}f`.slice(0, 64));
const QUORUM_HASH = 'e1'.repeat(32);
const NEEDLES = [...IPS, UA, KNOWN_HASH, UNKNOWN_HASH, SECRET_HEIGHT, ...CHECKPOINTS, QUORUM_HASH];

describe('no linkable logs (bridge API)', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    log.setLevel('debug'); // the most verbose level must still be clean
    const keep = (chunk: unknown) => (out.push(String(chunk)), true);
    vi.spyOn(process.stderr, 'write').mockImplementation(keep as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(keep as never);
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    log.setLevel('error');
  });

  /** Core is a script: getblockheader answers, getquorumproofchain answers or fails. */
  function fakeCore(b: { rpc: unknown }, proof: () => Promise<unknown>): void {
    (b.rpc as { call: unknown }).call = async (method: string, params: unknown[] = []) => {
      if (method === 'getblockheader') return { hash: params[0], height: 1000, confirmations: 51 };
      if (method === 'getquorumproofchain') return proof();
      throw new Error(`unexpected Core call ${method}`);
    };
  }
  const goodProof = async () => ({ proof_hex: '4441534e433032010203ff', bootstrap_hex: '4441534e43303201', target: { height: 1234 } });

  it('requests to every endpoint, errors included, write nothing that names the client or what it asked for', async () => {
    // Setup logs the fixture's own objects (the bridge's ingest records, not client-linked); the request phase starts after it.
    const b = await fixtureBridge({ CLIENT_IP_HEADER: IP_HEADER, QUORUM_PROOF_RATE_BURST: '2', QUORUM_PROOF_RATE_PER_MIN: '1', QUORUM_PROOF_COOLDOWN_MS: '0' });
    const broken = await fixtureBridge({ CLIENT_IP_HEADER: IP_HEADER });
    const failing = await fixtureBridge({ CLIENT_IP_HEADER: IP_HEADER });
    const garbage = await fixtureBridge({ CLIENT_IP_HEADER: IP_HEADER });
    fakeCore(b, goodProof);
    fakeCore(broken, goodProof);
    fakeCore(failing, async () => {
      throw new Error('connect ECONNREFUSED core:9998');
    });
    fakeCore(garbage, async () => ({ proof_hex: 'zz', target: { height: 1 } }));
    const app = createApi(b);
    const brokenApp = createApi(broken);
    const failApp = createApi(failing);
    const garbageApp = createApi(garbage);
    broken.db.close(); // every handler that touches the archive now throws: server.ts's onError logs
    out.length = 0;

    const call = (a: Hono, path: string, init: RequestInit = {}) => a.request(path, { ...init, headers: headers(init.headers as Record<string, string>) });
    const seen: Record<string, number[]> = {};
    const hit = async (label: string, p: Response | Promise<Response>) => {
      const r = await p;
      await r.arrayBuffer();
      (seen[label] ??= []).push(r.status);
      return r;
    };

    // ---- the happy paths and ordinary errors of every endpoint
    expect((await hit('status', call(app, '/v1/status'))).status).toBe(200);
    expect((await hit('proposals', call(app, '/v1/proposals?state=all'))).status).toBe(200);
    expect((await hit('proposals', call(app, '/v1/proposals?state=nope'))).status).toBe(400);
    expect((await hit('proposal', call(app, `/v1/proposals/${KNOWN_HASH}`))).status).toBe(200);
    expect((await hit('proposal', call(app, `/v1/proposals/${KNOWN_HASH.toUpperCase()}`))).status).toBe(200);
    expect((await hit('proposal', call(app, `/v1/proposals/${UNKNOWN_HASH}`))).status).toBe(404);
    expect((await hit('proposal', call(app, '/v1/proposals/not-a-hash-77'))).status).toBe(400);
    expect((await hit('votes', call(app, `/v1/proposals/${KNOWN_HASH}/votes`))).status).toBe(200);
    expect((await hit('votes', call(app, `/v1/proposals/${KNOWN_HASH}/votes?all=1`))).status).toBe(200);
    expect((await hit('votes', call(app, `/v1/proposals/${KNOWN_HASH}/votes?height=${SECRET_HEIGHT}`))).status).toBe(404);
    expect((await hit('votes', call(app, `/v1/proposals/${KNOWN_HASH}/votes?height=-${SECRET_HEIGHT}`))).status).toBe(400);
    expect((await hit('votes', call(app, `/v1/proposals/${KNOWN_HASH}/votes?height=1.5`))).status).toBe(400);
    expect((await hit('votes', call(app, `/v1/proposals/${UNKNOWN_HASH}/votes`))).status).toBe(404);
    expect((await hit('votes', call(app, `/v1/proposals/${UNKNOWN_HASH}/votes?height=${SECRET_HEIGHT}`))).status).toBe(404);
    expect((await hit('votes', call(app, '/v1/proposals/zz/votes'))).status).toBe(400);
    expect((await hit('mnlist', call(app, '/v1/mnlist'))).status).toBe(200);
    expect((await hit('mnlist', call(app, `/v1/mnlist/${votesFixture().mnList.height}`))).status).toBe(200);
    expect((await hit('mnlist', call(app, `/v1/mnlist/${SECRET_HEIGHT}`))).status).toBe(200); // the latest snapshot at or below
    expect((await hit('mnlist', call(app, '/v1/mnlist/17'))).status).toBe(404);
    expect((await hit('mnlist', call(app, '/v1/mnlist/abc'))).status).toBe(400);
    expect((await hit('tallies', call(app, '/v1/tallies'))).status).toBe(200);
    expect((await hit('cycle', call(app, '/v1/cycle'))).status).toBe(200);
    expect((await hit('dashcentral', call(app, '/api/v1/budget'))).status).toBe(200);
    expect((await hit('dashcentral', call(app, `/api/v1/proposal?hash=${KNOWN_HASH}`))).status).toBe(200);
    expect((await hit('dashcentral', call(app, `/api/v1/proposal?hash=${UNKNOWN_HASH}`))).status).toBe(404);
    expect((await hit('unknown route', call(app, `/v1/nothing/${KNOWN_HASH}`))).status).toBe(404);

    // ---- wrong methods and CORS preflight
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await hit('405', call(app, `/v1/proposals/${KNOWN_HASH}`, { method }))).status).toBe(405);
      expect((await hit('405', call(app, '/v1/status', { method }))).status).toBe(405);
    }
    expect((await hit('405', call(app, `/v1/proposals/${KNOWN_HASH}/votes?height=${SECRET_HEIGHT}`, { method: 'PUT' }))).status).toBe(405);
    expect((await hit('preflight', call(app, `/v1/proposals/${KNOWN_HASH}`, { method: 'OPTIONS', headers: { Origin: 'https://gov.dashhq.org', 'Access-Control-Request-Method': 'GET' } }))).status).toBe(204);

    // ---- quorum proof: success (GET and POST), validation, junk and oversized bodies
    const cp = (i: number) => CHECKPOINTS[i]!;
    expect((await hit('qp', call(app, `/v1/quorum-proof?checkpoint=${cp(0)}`))).status).toBe(200);
    expect((await hit('qp', call(app, '/v1/quorum-proof', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkpoint: cp(1), quorumHash: QUORUM_HASH, llmqType: 4 }) }))).status).toBe(200);
    expect((await hit('qp', call(app, `/v1/quorum-proof?checkpoint=${cp(2)}&height=-5`))).status).toBe(400);
    expect((await hit('qp', call(app, `/v1/quorum-proof?checkpoint=${cp(2)}&bogus=${UNKNOWN_HASH}`))).status).toBe(400);
    expect((await hit('qp', call(app, '/v1/quorum-proof'))).status).toBe(400);
    const post = (body: string) => call(app, '/v1/quorum-proof', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect((await hit('qp', post('{junk'))).status).toBe(400);
    expect((await hit('qp', post('[]'))).status).toBe(400);
    expect((await hit('qp', post(JSON.stringify({ checkpoint: cp(3), extra: KNOWN_HASH })))).status).toBe(400);
    expect((await hit('qp', post(JSON.stringify({ checkpoint: cp(3), pad: 'x'.repeat(5000) })))).status).toBe(413);
    expect((await hit('qp', call(app, '/v1/quorum-proof', { method: 'DELETE' }))).status).toBe(405);

    // ---- quorum proof: the limiter trips (burst 2, one per minute; two cache misses above are already charged to this client)
    let limited: Response | undefined;
    for (let i = 3; i < CHECKPOINTS.length && !limited; i++) {
      const r = await hit('qp', call(app, `/v1/quorum-proof?checkpoint=${cp(i)}`));
      if (r.status === 429) limited = r;
    }
    expect(limited?.status, 'the rate limiter must trip').toBe(429);
    expect(limited!.headers.get('retry-after')).toBeTruthy();

    // ---- quorum proof: Core fails (the service logs a warning), and answers garbage
    expect((await hit('qp core down', call(failApp, `/v1/quorum-proof?checkpoint=${cp(4)}`))).status).toBe(502);
    expect((await hit('qp core down', call(failApp, `/v1/quorum-proof?checkpoint=${cp(5)}&height=${SECRET_HEIGHT}`))).status).toBe(502);
    expect((await hit('qp garbage', call(garbageApp, `/v1/quorum-proof?checkpoint=${cp(5)}`))).status).toBe(502);

    // ---- the archive fails mid-request: server.ts logs on its error path
    for (const path of ['/v1/status', `/v1/proposals/${KNOWN_HASH}`, `/v1/proposals/${KNOWN_HASH}/votes`, `/v1/proposals/${KNOWN_HASH}/votes?height=${SECRET_HEIGHT}`, '/v1/proposals?state=all', `/v1/mnlist/${SECRET_HEIGHT}`]) {
      expect((await hit('500', call(brokenApp, path))).status, path).toBe(500);
    }

    // ---- an IPv6 client
    expect((await hit('v6', call(app, `/v1/proposals/${KNOWN_HASH}`, { headers: { [IP_HEADER]: V6_IP, 'x-forwarded-for': V6_IP } }))).status).toBe(200);

    // ---- the checks
    const all = out.join('\n');
    // not vacuous: the error paths really wrote lines
    expect(all, 'the API error path must have logged').toContain('api error');
    expect(all, 'the error line names the route pattern, not the URL').toContain('"route":"/v1/proposals/:hash"');
    expect(all).toContain('quorum proof: Core call failed');
    expect(all).toContain('quorum proof: malformed getquorumproofchain result');
    expect(Object.keys(seen).length).toBeGreaterThan(10);
    for (const needle of [...NEEDLES, V6_IP, KNOWN_HASH.toUpperCase()]) expect(all, `needle ${needle} leaked into the log output`).not.toContain(needle);
    // no line may pair a requested govHash (or any govHash field) with a request's identity
    for (const line of out) {
      expect(/govHash/i.test(line) && /identity|client|\bip\b|user-?agent/i.test(line), `govHash paired with an identity in: ${line}`).toBe(false);
    }
    expect(all).not.toMatch(/govHash/i);
  });

  it('the quorum-proof limiter holds no raw address in memory, only salted HMAC keys', async () => {
    const cfg = loadConfig({ PUBLISH: '0', CORE_NETWORK: 'testnet', CLIENT_IP_HEADER: IP_HEADER, QUORUM_PROOF_RATE_BURST: '4' });
    const app = new Hono();
    const rpc = {
      call: async (method: string, params: unknown[] = []): Promise<any> => (method === 'getblockheader' ? { hash: params[0], height: 1000, confirmations: 51 } : { proof_hex: '4441534e433032', target: { height: 1234 } }),
    };
    const service = registerQuorumProof(app, rpc, cfg);
    const clients = [HDR_IP, V6_IP, '198.51.100.250'];
    for (const [i, ip] of clients.entries()) {
      const r = await app.request(`/v1/quorum-proof?checkpoint=${CHECKPOINTS[i]}`, { headers: { [IP_HEADER]: ip, 'user-agent': UA, 'cf-connecting-ip': CF_IP } });
      expect(r.status).toBe(200);
    }
    // Inspecting a private field is the only way to see the limiter's keys without a production accessor.
    const limiter = (service as unknown as { limiter: { size: number; buckets: Map<string, { tokens: number; at: number }> } }).limiter;
    expect(limiter.size).toBe(3);
    const keys = [...limiter.buckets.keys()];
    const dump = JSON.stringify([...limiter.buckets.entries()]);
    for (const needle of [...clients, '2001:db8:bad:cafe', CF_IP, UA]) {
      expect(dump, needle).not.toContain(needle);
      expect(dump, needle).not.toContain(Buffer.from(needle).toString('base64'));
      expect(dump, needle).not.toContain(Buffer.from(needle).toString('hex'));
    }
    // a salted HMAC (32 bytes -> 44 base64 chars), not the plain hash of the address
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    for (const ip of clients) expect(keys).not.toContain(createHash('sha256').update(ip).digest('base64'));
    // and nothing else on the service object or the limiter holds an address
    const walk = (v: unknown, seenObjs = new Set<unknown>()): string[] => {
      if (typeof v === 'string') return [v];
      if (!v || typeof v !== 'object' || seenObjs.has(v)) return [];
      seenObjs.add(v);
      const kids = v instanceof Map ? [...v.keys(), ...v.values()] : v instanceof Set ? [...v] : Object.values(v);
      return kids.flatMap((k) => walk(k, seenObjs));
    };
    const strings = walk(service).join('\n');
    for (const ip of [...clients, CF_IP]) expect(strings, ip).not.toContain(ip);
  });
});
