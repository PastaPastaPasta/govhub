// A fake DAPI Core gateway installed over global fetch: real grpc-web framing, real protobuf, scripted node behaviour.
import { vi } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils.js';
import { frame, FrameParser } from '../src/grpcweb.ts';
import { decode, encode, type PbMessage } from '../src/pb.ts';

export type Unary = (req: PbMessage, node: string) => Uint8Array | Promise<Uint8Array>;
export interface StreamCtl { send(msg: Uint8Array): void; end(status?: number): void; signal: AbortSignal; node: string }
export type StreamHandler = (req: PbMessage, ctl: StreamCtl) => void | Promise<void>;

export class FakeGrpcStatus extends Error {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

export interface FakeNode {
  /** every request fails like a TLS/CORS error */
  dead?: boolean;
  /** answer every request with this HTTP status */
  http?: number;
  /** response headers arrive this many ms after the request */
  delayMs?: number;
  unary?: Record<string, Unary>;
  streams?: Record<string, StreamHandler>;
}

export interface FakeDapi {
  /** requests seen: `${node} ${method}` */
  calls: string[];
  open: Set<string>;
  count(node: string, method?: string): number;
  restore(): void;
}

const trailer = (code: number, message = ''): Uint8Array => {
  const t = new TextEncoder().encode(`grpc-status: ${code}\r\n${message ? `grpc-message: ${encodeURIComponent(message)}\r\n` : ''}`);
  const f = new Uint8Array(5 + t.length); f[0] = 0x80; new DataView(f.buffer).setUint32(1, t.length); f.set(t, 5);
  return f;
};
const GW = { 'content-type': 'application/grpc-web+proto' };

export function installFakeDapi(nodes: Record<string, FakeNode>, defaults: { unary?: Record<string, Unary>; streams?: Record<string, StreamHandler>; text?: Record<string, () => Response | Promise<Response>> } = {}): FakeDapi {
  const calls: string[] = [], open = new Set<string>();
  const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const textHandler = defaults.text?.[url.href];
    if (textHandler) return textHandler();
    const m = /^\/org\.dash\.platform\.dapi\.v0\.Core\/(\w+)$/.exec(url.pathname);
    const node = url.host.includes(':') ? url.host : `${url.host}:443`;
    const spec = nodes[node];
    if (!m || !spec || spec.dead) throw new TypeError('Failed to fetch');
    const method = m[1]!;
    calls.push(`${node} ${method}`);
    if (spec.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, spec.delayMs);
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal!.reason ?? new DOMException('aborted', 'AbortError')); }, { once: true });
      });
    }
    if (spec.http) return new Response('', { status: spec.http, headers: { 'ratelimit-reset': '7' } });
    const body = init?.body as Uint8Array;
    const frames = new FrameParser().push(body);
    const req = decode(frames[0]?.data ?? new Uint8Array(0));
    const signal = init?.signal ?? undefined;
    const un = spec.unary?.[method] ?? defaults.unary?.[method];
    if (un) {
      try {
        const msg = await un(req, node);
        return new Response(new Uint8Array([...frame(msg), ...trailer(0)]) as BodyInit, { headers: GW });
      } catch (e) {
        if (e instanceof FakeGrpcStatus) return new Response(trailer(e.code, e.message) as BodyInit, { headers: GW });
        throw e;
      }
    }
    const st = spec.streams?.[method] ?? defaults.streams?.[method];
    if (!st) return new Response(trailer(12, 'unimplemented') as BodyInit, { headers: GW });
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const key = `${node} ${method} #${calls.length}`;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { ctrl = c; open.add(key); },
      cancel() { closed = true; open.delete(key); },
    });
    const ac = new AbortController();
    signal?.addEventListener('abort', () => {
      if (closed) return;
      closed = true; open.delete(key);
      try { ctrl.error(signal.reason ?? new DOMException('aborted', 'AbortError')); } catch { /* already closed */ }
      ac.abort();
    }, { once: true });
    void st(req, {
      node, signal: ac.signal,
      send: (msg) => { if (!closed) ctrl.enqueue(frame(msg)); },
      end: (code = 0) => { if (closed) return; closed = true; open.delete(key); ctrl.enqueue(trailer(code)); ctrl.close(); },
    });
    return new Response(stream, { headers: GW });
  });
  vi.stubGlobal('fetch', stub);
  return {
    calls, open,
    count: (node, method) => calls.filter((c) => (method ? c === `${node} ${method}` : c.startsWith(node + ' '))).length,
    restore: () => vi.unstubAllGlobals(),
  };
}

// ---- response builders for the Core messages ----
export const resp = {
  status: (o: { height: number; hash: Uint8Array; synced?: boolean }): Uint8Array =>
    encode([[5, encode([[1, 'main'], [3, o.height], [4, o.hash], [7, o.synced ?? true]])], [3, 2]]),
  block: (raw: Uint8Array): Uint8Array => encode([[1, raw]]),
  tx: (o: { raw: Uint8Array; blockHash?: string; height?: number; confirmations?: number; il?: boolean; cl?: boolean }): Uint8Array =>
    encode([[1, o.raw], [2, o.blockHash ? hexToBytes(o.blockHash) : undefined], [3, o.height ?? 0], [4, o.confirmations ?? 0], [5, o.il ?? false], [6, o.cl ?? false]]),
  headers: (hs: Uint8Array[]): Uint8Array => encode([[1, encode(hs.map((h) => [1, h] as const))]]),
  chainLock: (cl: Uint8Array): Uint8Array => encode([[2, cl]]),
  rawTxs: (txs: Uint8Array[]): Uint8Array => encode([[1, encode(txs.map((t) => [1, t] as const))]]),
  isLocks: (ms: Uint8Array[]): Uint8Array => encode([[2, encode(ms.map((t) => [1, t] as const))]]),
  merkleBlock: (mb: Uint8Array): Uint8Array => encode([[3, mb]]),
  sml: (cbor: Uint8Array): Uint8Array => encode([[1, cbor]]),
  broadcast: (txid: string): Uint8Array => encode([[1, txid]]),
};

export const flush = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
export async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('until(): timed out'); await flush(5); }
}
