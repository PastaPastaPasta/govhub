// GET/POST /v1/quorum-proof against a fake Core RPC: contract, validation, error mapping, cache, coalescing, limits.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openArchive } from '../src/archive/db.ts';
import { createApi } from '../src/api/server.ts';
import { Bridge } from '../src/bridge.ts';
import { loadConfig } from '../src/config.ts';
import { CoreRpcError } from '../src/core/rpc.ts';

const CP = 'ab'.repeat(32);
const QH = 'cd'.repeat(32);
const CHAIN = Buffer.concat([Buffer.from('DASHNC02'), Buffer.from([1, 2, 3, 255])]);
const BOOT = Buffer.concat([Buffer.from('DASHNC02'), Buffer.from([9, 8, 7, 0, 0, 1])]);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const coreResult = (targetHeight = 1234) => ({ proof_hex: CHAIN.toString('hex'), bootstrap_hex: BOOT.toString('hex'), target: { network: 1, height: targetHeight, block_hash: '11'.repeat(32), masternode_root: '22'.repeat(32), quorum_root: '33'.repeat(32) } });

/** A bridge whose Core RPC is a script. Everything Core sees is recorded in `calls`. */
function setup(env: Record<string, string> = {}) {
  const b = new Bridge(loadConfig({ PUBLISH: '0', CORE_NETWORK: 'testnet', CLIENT_IP_HEADER: 'x-test-ip', QUORUM_PROOF_COOLDOWN_MS: '0', ...env }), openArchive(':memory:'));
  const core = {
    calls: [] as Array<{ method: string; params: unknown[]; opts: unknown }>,
    header: async (_hash: string): Promise<unknown> => ({ hash: CP, height: 1000, confirmations: 51 }),
    proof: async (_params: unknown[]): Promise<unknown> => coreResult(),
    count: (method: string) => core.calls.filter((c) => c.method === method).length,
  };
  (b.rpc as unknown as { call: unknown }).call = async (method: string, params: unknown[] = [], opts?: unknown) => {
    core.calls.push({ method, params, opts });
    if (method === 'getblockheader') return core.header(params[0] as string);
    if (method === 'getquorumproofchain') return core.proof(params);
    throw new Error(`unexpected Core call ${method}`);
  };
  const clock = { t: 1_000_000 };
  const app = createApi(b, { now: () => clock.t });
  const req = (path: string, init?: RequestInit) => app.request(path, init);
  const post = (body: unknown, headers: Record<string, string> = {}) => app.request('/v1/quorum-proof', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { b, app, core, clock, req, post };
}

const q = (o: Record<string, string | number>) => '/v1/quorum-proof?' + new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
const json = async (r: Response) => (await r.json()) as { error: string; message: string };
const bytes = async (r: Response) => Buffer.from(await r.arrayBuffer());

describe('success', () => {
  it('GET returns the exact DASHNC02 chain bytes with informational headers', async () => {
    const t = setup();
    const r = await t.req(q({ checkpoint: CP }), { headers: { Origin: 'https://gov.dashhq.org' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-proof-target-height')).toBe('1234');
    expect(r.headers.get('x-proof-format')).toBe('chain');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const exposed = (r.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    expect(exposed).toContain('x-proof-target-height');
    expect(exposed).toContain('x-proof-format');
    expect((await bytes(r)).equals(CHAIN)).toBe(true);
    // Core got: checkpoint, height 0, no quorum, type 0, no nodes; the lookup and the proof call carry their own timeouts, no retries
    const call = t.core.calls.find((c) => c.method === 'getquorumproofchain')!;
    expect(call.params).toEqual([CP, 0, '', 0, 0]);
    expect(call.opts).toMatchObject({ retries: 0, timeoutMs: 90_000 });
    expect(t.core.calls[0]).toMatchObject({ method: 'getblockheader', params: [CP, true] });
  });

  it('GET with a quorum returns the bootstrap bytes', async () => {
    const t = setup();
    const r = await t.req(q({ checkpoint: CP.toUpperCase(), height: 1100, quorumHash: QH.toUpperCase(), llmqType: 6, nodeCount: 4 }));
    expect(r.status).toBe(200);
    expect(r.headers.get('x-proof-format')).toBe('bootstrap');
    expect((await bytes(r)).equals(BOOT)).toBe(true);
    expect(t.core.calls.find((c) => c.method === 'getquorumproofchain')!.params).toEqual([CP, 1100, QH, 6, 4]);
  });

  it('nodeCount alone also asks for records (bootstrap)', async () => {
    const t = setup();
    const r = await t.req(q({ checkpoint: CP, nodeCount: 3 }));
    expect(r.headers.get('x-proof-format')).toBe('bootstrap');
    expect((await bytes(r)).equals(BOOT)).toBe(true);
    expect(t.core.calls.find((c) => c.method === 'getquorumproofchain')!.params).toEqual([CP, 0, '', 0, 3]);
  });

  it('POST takes the quorum-list-server body and returns the same bytes as GET', async () => {
    const t = setup();
    const r = await t.post({ checkpoint: CP, height: 1, quorumHash: QH, llmqType: 6, nodeCount: 4 });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('x-proof-format')).toBe('bootstrap');
    expect((await bytes(r)).equals(BOOT)).toBe(true);
    // the optional fields may be left out
    const r2 = await t.post({ checkpoint: CP });
    expect(r2.status).toBe(200);
    expect(r2.headers.get('x-proof-format')).toBe('chain');
    expect((await bytes(r2)).equals(CHAIN)).toBe(true);
    // and the GET of the same request is served from the cache entry the POST made
    const before = t.core.count('getquorumproofchain');
    expect((await bytes(await t.req(q({ checkpoint: CP })))).equals(CHAIN)).toBe(true);
    expect(t.core.count('getquorumproofchain')).toBe(before);
  });

  it('serves the bytes of a HEAD request without a body', async () => {
    const t = setup();
    const r = await t.req(q({ checkpoint: CP }), { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect((await bytes(r)).length).toBe(0);
  });
});

describe('request validation (Core is never called)', () => {
  const badQueries: Record<string, string> = {
    'missing checkpoint': '/v1/quorum-proof',
    'short checkpoint': q({ checkpoint: 'abcd' }),
    'non-hex checkpoint': q({ checkpoint: 'zz'.repeat(32) }),
    'unknown parameter': q({ checkpoint: CP, foo: 1 }),
    'negative height': q({ checkpoint: CP, height: -1 }),
    'height above 2^31-1': q({ checkpoint: CP, height: 2 ** 31 }),
    'fractional height': q({ checkpoint: CP, height: '1.5' }),
    'non-numeric height': q({ checkpoint: CP, height: 'abc' }),
    'quorumHash without llmqType': q({ checkpoint: CP, quorumHash: QH }),
    'llmqType without quorumHash': q({ checkpoint: CP, llmqType: 6 }),
    'bad quorumHash': q({ checkpoint: CP, quorumHash: 'cd', llmqType: 6 }),
    'llmqType 0 with a quorum': q({ checkpoint: CP, quorumHash: QH, llmqType: 0 }),
    'llmqType 256': q({ checkpoint: CP, quorumHash: QH, llmqType: 256 }),
    'nodeCount 16': q({ checkpoint: CP, nodeCount: 16 }),
    'negative nodeCount': q({ checkpoint: CP, nodeCount: -1 }),
    'repeated parameter': `/v1/quorum-proof?checkpoint=${CP}&checkpoint=${CP}`,
  };
  for (const [name, path] of Object.entries(badQueries)) {
    it(`GET: ${name} -> 400`, async () => {
      const t = setup();
      const r = await t.req(path);
      expect(r.status).toBe(400);
      expect((await json(r)).error).toBe('bad-request');
      expect(t.core.calls).toHaveLength(0);
    });
  }

  const badBodies: Record<string, unknown> = {
    'unknown field': { checkpoint: CP, extra: 1 },
    'snake_case field': { checkpoint: CP, quorum_hash: QH },
    'quorumHash without llmqType': { checkpoint: CP, quorumHash: QH },
    'bad checkpoint': { checkpoint: 'nothex' },
    'height as a string': { checkpoint: CP, height: '5' },
    'fractional nodeCount': { checkpoint: CP, nodeCount: 1.5 },
    'array body': [CP],
    'not JSON': '{nope',
    'empty body': '',
  };
  for (const [name, body] of Object.entries(badBodies)) {
    it(`POST: ${name} -> 400`, async () => {
      const t = setup();
      const r = await t.post(body);
      expect(r.status).toBe(400);
      expect((await json(r)).error).toBe('bad-request');
      expect(t.core.calls).toHaveLength(0);
    });
  }

  it('POST: a body over 1 KB is refused with 413', async () => {
    const t = setup();
    const r = await t.post({ checkpoint: CP, pad: 'x'.repeat(2000) });
    expect(r.status).toBe(413);
    expect(t.core.calls).toHaveLength(0);
  });
});

describe('error mapping', () => {
  it('Core without the method -> 501 unsupported, remembered so Core is not asked again', async () => {
    const t = setup();
    t.core.proof = async () => {
      throw new CoreRpcError('getquorumproofchain', -32601, 'Method not found');
    };
    const r = await t.req(q({ checkpoint: CP }));
    expect(r.status).toBe(501);
    const body = await json(r);
    expect(body.error).toBe('unsupported');
    expect(body.message).toContain('Dash Core v24');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const before = t.core.calls.length;
    expect((await t.req(q({ checkpoint: CP, height: 5 }))).status).toBe(501);
    expect(t.core.calls.length).toBe(before);
    // a minute later Core is asked again (it may have been upgraded)
    t.clock.t += 61_000;
    t.core.proof = async () => coreResult();
    expect((await t.req(q({ checkpoint: CP }))).status).toBe(200);
  });

  it('unknown checkpoint -> 404 checkpoint-unknown (header lookup: not found, side chain; or Core -8)', async () => {
    let t = setup();
    t.core.header = async () => {
      throw new CoreRpcError('getblockheader', -5, 'Block not found');
    };
    let r = await t.req(q({ checkpoint: CP }));
    expect(r.status).toBe(404);
    expect((await json(r)).error).toBe('checkpoint-unknown');
    expect(t.core.count('getquorumproofchain')).toBe(0);

    t = setup();
    t.core.header = async () => ({ height: 900, confirmations: -1 });
    r = await t.req(q({ checkpoint: CP }));
    expect(r.status).toBe(404);
    expect((await json(r)).error).toBe('checkpoint-unknown');

    t = setup();
    t.core.proof = async () => {
      throw new CoreRpcError('getquorumproofchain', -8, 'Checkpoint is not on the active chain');
    };
    r = await t.req(q({ checkpoint: CP }));
    expect(r.status).toBe(404);
    expect((await json(r)).error).toBe('checkpoint-unknown');
  });

  it('"No archived certificate" -> 409 not-yet with a minimum height, 422 no-bridge without', async () => {
    const t = setup();
    t.core.proof = async () => {
      throw new CoreRpcError('getquorumproofchain', -1, 'No archived certificate within search budget');
    };
    let r = await t.req(q({ checkpoint: CP, height: 2000 }));
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe('not-yet');
    r = await t.req(q({ checkpoint: CP }));
    expect(r.status).toBe(422);
    expect((await json(r)).error).toBe('no-bridge');
  });

  it('the other -1 proof errors -> 422 no-bridge', async () => {
    for (const m of ['No bridge to snapshot within search budget', 'Requested quorum is not in the target root', 'Chain changed during proof construction; retry']) {
      const t = setup();
      t.core.proof = async () => {
        throw new CoreRpcError('getquorumproofchain', -1, m);
      };
      const r = await t.req(q({ checkpoint: CP, height: 7 }));
      expect(r.status, m).toBe(422);
      expect((await json(r)).error).toBe('no-bridge');
    }
  });

  it('other Core -8 (invalid request) -> 400', async () => {
    const t = setup();
    t.core.proof = async () => {
      throw new CoreRpcError('getquorumproofchain', -8, 'Invalid proof request');
    };
    expect((await t.req(q({ checkpoint: CP }))).status).toBe(400);
  });

  it('transport errors and timeouts -> 502 core, without echoing credentials or Core bodies; messages are short', async () => {
    let t = setup();
    t.core.proof = async () => {
      throw new Error('connect ECONNREFUSED http://rpcuser:hunter2@127.0.0.1:19998');
    };
    let r = await t.req(q({ checkpoint: CP }));
    expect(r.status).toBe(502);
    let body = await json(r);
    expect(body.error).toBe('core');
    expect(JSON.stringify(body)).not.toContain('hunter2');

    t = setup();
    t.core.proof = async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    };
    r = await t.req(q({ checkpoint: CP }));
    expect(r.status).toBe(502);
    expect((await json(r)).error).toBe('core');

    t = setup();
    t.core.proof = async () => {
      throw new CoreRpcError('getquorumproofchain', -1, 'some brand new proof failure: ' + 'x'.repeat(1000));
    };
    r = await t.req(q({ checkpoint: CP }));
    expect(r.status).toBe(422);
    body = await json(r);
    expect(body.message.length).toBeLessThanOrEqual(200);

    t = setup();
    t.core.proof = async () => {
      throw new CoreRpcError('getquorumproofchain', -28, 'Loading block index...');
    };
    r = await t.req(q({ checkpoint: CP }));
    expect(r.status).toBe(502);
  });

  it('a malformed Core result -> 502 (not hex, missing target, empty bootstrap when records were requested)', async () => {
    for (const [result, path] of [
      [{ proof_hex: 'nothex', bootstrap_hex: '', target: { height: 5 } }, q({ checkpoint: CP })],
      [{ proof_hex: CHAIN.toString('hex'), bootstrap_hex: '' }, q({ checkpoint: CP })],
      [{ proof_hex: CHAIN.toString('hex'), bootstrap_hex: '', target: { height: 5 } }, q({ checkpoint: CP, nodeCount: 2 })],
    ] as const) {
      const t = setup();
      t.core.proof = async () => result;
      expect((await t.req(path)).status).toBe(502);
    }
  });
});

describe('span guard', () => {
  it('refuses a checkpoint further below the tip than QUORUM_PROOF_MAX_SPAN with 422, before asking for a proof', async () => {
    const t = setup(); // default max span 250000
    t.core.header = async () => ({ height: 1000, confirmations: 250_002 }); // span = 250001
    const r = await t.req(q({ checkpoint: CP }));
    expect(r.status).toBe(422);
    const body = await json(r);
    expect(body.error).toBe('checkpoint-too-old');
    expect(t.core.count('getquorumproofchain')).toBe(0);
    // exactly at the limit is fine
    t.core.header = async () => ({ height: 1000, confirmations: 250_001 });
    t.clock.t += 61_000; // the lookup cache has expired
    expect((await t.req(q({ checkpoint: CP }))).status).toBe(200);
  });

  it('the limit is configurable and the lookup is cached', async () => {
    const t = setup({ QUORUM_PROOF_MAX_SPAN: '100' });
    t.core.header = async () => ({ height: 1000, confirmations: 51 });
    expect((await t.req(q({ checkpoint: CP }))).status).toBe(200);
    expect((await t.req(q({ checkpoint: CP, height: 1 }))).status).toBe(200);
    expect(t.core.count('getblockheader')).toBe(1);
    t.core.header = async () => ({ height: 500, confirmations: 502 });
    const other = 'ef'.repeat(32);
    expect((await t.req(q({ checkpoint: other }))).status).toBe(422);
  });
});

describe('cache and coalescing', () => {
  it('two identical requests call Core once; a different request or an expired entry calls it again', async () => {
    const t = setup();
    const a = await t.req(q({ checkpoint: CP }));
    const b = await t.req(q({ checkpoint: CP.toUpperCase(), height: 0 })); // same request, normalized
    expect((await bytes(a)).equals(await bytes(b))).toBe(true);
    expect(t.core.count('getquorumproofchain')).toBe(1);
    await t.req(q({ checkpoint: CP, height: 5 }));
    expect(t.core.count('getquorumproofchain')).toBe(2);
    t.clock.t += 14_000;
    await t.req(q({ checkpoint: CP }));
    expect(t.core.count('getquorumproofchain')).toBe(2);
    t.clock.t += 2_000; // 16 s old: expired
    await t.req(q({ checkpoint: CP }));
    expect(t.core.count('getquorumproofchain')).toBe(3);
  });

  it('errors are not cached', async () => {
    const t = setup();
    t.core.proof = async () => {
      throw new CoreRpcError('getquorumproofchain', -1, 'No archived certificate within search budget');
    };
    expect((await t.req(q({ checkpoint: CP, height: 9 }))).status).toBe(409);
    t.core.proof = async () => coreResult(9);
    expect((await t.req(q({ checkpoint: CP, height: 9 }))).status).toBe(200);
  });

  it('concurrent identical requests share one Core call (and one rate token)', async () => {
    const t = setup({ QUORUM_PROOF_RATE_BURST: '1' });
    const gate = deferred<unknown>();
    t.core.proof = () => gate.promise;
    const rs = Array.from({ length: 5 }, (_, i) => (i % 2 ? t.req(q({ checkpoint: CP })) : t.post({ checkpoint: CP })));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.core.count('getquorumproofchain')).toBe(1);
    gate.resolve(coreResult());
    for (const r of await Promise.all(rs)) {
      expect(r.status).toBe(200);
      expect((await bytes(r)).equals(CHAIN)).toBe(true);
    }
    expect(t.core.count('getquorumproofchain')).toBe(1);
  });

  it('evicts the oldest entries beyond 64', async () => {
    const u = setup({ QUORUM_PROOF_RATE_BURST: '1000', QUORUM_PROOF_RATE_PER_MIN: '100000' });
    for (let h = 1; h <= 65; h++) expect((await u.req(q({ checkpoint: CP, height: h }))).status).toBe(200);
    expect(u.core.count('getquorumproofchain')).toBe(65);
    await u.req(q({ checkpoint: CP, height: 65 })); // newest: cached
    expect(u.core.count('getquorumproofchain')).toBe(65);
    await u.req(q({ checkpoint: CP, height: 1 })); // oldest: evicted
    expect(u.core.count('getquorumproofchain')).toBe(66);
  });
});

describe('rate limit and queue', () => {
  it('429 with Retry-After after the burst; cache hits are free; clients are separate; tokens refill', async () => {
    const t = setup({ QUORUM_PROOF_RATE_BURST: '2', QUORUM_PROOF_RATE_PER_MIN: '12' });
    const as = (ip: string, h: number) => t.req(q({ checkpoint: CP, height: h }), { headers: { 'x-test-ip': ip } });
    expect((await as('203.0.113.7', 1)).status).toBe(200);
    expect((await as('203.0.113.7', 2)).status).toBe(200);
    expect((await as('203.0.113.7', 1)).status).toBe(200); // cache hit: no token
    const limited = await as('203.0.113.7', 3);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await json(limited)).error).toBe('rate-limited');
    expect(t.core.count('getquorumproofchain')).toBe(2);
    expect((await as('203.0.113.8', 3)).status).toBe(200); // another client
    t.clock.t += 5_000; // 12/min = one token per 5 s
    expect((await as('203.0.113.7', 4)).status).toBe(200);
    expect((await as('203.0.113.7', 5)).status).toBe(429);
  });

  it('IPv6 clients share a bucket per /64', async () => {
    const t = setup({ QUORUM_PROOF_RATE_BURST: '1' });
    const as = (ip: string, h: number) => t.req(q({ checkpoint: CP, height: h }), { headers: { 'x-test-ip': ip } });
    expect((await as('2001:db8:1:2::1', 1)).status).toBe(200);
    expect((await as('2001:db8:1:2:ffff::9', 2)).status).toBe(429);
    expect((await as('2001:db8:1:3::1', 2)).status).toBe(200);
  });

  it('without CLIENT_IP_HEADER the header is ignored (forged headers do not make new buckets)', async () => {
    const t = setup({ CLIENT_IP_HEADER: '', QUORUM_PROOF_RATE_BURST: '1' });
    const as = (ip: string, h: number) => t.req(q({ checkpoint: CP, height: h }), { headers: { 'x-test-ip': ip, 'x-forwarded-for': ip } });
    expect((await as('203.0.113.1', 1)).status).toBe(200);
    expect((await as('203.0.113.2', 2)).status).toBe(429);
  });

  it('503 busy when the workers and the queue are full; queued work runs when a worker frees up', async () => {
    const t = setup({ QUORUM_PROOF_WORKERS: '1', QUORUM_PROOF_QUEUE: '1', QUORUM_PROOF_RATE_BURST: '100' });
    const gates: Array<Deferred<unknown>> = [];
    t.core.proof = () => {
      const g = deferred<unknown>();
      gates.push(g);
      return g.promise;
    };
    const first = t.req(q({ checkpoint: CP, height: 1 }));
    const second = t.req(q({ checkpoint: CP, height: 2 })); // waits in the queue
    await new Promise((r) => setTimeout(r, 20));
    expect(gates).toHaveLength(1);
    const third = await t.req(q({ checkpoint: CP, height: 3 }));
    expect(third.status).toBe(503);
    expect((await json(third)).error).toBe('busy');
    expect(third.headers.get('retry-after')).toBeTruthy();
    gates[0]!.resolve(coreResult(1));
    expect((await first).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(gates).toHaveLength(2);
    gates[1]!.resolve(coreResult(2));
    expect((await second).status).toBe(200);
  });

  it('at most QUORUM_PROOF_WORKERS Core calls at once (default 2)', async () => {
    const t = setup({ QUORUM_PROOF_RATE_BURST: '100' });
    let running = 0;
    let peak = 0;
    t.core.proof = async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 15));
      running--;
      return coreResult();
    };
    const rs = await Promise.all([1, 2, 3, 4, 5].map((h) => t.req(q({ checkpoint: CP, height: h }))));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(peak).toBe(2);
  });

  it('a worker whose call timed out stays reserved for the cooldown', async () => {
    const t = setup({ QUORUM_PROOF_WORKERS: '1', QUORUM_PROOF_QUEUE: '0', QUORUM_PROOF_COOLDOWN_MS: '600000', QUORUM_PROOF_RATE_BURST: '100' });
    t.core.proof = async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    };
    expect((await t.req(q({ checkpoint: CP, height: 1 }))).status).toBe(502);
    t.core.proof = async () => coreResult();
    expect((await t.req(q({ checkpoint: CP, height: 2 }))).status).toBe(503);
  });
});

describe('enable switch, methods, CORS, spec', () => {
  it('QUORUM_PROOF=0 -> 404 for GET and POST', async () => {
    const t = setup({ QUORUM_PROOF: '0' });
    expect((await t.req(q({ checkpoint: CP }))).status).toBe(404);
    expect((await t.post({ checkpoint: CP })).status).toBe(404);
    expect(t.core.calls).toHaveLength(0);
  });

  it('POST is allowed on this path only; other methods and other paths stay read-only', async () => {
    const t = setup();
    const put = await t.req(q({ checkpoint: CP }), { method: 'PUT' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, HEAD, OPTIONS, POST');
    expect((await t.req('/v1/status', { method: 'POST' })).status).toBe(405);
  });

  it('CORS: any origin may GET and read the proof headers; preflight allows POST with content-type here only', async () => {
    const t = setup();
    const pre = await t.req('/v1/quorum-proof', { method: 'OPTIONS', headers: { Origin: 'https://gov.dashhq.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    expect((pre.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain('content-type');
    const other = await t.req('/v1/status', { method: 'OPTIONS', headers: { Origin: 'https://gov.dashhq.org', 'Access-Control-Request-Method': 'GET' } });
    expect(other.headers.get('access-control-allow-methods')).not.toContain('POST');
    const err = await t.req(q({ checkpoint: 'zz' }), { headers: { Origin: 'https://x.example' } });
    expect(err.status).toBe(400);
    expect(err.headers.get('access-control-allow-origin')).toBe('*');
    const limited = setup({ QUORUM_PROOF_RATE_BURST: '1' });
    await limited.req(q({ checkpoint: CP, height: 1 }));
    const r429 = await limited.req(q({ checkpoint: CP, height: 2 }), { headers: { Origin: 'https://x.example' } });
    expect(r429.status).toBe(429);
    expect((r429.headers.get('access-control-expose-headers') ?? '').toLowerCase()).toContain('retry-after');
  });

  it('openapi.json documents GET and POST with the error codes the server uses', () => {
    const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
    const p = spec.paths['/v1/quorum-proof'];
    expect(Object.keys(p).sort()).toEqual(['get', 'post']);
    for (const op of [p.get, p.post]) {
      expect(op.responses['200'].content['application/octet-stream']).toBeTruthy();
      expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['400', '404', '409', '422', '429', '501', '502', '503']));
    }
    expect(p.get.parameters.map((x: { name: string }) => x.name).sort()).toEqual(['checkpoint', 'height', 'llmqType', 'nodeCount', 'quorumHash']);
  });
});
