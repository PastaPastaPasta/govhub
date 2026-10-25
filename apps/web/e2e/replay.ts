// Offline replay of a recorded live session, for the tamper suite (e2e/tamper.spec.ts). Every request the app (page and workers)
// sends to anything but the preview server is answered from a recording: Platform, DAPI Core, the bridge, the quorum list server.
// Tamper hooks rewrite chosen answers on top, the way a lying node or bridge would, and requests the recording does not hold fail
// like an unreachable network. The clock (page and workers) starts at the recording's time and runs 1000 times slower, while
// recording too: queries that carry the time (past proposals: "ended before now", in seconds) are the same bytes in both, and
// freshness rules (a ChainLock under an hour old, tallies under a day) see the same data the same way.
//
// Record (live network): GOVHUB_RECORD=1 npx playwright test e2e/tamper.spec.ts --grep @record
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import type { BrowserContext, Request, Route } from '@playwright/test';

export interface Entry {
  method: string;
  url: string;
  /** base64 request body ('' for none) */
  post: string;
  status: number;
  headers: Record<string, string>;
  /** base64 response body */
  body: string;
}

export interface Recording {
  /** ms epoch when the recording started: the replayed clock starts there */
  recordedAt: number;
  entries: Entry[];
}

/** DAPI and Platform nodes are picked at random per request: they are one host for the replay. */
const NODE_HOST = /^https:\/\/\d{1,3}(?:\.\d{1,3}){3}:\d+\/+/;
const keyOf = (method: string, url: string, post: string) => `${method} ${url.replace(NODE_HOST, 'node:/')} ${post}`;
const postOf = (r: Request) => r.postDataBuffer()?.toString('base64') ?? '';

export const loadRecording = (path: URL): Recording => JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as Recording;
export const saveRecording = (path: URL, r: Recording) => writeFileSync(path, gzipSync(JSON.stringify(r)));

/**
 * Clock shim: `Date` (now and new Date()) starts at `start` (ms epoch) in each page load and worker, and advances a millisecond per
 * real second. Installed before any app code in the page and every worker.
 */
const clockShim = (start: number) => `(() => {
  const RealDate = Date, t0 = RealDate.now(), start = ${start};
  const now = () => start + Math.floor((RealDate.now() - t0) / 1000);
  class ReplayDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(now()); else super(...a); }
    static now() { return now(); }
  }
  globalThis.Date = ReplayDate;
})();\n`;

/** Installs the clock shim in the context's pages and in the preview server's worker scripts. */
async function installClock(ctx: BrowserContext, base: string, start: number) {
  const shim = clockShim(start);
  await ctx.addInitScript({ content: shim });
  // the workers are module scripts from the preview server: the shim goes first in each
  await ctx.route((u) => u.href.startsWith(base) && /\/assets\/[^/]*worker[^/]*\.js$/.test(u.pathname), async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: shim + (await res.text()) });
  });
}

/** Response headers a fulfilled route may set (no HTTP/2 pseudo-headers or transfer framing), with CORS open for the worker. */
function replayHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (!k.startsWith(':') && !/^(content-length|content-encoding|transfer-encoding|connection)$/i.test(k)) out[k] = v;
  out['access-control-allow-origin'] ??= '*';
  out['access-control-expose-headers'] ??= 'grpc-status, grpc-message, content-type';
  return out;
}

export type Tamper = (e: { method: string; url: string; post: Buffer; status: number; headers: Record<string, string>; body: Buffer }) =>
  | { status?: number; headers?: Record<string, string>; body?: Buffer }
  | 'abort'
  | null
  | undefined;

export interface Replay {
  /** Requests the recording did not hold (they failed like an unreachable network). */
  misses: string[];
  /** Every replayed request's URL, in order. */
  served: string[];
  /** Tampers run in order on each answer; the first that returns something decides it. */
  tamper(t: Tamper): void;
}

/** Every request that leaves the preview server. */
const external = (base: string) => (u: URL) => !u.href.startsWith(base) && /^https?:/.test(u.protocol);

function newReplay(): { r: Replay; tampers: Tamper[] } {
  const tampers: Tamper[] = [];
  return { r: { misses: [], served: [], tamper: (t) => void tampers.push(t) }, tampers };
}

/**
 * Answers every non-local request of `ctx` from `rec`, applying tampers, and shifts the clock back to `rec.recordedAt`. Identical
 * requests get the recorded answers in order (the last one repeats). Call before the first page is opened.
 */
export async function replay(ctx: BrowserContext, rec: Recording, base: string): Promise<Replay> {
  const index = new Map<string, Entry[]>();
  for (const e of rec.entries) {
    const k = keyOf(e.method, e.url, e.post);
    index.set(k, [...(index.get(k) ?? []), e]);
  }
  const next = new Map<string, number>();
  const { r, tampers } = newReplay();
  await installClock(ctx, base, rec.recordedAt);
  await ctx.route(external(base), async (route: Route) => {
    const req = route.request();
    const post = postOf(req);
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST' } });
    const k = keyOf(req.method(), req.url(), post);
    const list = index.get(k);
    const i = next.get(k) ?? 0;
    next.set(k, i + 1);
    const e = list?.[Math.min(i, list.length - 1)];
    // a request the recording does not hold reaches the tampers with status 0 (they may answer it); otherwise it fails
    let out: { status: number; headers: Record<string, string>; body: Buffer } = e ? { status: e.status, headers: e.headers, body: Buffer.from(e.body, 'base64') } : { status: 0, headers: {}, body: Buffer.alloc(0) };
    for (const t of tampers) {
      let v: ReturnType<Tamper>;
      try {
        v = t({ method: req.method(), url: req.url(), post: Buffer.from(post, 'base64'), ...out });
      } catch (err) {
        // a broken tamper must fail the test, not leave the request hanging
        r.misses.push(`tamper threw on ${req.url().slice(0, 100)}: ${(err as Error).message}`);
        return route.abort('failed');
      }
      if (v === 'abort') return route.abort('connectionrefused');
      if (v) {
        out = { status: v.status ?? out.status, headers: v.headers ?? out.headers, body: v.body ?? out.body };
        break;
      }
    }
    if (!out.status) {
      r.misses.push(`${req.method()} ${req.url().replace(NODE_HOST, 'node:/').slice(0, 140)}`);
      return route.abort('connectionrefused');
    }
    r.served.push(req.url());
    return route.fulfill({ status: out.status, headers: replayHeaders(out.headers), body: out.body });
  });
  return r;
}

/**
 * Records every non-local request of `ctx` by asking the real server from Node. Streams (grpc-web server streaming) are read until
 * they end, or until 3 s pass without data after the first frame (subscriptions never end on their own): the client then sees the
 * recorded frames and a closed stream, as when it cancels.
 */
export async function record(ctx: BrowserContext, base: string): Promise<{ done(): Recording }> {
  // a whole second (plus a little): the replay's "now" in seconds is then the recording's
  const rec: Recording = { recordedAt: Math.floor(Date.now() / 1000) * 1000 + 100, entries: [] };
  await installClock(ctx, base, rec.recordedAt);
  await ctx.route(external(base), async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.continue();
    const headers = Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !k.startsWith(':') && !/^(host|content-length|origin|referer|cookie)$/i.test(k)));
    const ctl = new AbortController();
    try {
      const body = req.postDataBuffer();
      const res = await fetch(req.url(), { method: req.method(), headers, ...(body ? { body: new Uint8Array(body) } : {}), signal: ctl.signal });
      const chunks: Buffer[] = [];
      const reader = res.body?.getReader();
      const started = Date.now();
      if (reader) {
        for (;;) {
          const idle = new Promise<'idle'>((ok) => setTimeout(() => ok('idle'), chunks.length ? 3000 : 30_000));
          const step = await Promise.race([reader.read(), idle]);
          if (step === 'idle' || Date.now() - started > 60_000) {
            ctl.abort();
            break;
          }
          if (step.done) break;
          chunks.push(Buffer.from(step.value));
        }
      }
      const out = Buffer.concat(chunks);
      const h = Object.fromEntries(res.headers.entries());
      rec.entries.push({ method: req.method(), url: req.url(), post: body?.toString('base64') ?? '', status: res.status, headers: h, body: out.toString('base64') });
      await route.fulfill({ status: res.status, headers: replayHeaders(h), body: out });
    } catch {
      await route.abort('connectionrefused');
    }
  });
  return { done: () => rec };
}

/**
 * The same tamper hooks against the live network (GOVHUB_TAMPER_LIVE=1): each non-local answer is fetched for real, then rewritten.
 * Streams (grpc-web server streaming) pass through untouched unless a tamper aborts them; the clock is the real one.
 */
export async function liveTamper(ctx: BrowserContext, base: string): Promise<Replay> {
  const { r, tampers } = newReplay();
  await ctx.route(external(base), async (route) => {
    const req = route.request();
    const post = req.postDataBuffer() ?? Buffer.alloc(0);
    const ask = (out: { status: number; headers: Record<string, string>; body: Buffer }) => {
      for (const t of tampers) {
        const v = t({ method: req.method(), url: req.url(), post, ...out });
        if (v) return v;
      }
      return null;
    };
    if (req.method() === 'OPTIONS') return route.continue();
    if (/\/subscribe[A-Za-z]+$/.test(req.url())) return ask({ status: 0, headers: {}, body: Buffer.alloc(0) }) === 'abort' ? route.abort('connectionrefused') : route.continue();
    let res, body;
    try {
      res = await route.fetch();
      body = await res.body();
    } catch {
      // unreachable, or the page or context closed meanwhile
      return route.abort('connectionrefused').catch(() => {});
    }
    const out = { status: res.status(), headers: res.headers(), body };
    const v = ask(out);
    if (v === 'abort') return route.abort('connectionrefused');
    r.served.push(req.url());
    if (!v) return route.fulfill({ response: res, body: out.body });
    return route.fulfill({ status: v.status ?? out.status, headers: replayHeaders(v.headers ?? out.headers), body: v.body ?? out.body });
  });
  return r;
}
