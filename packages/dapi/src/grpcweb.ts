// grpc-web (application/grpc-web+proto) over fetch(): unary and server-streaming. Works in browsers
// (evonodes' Envoy sends permissive CORS) and Node >= 18. No codegen, no dependencies besides bytes.ts.
import { concat } from './bytes.ts';

export interface RateInfo { limit: string | null; remaining: string | null; reset: string | null }

export interface GrpcErrorExtra {
  /** True for fetch() failures: DNS, TLS, CORS, offline, reset. A browser cannot tell these apart. */
  network?: boolean;
  /** HTTP status when the gateway answered with a non-2xx. */
  http?: number;
  rate?: RateInfo;
  /** The client's own per-node request budget was exhausted; nothing was sent. */
  budget?: boolean;
}

export class GrpcError extends Error {
  /** grpc status code. 14 UNAVAILABLE is also used for network failures; 8 for HTTP 429; 4 for our own deadlines. */
  code: number;
  network?: boolean;
  http?: number;
  rate?: RateInfo;
  budget?: boolean;
  constructor(code: number, message?: string, extra: GrpcErrorExtra = {}) {
    super(message || `grpc status ${code}`);
    this.name = 'GrpcError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export type StreamClose =
  | { reason: 'cancelled' }
  | { reason: 'end'; status: { code: number; message: string } | null }
  /** `handler: true` means onMessage threw (error is the thrown value) and the connection was aborted. */
  | { reason: 'error'; error: unknown; handler?: boolean; status?: { code: number; message: string } };

export interface StreamHandle {
  cancel(): void;
  /** Resolves (never rejects) once the stream is torn down. */
  closed: Promise<StreamClose>;
}

export interface UnaryOptions {
  signal?: AbortSignal;
  /** Whole-call deadline. Default 15 s. */
  timeoutMs?: number;
}

export interface StreamOptions {
  onMessage: (msg: Uint8Array) => void;
  /** Called once when response headers arrive (the call was accepted by the gateway). */
  onOpen?: () => void;
  signal?: AbortSignal;
  /** Time to response headers. Default 15 s. */
  connectTimeoutMs?: number;
  /** Abort when no bytes arrive for this long. Default 10 min (blocks come every 2.5 min on average); 0 disables. */
  idleTimeoutMs?: number;
  /** Reject any single message above this size. Default 32 MiB (the first SML message is ~1.4 MB). */
  maxMessageBytes?: number;
}

export const DEFAULT_STREAM_IDLE_MS = 10 * 60_000;
const DEFAULT_MAX_MESSAGE = 32 * 1024 * 1024;

const HEADERS = { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1', accept: 'application/grpc-web+proto' };
const td = new TextDecoder();

export function frame(msg: Uint8Array): Uint8Array {
  const b = new Uint8Array(5 + msg.length);
  new DataView(b.buffer).setUint32(1, msg.length);
  b.set(msg, 5);
  return b;
}

export interface Frame { trailer: boolean; data: Uint8Array }

/** Incremental frame parser: push(chunk) -> complete frames. */
export class FrameParser {
  buf: Uint8Array = new Uint8Array(0);
  readonly #max: number;
  constructor(maxMessageBytes = DEFAULT_MAX_MESSAGE) { this.#max = maxMessageBytes; }
  push(chunk: Uint8Array): Frame[] {
    this.buf = this.buf.length ? concat(this.buf, chunk) : chunk;
    const out: Frame[] = [];
    for (;;) {
      if (this.buf.length < 5) break;
      if (this.buf[0]! & 1) throw new GrpcError(12, 'compressed grpc-web frames are not supported');
      const len = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(1);
      if (len > this.#max) throw new GrpcError(8, `message of ${len} bytes exceeds the ${this.#max} byte limit`);
      if (this.buf.length < 5 + len) break;
      out.push({ trailer: (this.buf[0]! & 0x80) !== 0, data: this.buf.slice(5, 5 + len) });
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}

function parseTrailers(bytes: Uint8Array): Record<string, string> {
  const t: Record<string, string> = {};
  for (const line of td.decode(bytes).split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) t[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return t;
}

function statusOf(headers: Headers, trailers: Record<string, string> | null): { code: number; message: string } | null {
  const g = (k: string) => (trailers && trailers[k] !== undefined ? trailers[k] : headers.get(k));
  const s = g('grpc-status');
  if (s == null) return null;
  const raw = g('grpc-message') || '';
  let message = raw;
  try { message = decodeURIComponent(raw); } catch { /* malformed percent-encoding: keep the raw text */ }
  return { code: Number(s), message };
}

const rateInfo = (h: Headers): RateInfo => ({ limit: h.get('ratelimit-limit'), remaining: h.get('ratelimit-remaining'), reset: h.get('ratelimit-reset') });

export const isAbort = (e: unknown): boolean => (e as { name?: string })?.name === 'AbortError';
/** Why `signal` aborted (always set by real AbortSignals; the fallback is for hand-made ones). */
export const abortReason = (s: AbortSignal): unknown => s.reason ?? new DOMException('aborted', 'AbortError');
const errText = (e: unknown): string => String((e as { message?: unknown })?.message ?? e);

/** Propagate an external AbortSignal into ctrl (also if it is already aborted). Returns an unlink function. */
export function link(signal: AbortSignal | undefined, ctrl: AbortController): () => void {
  if (!signal) return () => {};
  if (signal.aborted) { ctrl.abort(signal.reason); return () => {}; }
  const on = () => ctrl.abort(signal.reason);
  signal.addEventListener('abort', on, { once: true });
  return () => signal.removeEventListener('abort', on);
}

async function open(url: string, body: Uint8Array, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: HEADERS, body: frame(body) as BodyInit, signal });
  } catch (e) {
    if (isAbort(e) || e instanceof GrpcError) throw e; // caller abort, or our own deadline (the abort reason is a GrpcError)
    // CORS failures, DNS, TLS (bad/expired cert) and connection resets all surface as TypeError('Failed to fetch').
    throw new GrpcError(14, `network error: ${errText(e)}`, { network: true });
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new GrpcError(res.status === 429 ? 8 : 14, `HTTP ${res.status}`, { http: res.status, rate: rateInfo(res.headers) });
  }
  if (!(res.headers.get('content-type') || '').startsWith('application/grpc-web')) {
    res.body?.cancel().catch(() => {});
    throw new GrpcError(14, 'not a grpc-web response (wrong node/proxy?)', { network: true });
  }
  return res;
}

/** Unary call. Resolves with the response message bytes. */
export async function unary(base: string, method: string, req: Uint8Array, { signal, timeoutMs = 15000 }: UnaryOptions = {}): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const unlink = link(signal, ctrl);
  const timer = setTimeout(() => ctrl.abort(new GrpcError(4, 'deadline exceeded')), timeoutMs);
  try {
    const res = await open(base + method, req, ctrl.signal);
    // read through a capped reader: a hostile node cannot make us buffer an unbounded body before the frame limit applies
    const reader = res.body!.getReader(), chunks: Uint8Array[] = [];
    for (let size = 0; ;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > DEFAULT_MAX_MESSAGE + 1024) { void reader.cancel().catch(() => {}); throw new GrpcError(8, 'response body too large'); }
      chunks.push(value);
    }
    const bytes = concat(...chunks);
    let msg: Uint8Array | null = null, trailers: Record<string, string> | null = null;
    for (const f of new FrameParser().push(bytes)) { if (f.trailer) trailers = parseTrailers(f.data); else msg = f.data; }
    const st = statusOf(res.headers, trailers);
    if (st && st.code !== 0) throw new GrpcError(st.code, st.message, { rate: rateInfo(res.headers) });
    if (!msg) throw new GrpcError(13, 'empty response');
    return msg;
  } catch (e) {
    if (isAbort(e) && ctrl.signal.reason instanceof GrpcError) throw ctrl.signal.reason;
    if (!isAbort(e) && !(e instanceof GrpcError) && ctrl.signal.reason instanceof GrpcError) throw ctrl.signal.reason; // body read aborted by our deadline
    if (e instanceof TypeError) throw new GrpcError(14, `network error: ${errText(e)}`, { network: true }); // connection dropped mid-body
    throw e;
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

/** Server-streaming call. */
export function stream(base: string, method: string, req: Uint8Array, o: StreamOptions): StreamHandle {
  const { onMessage, onOpen, signal, connectTimeoutMs = 15000, idleTimeoutMs = DEFAULT_STREAM_IDLE_MS, maxMessageBytes } = o;
  const ctrl = new AbortController();
  const unlink = link(signal, ctrl);
  let cancelled = false, idle: ReturnType<typeof setTimeout> | undefined;
  const bumpIdle = () => {
    if (idleTimeoutMs > 0) { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(new GrpcError(4, 'idle timeout')), idleTimeoutMs); }
  };
  const closed = (async (): Promise<StreamClose> => {
    try {
      const timer = setTimeout(() => ctrl.abort(new GrpcError(4, 'connect timeout')), connectTimeoutMs);
      const res = await open(base + method, req, ctrl.signal).finally(() => clearTimeout(timer));
      const reader = res.body!.getReader();
      const parser = new FrameParser(maxMessageBytes);
      let trailers: Record<string, string> | null = null;
      bumpIdle();
      try { onOpen?.(); } catch (e) { return { reason: 'error', error: e, handler: true }; }
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bumpIdle();
        for (const f of parser.push(value)) {
          if (f.trailer) { trailers = parseTrailers(f.data); continue; }
          try { onMessage(f.data); } catch (e) { return { reason: 'error', error: e, handler: true }; }
        }
      }
      if (parser.buf.length) return { reason: 'error', error: new GrpcError(14, 'stream cut off mid-frame', { network: true }) };
      const st = statusOf(res.headers, trailers);
      if (st && st.code !== 0) return { reason: 'error', error: new GrpcError(st.code, st.message), status: st };
      return { reason: 'end', status: st };
    } catch (e) {
      const why = ctrl.signal.reason;
      if (cancelled || (isAbort(e) && !(why instanceof GrpcError))) return { reason: 'cancelled' };
      if (e instanceof GrpcError) return { reason: 'error', error: e };
      return { reason: 'error', error: why instanceof GrpcError ? why : new GrpcError(14, errText(e), { network: true }) };
    } finally {
      clearTimeout(idle); unlink(); ctrl.abort(); // release the connection on every exit path
    }
  })();
  return { cancel() { cancelled = true; ctrl.abort(); }, closed };
}
