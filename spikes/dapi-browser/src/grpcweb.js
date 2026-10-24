// grpc-web (application/grpc-web+proto) over fetch(). Unary + server-streaming, fetch-stream based.
// Works in browsers (CORS-enabled Envoy on evonodes) and Node >= 18.
import { concat } from './pb.js';

export class GrpcError extends Error {
  constructor(code, message, extra = {}) {
    super(message || `grpc status ${code}`);
    this.name = 'GrpcError';
    this.code = code; // grpc status code; 14 = UNAVAILABLE (also used for network/CORS/TLS failures)
    Object.assign(this, extra);
  }
}

const HEADERS = { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1', accept: 'application/grpc-web+proto' };
const td = new TextDecoder();

export function frame(msg) {
  const b = new Uint8Array(5 + msg.length);
  new DataView(b.buffer).setUint32(1, msg.length);
  b.set(msg, 5);
  return b;
}

/** Incremental frame parser: push(chunk) -> [{ trailer: bool, data: Uint8Array }]. */
export class FrameParser {
  constructor() { this.buf = new Uint8Array(0); }
  push(chunk) {
    this.buf = this.buf.length ? concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 5) break;
      const len = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(1);
      if (this.buf.length < 5 + len) break;
      out.push({ trailer: (this.buf[0] & 0x80) !== 0, data: this.buf.slice(5, 5 + len) });
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}

function parseTrailers(bytes) {
  const t = {};
  for (const line of td.decode(bytes).split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) t[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return t;
}

function statusOf(headers, trailers) {
  const g = (k) => (trailers && trailers[k] !== undefined ? trailers[k] : headers.get(k));
  const s = g('grpc-status');
  if (s == null) return null;
  const raw = g('grpc-message') || '';
  let message = raw;
  try { message = decodeURIComponent(raw); } catch { /* malformed percent-encoding: keep raw text */ }
  return { code: Number(s), message };
}

const rateInfo = (h) => ({
  limit: h.get('ratelimit-limit'), remaining: h.get('ratelimit-remaining'), reset: h.get('ratelimit-reset'),
});

/** Propagate an external AbortSignal into ctrl (also if it is already aborted). Returns an unlink function. */
function link(signal, ctrl) {
  if (!signal) return () => {};
  if (signal.aborted) { ctrl.abort(signal.reason); return () => {}; }
  const on = () => ctrl.abort(signal.reason);
  signal.addEventListener('abort', on, { once: true });
  return () => signal.removeEventListener('abort', on);
}

async function open(url, body, signal) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: HEADERS, body: frame(body), signal });
  } catch (e) {
    if (e.name === 'AbortError' || e instanceof GrpcError) throw e; // caller abort, or our own deadline (reason = GrpcError 4)
    // CORS failures, DNS, TLS (bad/expired cert) and connection resets all surface as TypeError('Failed to fetch').
    throw new GrpcError(14, `network error: ${e.message}`, { network: true });
  }
  if (!res.ok) { res.body?.cancel().catch(() => {}); throw new GrpcError(res.status === 429 ? 8 : 14, `HTTP ${res.status}`, { http: res.status, rate: rateInfo(res.headers) }); }
  if (!(res.headers.get('content-type') || '').startsWith('application/grpc-web')) {
    res.body?.cancel().catch(() => {});
    throw new GrpcError(14, 'not a grpc-web response (wrong node/proxy?)', { network: true });
  }
  return res;
}

/** Unary call. Resolves with the response message bytes. */
export async function unary(base, method, req, { signal, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const unlink = link(signal, ctrl);
  const timer = setTimeout(() => ctrl.abort(new GrpcError(4, 'deadline exceeded')), timeoutMs);
  try {
    const res = await open(base + method, req, ctrl.signal);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let msg = null, trailers = null;
    for (const f of new FrameParser().push(bytes)) { if (f.trailer) trailers = parseTrailers(f.data); else msg = f.data; }
    const st = statusOf(res.headers, trailers);
    if (st && st.code !== 0) throw new GrpcError(st.code, st.message, { rate: rateInfo(res.headers) });
    if (!msg) throw new GrpcError(13, 'empty response');
    return msg;
  } catch (e) {
    if (e.name === 'AbortError' && ctrl.signal.reason instanceof GrpcError) throw ctrl.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

/** Server-streaming call. Returns { cancel(), closed } ; `closed` resolves (never rejects) with
 *  { reason: 'cancelled'|'end'|'error', error?, status?, handler? } once the stream is torn down.
 *  `handler: true` means onMessage threw (error is the thrown value); the connection is aborted in that case.
 *  connectTimeoutMs covers time-to-response-headers; idleTimeoutMs (optional) aborts if no bytes arrive for that long. */
export function stream(base, method, req, { onMessage, signal, connectTimeoutMs = 15000, idleTimeoutMs }) {
  const ctrl = new AbortController();
  const unlink = link(signal, ctrl);
  let cancelled = false, idle;
  const bumpIdle = () => { if (idleTimeoutMs) { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(new GrpcError(4, 'idle timeout')), idleTimeoutMs); } };
  const closed = (async () => {
    try {
      const timer = setTimeout(() => ctrl.abort(new GrpcError(4, 'connect timeout')), connectTimeoutMs);
      const res = await open(base + method, req, ctrl.signal).finally(() => clearTimeout(timer));
      const reader = res.body.getReader();
      const parser = new FrameParser();
      let trailers = null;
      bumpIdle();
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
      if (cancelled || (e.name === 'AbortError' && !(ctrl.signal.reason instanceof GrpcError))) return { reason: 'cancelled' };
      return { reason: 'error', error: e instanceof GrpcError ? e : new GrpcError(14, e.message, { network: true }) };
    } finally {
      clearTimeout(idle); unlink(); ctrl.abort(); // release the connection on every exit path
    }
  })();
  return { cancel() { cancelled = true; ctrl.abort(); }, closed };
}
