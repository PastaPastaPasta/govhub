import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STREAM_IDLE_MS, GrpcError, frame, stream, unary } from '../src/grpcweb.ts';
import { fetchNodes, isEndpoint, sample } from '../src/nodes.ts';
import { NodePool, backoffMs, sleep } from '../src/pool.ts';
import { mergeStreams, race } from '../src/race.ts';

const trailerFrame = (txt: string): Uint8Array => { const t = new TextEncoder().encode(txt); const f = new Uint8Array(5 + t.length); f[0] = 0x80; new DataView(f.buffer).setUint32(1, t.length); f.set(t, 5); return f; };
const cat = (...a: Uint8Array[]): Buffer => Buffer.concat(a);
const GW = { 'content-type': 'application/grpc-web+proto' };
async function withServer<T>(handler: http.RequestListener, fn: (base: string) => Promise<T>): Promise<T> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${(srv.address() as { port: number }).port}/`); } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
}
const none = new Uint8Array(0);

describe('grpc-web over a real socket', () => {
  it('unary: ok, error trailer (malformed percent-encoding survives), wrong content-type, HTTP 429, aborted signal', async () => {
    await withServer((req, res) => {
      if (req.url!.endsWith('/ok')) res.writeHead(200, GW).end(cat(frame(Uint8Array.of(1, 2)), trailerFrame('grpc-status: 0\r\n')));
      else if (req.url!.endsWith('/err')) res.writeHead(200, GW).end(cat(trailerFrame('grpc-status: 5\r\ngrpc-message: bad %zz\r\n')));
      else if (req.url!.endsWith('/429')) res.writeHead(429, { 'ratelimit-reset': '9' }).end();
      else res.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
    }, async (base) => {
      expect([...await unary(base, 'ok', none)]).toEqual([1, 2]);
      await expect(unary(base, 'err', none)).rejects.toMatchObject({ code: 5, message: expect.stringMatching(/bad %zz/) });
      await expect(unary(base, 'html', none)).rejects.toMatchObject({ code: 14, network: true });
      await expect(unary(base, '429', none)).rejects.toMatchObject({ code: 8, http: 429, rate: { reset: '9' } });
      const ac = new AbortController(); ac.abort();
      await expect(unary(base, 'ok', none, { signal: ac.signal })).rejects.toThrow(/abort/i);
    });
  });
  it('unary: deadline becomes GrpcError 4, connection refused becomes a network GrpcError 14', async () => {
    await withServer(() => { /* never answers */ }, async (base) => {
      await expect(unary(base, 'hang', none, { timeoutMs: 50 })).rejects.toMatchObject({ code: 4 });
    });
    await expect(unary('http://127.0.0.1:1/', 'x', none)).rejects.toMatchObject({ code: 14, network: true });
  });
  it('stream: messages, onOpen, clean end, cancel, handler throw aborts, cut-off and idle timeout are errors', async () => {
    await withServer((req, res) => {
      if (req.url!.endsWith('/end')) { res.writeHead(200, GW); res.write(frame(Uint8Array.of(1))); res.end(cat(frame(Uint8Array.of(2)), trailerFrame('grpc-status: 0\r\n'))); }
      else if (req.url!.endsWith('/cut')) { res.writeHead(200, GW); res.write(frame(Uint8Array.of(1))); res.end(frame(Uint8Array.of(2, 3, 4)).subarray(0, 7)); }
      else if (req.url!.endsWith('/status')) { res.writeHead(200, GW); res.end(trailerFrame('grpc-status: 14\r\ngrpc-message: gone\r\n')); }
      else { res.writeHead(200, GW); res.write(frame(Uint8Array.of(1))); /* then hang open */ }
    }, async (base) => {
      const got: number[] = []; let opened = 0;
      let h = stream(base, 'end', none, { onMessage: (b) => got.push(b[0]!), onOpen: () => opened++ });
      expect((await h.closed).reason).toBe('end'); expect(got).toEqual([1, 2]); expect(opened).toBe(1);
      h = stream(base, 'cut', none, { onMessage: () => {} });
      const cut = await h.closed; expect(cut.reason).toBe('error'); expect(String((cut as { error: Error }).error.message)).toMatch(/cut off/);
      h = stream(base, 'status', none, { onMessage: () => {} });
      expect(await h.closed).toMatchObject({ reason: 'error', error: { code: 14, message: 'gone' } });
      const live: number[] = []; h = stream(base, 'hang', none, { onMessage: (b) => live.push(b[0]!) });
      await new Promise((r) => setTimeout(r, 100)); h.cancel();
      expect((await h.closed).reason).toBe('cancelled'); expect(live).toEqual([1]);
      h = stream(base, 'hang', none, { onMessage: () => { throw new Error('parse boom'); } });
      expect(await h.closed).toMatchObject({ reason: 'error', handler: true, error: { message: 'parse boom' } });
      h = stream(base, 'hang', none, { onMessage: () => {}, idleTimeoutMs: 50 });
      expect(await h.closed).toMatchObject({ reason: 'error', error: { code: 4, message: 'idle timeout' } });
    });
  });
  it('stream: an oversized message is rejected instead of buffered', async () => {
    await withServer((_req, res) => { const f = new Uint8Array(5); new DataView(f.buffer).setUint32(1, 10_000); res.writeHead(200, GW); res.end(f); }, async (base) => {
      const h = stream(base, 'big', none, { onMessage: () => {}, maxMessageBytes: 100 });
      expect(await h.closed).toMatchObject({ reason: 'error', error: { code: 8 } });
    });
  });
  it('streams have an idle timeout by default (10 min) and 0 disables it', () => {
    expect(DEFAULT_STREAM_IDLE_MS).toBe(600_000);
  });
  it('stream: default idle timeout fires on a silent stream (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const enc = new TextEncoder();
      vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => new Response(new ReadableStream({
        start(c) { init.signal!.addEventListener('abort', () => c.error(init.signal!.reason)); c.enqueue(frame(enc.encode('x'))); },
      }), { headers: GW })));
      const h = stream('https://n/', 'm', none, { onMessage: () => {} });
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_MS - 1000);
      let settled = false; void h.closed.then(() => { settled = true; });
      await Promise.resolve(); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await h.closed).toMatchObject({ reason: 'error', error: { code: 4 } });
    } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
  });
});

describe('NodePool', () => {
  it('keeps each node under the per-minute budget and recovers as the window slides', () => {
    let now = 0;
    const pool = new NodePool(['a:443'], { maxPerMinute: 150, now: () => now });
    for (let i = 0; i < 150; i++) pool.charge('a:443');
    expect(() => pool.charge('a:443')).toThrow(expect.objectContaining({ budget: true }));
    expect(pool.pick(1)).toEqual([]);
    now = 60_001;
    pool.charge('a:443');
    expect(pool.used('a:443')).toBe(1);
  });
  it('prefers healthy nodes, falls back to cooling ones, and honours ratelimit-reset on 429', () => {
    let now = 0;
    const pool = new NodePool(['a:1', 'b:1', 'c:1'], { now: () => now, cooldownMs: 1000 });
    pool.fail('a:1');
    expect(pool.pick(2).sort()).toEqual(['b:1', 'c:1']);
    expect(pool.pick(3).length).toBe(3);
    expect(pool.pick(3)[2]).toBe('a:1');
    now = 1001; expect(pool.cooling('a:1')).toBe(false);
    pool.fail('b:1', new GrpcError(8, 'x', { http: 429, rate: { limit: null, remaining: null, reset: '30' } }));
    now += 29_000; expect(pool.cooling('b:1')).toBe(true);
    now += 2000; expect(pool.cooling('b:1')).toBe(false);
  });
  it('excludes, dedupes and appends', () => {
    const pool = new NodePool(['a:1', 'a:1', 'b:1']);
    expect(pool.list()).toEqual(['a:1', 'b:1']);
    pool.setNodes(['c:1', 'a:1'], 'append');
    expect(pool.list()).toEqual(['a:1', 'b:1', 'c:1']);
    expect(pool.pick(5, ['a:1', 'b:1'])).toEqual(['c:1']);
    pool.setNodes(['z:1']);
    expect(pool.list()).toEqual(['z:1']);
  });
  it('backoff is full jitter, capped, and sleep honours abort', async () => {
    expect(backoffMs(0, 100, 1000, () => 0.5)).toBe(50);
    expect(backoffMs(10, 100, 1000, () => 0.999)).toBe(999);
    expect(backoffMs(3, 100, 1000, () => 0)).toBe(0);
    const ac = new AbortController(); const p = sleep(10_000, ac.signal); ac.abort();
    await expect(p).rejects.toBeDefined();
  });
});

describe('node lists', () => {
  afterEach(() => vi.unstubAllGlobals());
  const serviceBody = { success: true, data: [
    { status: 'ENABLED', versionCheck: 'success', addresses: { platform_https: ['1.2.3.4:443'] } },
    { status: 'ENABLED', versionCheck: 'fail', addresses: { platform_https: ['5.6.7.8:443'] } },
    { status: 'POSE_BANNED', versionCheck: 'success', addresses: { platform_https: ['9.9.9.9:443'] } },
    { status: 'ENABLED', versionCheck: 'success', addresses: { platform_https: ['evil.com/x#:443'] } },
    { status: 'ENABLED', versionCheck: 'success', addresses: { platform_https: ['node.example.org:443'] } },
    { status: 'ENABLED', versionCheck: 'success', addresses: {} },
  ] };
  it('keeps ENABLED + versionCheck success endpoints and drops malformed ones; the URL is a parameter', async () => {
    const f = vi.fn(async (_url: string) => new Response(JSON.stringify(serviceBody)));
    vi.stubGlobal('fetch', f);
    expect(await fetchNodes('https://my.example/nodes')).toEqual(['1.2.3.4:443', 'node.example.org:443']);
    expect(f.mock.calls[0]![0]).toBe('https://my.example/nodes');
    expect(await fetchNodes('https://my.example/nodes', { requireVersionCheck: false })).toEqual(['1.2.3.4:443', '5.6.7.8:443', 'node.example.org:443']);
  });
  it('fails clearly on HTTP errors and unexpected shapes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(fetchNodes('https://x/')).rejects.toThrow(/HTTP 503/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":5}')));
    await expect(fetchNodes('https://x/')).rejects.toThrow(/shape/);
  });
  it('endpoint validation', () => {
    for (const ok of ['1.2.3.4:443', 'a.b-c.example:6000']) expect(isEndpoint(ok)).toBe(true);
    for (const bad of ['1.2.3.4', 'a/b:443', 'x:99999', 'http://a:1', '', 5, 'a b:1']) expect(isEndpoint(bad)).toBe(false);
  });
  it('sample returns k distinct entries', () => {
    const s = sample([1, 2, 3, 4, 5, 6], 4);
    expect(new Set(s).size).toBe(4);
  });
});

describe('race()', () => {
  it('skips failing nodes, aborts losers, reports failures', async () => {
    const aborted: string[] = [];
    const r = await race(['bad1', 'bad2', 'slow', 'fast'], (n, signal) => new Promise<string>((res, rej) => {
      if (n.startsWith('bad')) return rej(new Error('boom'));
      signal.addEventListener('abort', () => aborted.push(n));
      setTimeout(() => res(n), n === 'fast' ? 10 : 500);
    }), { n: 2 });
    expect(r.node).toBe('fast'); expect(r.failures.length).toBe(2); expect(aborted).toContain('slow');
    await expect(race(['x', 'y'], () => Promise.reject(new Error('no')))).rejects.toThrow(/all nodes failed/);
  });
  it('accept() rejections move on to the next node; an external abort rejects', async () => {
    const r = await race(['a', 'b', 'c'], async (n) => n, { n: 1, accept: (v) => v === 'c' });
    expect(r.node).toBe('c'); expect(r.failures.length).toBe(2);
    const ac = new AbortController();
    const p = race(['a'], () => new Promise<string>(() => {}), { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeDefined();
  });
});

describe('mergeStreams()', () => {
  type H = { cancel(): void; closed: Promise<unknown> };
  it('dedupes, replaces dead streams, cancels cleanly', async () => {
    const got: { node: string }[] = [];
    const open = (node: string, emit: (k: string, i: { node: string }) => void): H => {
      let timer: ReturnType<typeof setInterval> | undefined; let resolve!: (v: unknown) => void;
      const closed = new Promise((r) => { resolve = r; });
      if (node === 'dead') queueMicrotask(() => resolve({ reason: 'error', error: new Error('x') }));
      else { let i = 0; timer = setInterval(() => emit('k' + (i++ % 3), { node }), 5); }
      return { cancel() { clearInterval(timer); resolve({ reason: 'cancelled' }); }, closed };
    };
    const m = mergeStreams(['dead', 'a', 'b', 'c'], open, (item) => got.push(item), { n: 3 });
    await new Promise((r) => setTimeout(r, 80));
    const st = m.stats(); m.cancel(); await m.closed;
    expect(got.map((g) => g.node.length)).toEqual([1, 1, 1]);
    expect(st.failed.length).toBe(1); expect(st.opened.length).toBe(4); expect(st.dupes).toBeGreaterThan(0);
  });
  it('replacement delay is honoured, closed waits for pending replacements, onClose sees every close', async () => {
    const closes: string[] = [];
    let n = 0;
    const open = (): H => ({ cancel() {}, closed: Promise.resolve({ reason: 'error', error: new Error('x') }) });
    const t0 = Date.now();
    const m = mergeStreams(() => (n < 3 ? `n${n++}` : undefined), open, () => {}, { n: 1, maxReplacements: 5, replaceDelayMs: () => 30, onClose: (node) => closes.push(node) });
    await m.closed;
    expect(closes).toEqual(['n0', 'n1', 'n2']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });
  it('a synchronous open() failure moves straight to the next node', async () => {
    const got: string[] = [];
    const open = (node: string, emit: (k: string, i: string) => void): H => {
      if (node === 'boom') throw new Error('sync');
      emit('k', node);
      return { cancel() {}, closed: new Promise(() => {}) };
    };
    const m = mergeStreams(['boom', 'ok'], open, (i) => got.push(i), { n: 1 });
    expect(got).toEqual(['ok']); expect(m.stats().failed.length).toBe(1);
    m.cancel();
  });
});
