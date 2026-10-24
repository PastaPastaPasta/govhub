// GET/POST /v1/quorum-proof: a relay of Dash Core v24's `getquorumproofchain` (DIP 175, DASHNC02 quorum proof chains).
//
// The bridge is NOT trusted for this: a proof authenticates itself from a checkpoint the client already holds, so the
// endpoint only has to be correct, cached and bounded. Design mirrors the public quorum-list-server relay (src/proofs.rs):
//   - a 15 s response cache (64 entries / 16 MB) keyed by the normalized request,
//   - identical concurrent requests share one Core call,
//   - at most `workers` concurrent Core calls and `queue` waiting; more get 503,
//   - a worker whose call died without an answer stays reserved for a cooldown (Core keeps building after its client is gone),
//   - a per-client token bucket charged on cache misses only,
//   - a span guard (`getblockheader` of the checkpoint) that refuses checkpoints too far below the tip.
import { createHmac, randomBytes } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { QuorumProofConfig } from '../config.ts';
import { CoreRpcError, type CallOptions } from '../core/rpc.ts';
import { log } from '../log.ts';
import { ipBucket, peerTrust, resolveClientIp } from './clientip.ts';

export const QUORUM_PROOF_PATH = '/v1/quorum-proof';
export const MAX_BODY_BYTES = 1024;
/** Largest decoded proof or bootstrap accepted from Core (the quorum-list-server relay uses the same bound). */
const MAX_PROOF_BYTES = 1024 * 1024;
const MAX_MESSAGE = 200;
/** Cached checkpoint lookups (hash -> height, span). A checkpoint's height never changes; the span only grows with the tip. */
const LOOKUP_TTL_MS = 60_000;
const LOOKUP_ENTRIES = 1024;
/** A failure faster than this did not leave work behind in Core: the worker is released at once. */
const FAST_FAILURE_MS = 2_000;
/** How long a Core that answered -32601 is assumed to still lack the method. */
const UNSUPPORTED_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 10_000;
const MAX_BUCKETS = 100_000;

const HASH_RE = /^[0-9a-fA-F]{64}$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/;
const INT_RE = /^\d{1,10}$/;
const FIELDS = ['checkpoint', 'height', 'quorumHash', 'llmqType', 'nodeCount'] as const;

export interface ProofRequest {
  /** 64 lowercase hex, display byte order. */
  checkpoint: string;
  /** Minimum target height; 0 = latest ChainLock. */
  height: number;
  quorumHash: string | null;
  llmqType: number | null;
  nodeCount: number;
}

export interface ProofResult {
  bytes: Uint8Array;
  targetHeight: number;
  format: 'chain' | 'bootstrap';
}

export class ProofError extends Error {
  readonly status: 400 | 404 | 409 | 413 | 422 | 429 | 501 | 502 | 503;
  readonly code: string;
  readonly retryAfter: number | undefined;
  constructor(status: ProofError['status'], code: string, message: string, retryAfter?: number) {
    super(message.slice(0, MAX_MESSAGE));
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** The part of CoreRpc this module uses (tests fake it). */
export interface ProofRpc {
  call<T = unknown>(method: string, params?: unknown[], opts?: CallOptions): Promise<T>;
}

// ---- request parsing ----

type Parsed = { ok: true; req: ProofRequest } | { ok: false; message: string };

/** `num` converts a raw field value to an integer, or NaN when it is not one (queries carry strings, JSON bodies numbers). */
function validate(raw: Record<string, unknown>, num: (v: unknown) => number): Parsed {
  const bad = (message: string): Parsed => ({ ok: false, message });
  const present = (k: (typeof FIELDS)[number]) => raw[k] !== undefined && raw[k] !== null;
  if (typeof raw.checkpoint !== 'string' || !HASH_RE.test(raw.checkpoint)) return bad('checkpoint is required: 64 hex characters (a block hash)');
  let height = 0;
  if (present('height')) {
    height = num(raw.height);
    if (!Number.isInteger(height) || height < 0 || height > 2 ** 31 - 1) return bad('height must be an integer in 0..2147483647');
  }
  if (present('quorumHash') !== present('llmqType')) return bad('quorumHash and llmqType must be given together');
  let quorumHash: string | null = null;
  let llmqType: number | null = null;
  if (present('quorumHash')) {
    if (typeof raw.quorumHash !== 'string' || !HASH_RE.test(raw.quorumHash)) return bad('quorumHash must be 64 hex characters');
    quorumHash = raw.quorumHash.toLowerCase();
    llmqType = num(raw.llmqType);
    // Core reads type 0 as "no quorum requested" and rejects it together with a quorum hash
    if (!Number.isInteger(llmqType) || llmqType < 1 || llmqType > 255) return bad('llmqType must be an integer in 1..255');
  }
  let nodeCount = 0;
  if (present('nodeCount')) {
    nodeCount = num(raw.nodeCount);
    if (!Number.isInteger(nodeCount) || nodeCount < 0 || nodeCount > 15) return bad('nodeCount must be an integer in 0..15');
  }
  return { ok: true, req: { checkpoint: raw.checkpoint.toLowerCase(), height, quorumHash, llmqType, nodeCount } };
}

export function parseProofQuery(params: URLSearchParams): Parsed {
  const raw: Record<string, unknown> = {};
  for (const k of new Set(params.keys())) {
    if (!(FIELDS as readonly string[]).includes(k)) return { ok: false, message: `unknown query parameter ${JSON.stringify(k.slice(0, 40))}` };
    if (params.getAll(k).length > 1) return { ok: false, message: `query parameter ${k} given more than once` };
    raw[k] = params.get(k);
  }
  for (const k of FIELDS) if (raw[k] === '') delete raw[k];
  return validate(raw, (v) => (typeof v === 'string' && INT_RE.test(v) ? Number(v) : NaN));
}

export function parseProofBody(body: unknown): Parsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, message: 'body must be a JSON object' };
  const raw = body as Record<string, unknown>;
  for (const k of Object.keys(raw)) if (!(FIELDS as readonly string[]).includes(k)) return { ok: false, message: `unknown field ${JSON.stringify(k.slice(0, 40))}` };
  return validate(raw, (v) => (typeof v === 'number' ? v : NaN));
}

// ---- rate limiting ----

interface Bucket {
  tokens: number;
  at: number;
}

/** Token bucket per client: `perMin` tokens per minute, bursts up to `burst`. Keys are salted HMACs, so the map holds no address. */
export class TokenBuckets {
  private readonly salt = randomBytes(32);
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep: number;
  private readonly perMin: number;
  private readonly burst: number;
  private readonly now: () => number;

  constructor(perMin: number, burst: number, now: () => number) {
    this.perMin = perMin;
    this.burst = burst;
    this.now = now;
    this.lastSweep = now();
  }

  /** Takes a token. Returns 0 if allowed, else the number of whole seconds until one is available. */
  take(client: string): number {
    const now = this.now();
    this.sweep(now);
    const key = createHmac('sha256', this.salt).update(client).digest('base64');
    const rate = this.perMin / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) * rate);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
  }

  /** Drops buckets that have refilled completely: they carry no information any more. */
  private sweep(now: number): void {
    const fullAfter = (this.burst / this.perMin) * 60_000;
    if (now - this.lastSweep < 60_000 && this.buckets.size < MAX_BUCKETS) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets) if (now - b.at >= fullAfter) this.buckets.delete(k);
    if (this.buckets.size >= MAX_BUCKETS) this.buckets.clear();
  }

  get size(): number {
    return this.buckets.size;
  }
}

// ---- the service ----

interface CacheEntry extends ProofResult {
  at: number;
  /** checkpoint + records part of the key (everything but the minimum height): entries sharing it answer each other's height floors */
  group: string;
}
interface Waiter {
  resolve: () => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
}
interface CoreProof {
  proof_hex?: unknown;
  bootstrap_hex?: unknown;
  target?: { height?: unknown };
}

const cut = (s: string) => s.slice(0, MAX_MESSAGE);
const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

export class QuorumProofService {
  private readonly cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private readonly inflight = new Map<string, Promise<ProofResult>>();
  private readonly heights = new Map<string, { height: number; span: number; at: number }>();
  private readonly limiter: TokenBuckets;
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private unsupportedUntil = 0;
  private readonly rpc: ProofRpc;
  private readonly cfg: QuorumProofConfig;
  private readonly now: () => number;

  constructor(rpc: ProofRpc, cfg: QuorumProofConfig, now: () => number = Date.now) {
    this.rpc = rpc;
    this.cfg = cfg;
    this.now = now;
    this.limiter = new TokenBuckets(cfg.ratePerMin, cfg.rateBurst, now);
  }

  /** Throws ProofError. `client` is the limiter key (see resolveClientIp / ipBucket). */
  async get(req: ProofRequest, client: string): Promise<ProofResult> {
    if (this.now() < this.unsupportedUntil) throw unsupported();
    const key = cacheKey(req);
    const hit = this.cached(key) ?? this.covering(req);
    if (hit) return hit;
    // an identical request is already running: share it, it costs nothing extra
    const running = this.inflight.get(key);
    if (running) return running;
    if (this.active >= this.cfg.workers && this.waiters.length >= this.cfg.queue) throw new ProofError(503, 'busy', 'the bridge is busy building other proofs, retry shortly', 5);
    const wait = this.limiter.take(client);
    if (wait > 0) throw new ProofError(429, 'rate-limited', 'too many proof requests, slow down', wait);
    const p = this.run(req, key);
    this.inflight.set(key, p);
    const done = () => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    };
    p.then(done, done);
    return p;
  }

  private cached(key: string): ProofResult | null {
    const e = this.cache.get(key);
    if (!e) return null;
    if (this.now() - e.at >= this.cfg.cacheTtlMs) {
      this.evict(key);
      return null;
    }
    return e;
  }

  /**
   * `height` is a minimum, so an unexpired entry for the same checkpoint and records whose target is at or above it answers the
   * request whatever height it was fetched with (typically 0 = latest ChainLock). Picks the highest target. Only for height > 0:
   * height 0 asks for the latest ChainLock, which a cached older proof may not be.
   */
  private covering(req: ProofRequest): ProofResult | null {
    if (req.height <= 0) return null;
    const group = groupKey(req);
    const now = this.now();
    let best: CacheEntry | null = null;
    for (const [k, e] of this.cache) {
      if (now - e.at >= this.cfg.cacheTtlMs) {
        this.evict(k);
        continue;
      }
      if (e.group === group && e.targetHeight >= req.height && (!best || e.targetHeight > best.targetHeight)) best = e;
    }
    return best;
  }

  private evict(key: string): void {
    const e = this.cache.get(key);
    if (!e) return;
    this.cache.delete(key);
    this.cacheBytes -= e.bytes.length;
  }

  private store(key: string, group: string, r: ProofResult): void {
    if (this.cfg.cacheTtlMs <= 0 || r.bytes.length > this.cfg.cacheBytes) return;
    const now = this.now();
    for (const [k, e] of this.cache) if (now - e.at >= this.cfg.cacheTtlMs) this.evict(k);
    this.evict(key);
    // insertion order = age order: drop the oldest first
    while (this.cache.size >= this.cfg.cacheEntries || this.cacheBytes + r.bytes.length > this.cfg.cacheBytes) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.evict(oldest.value);
    }
    this.cache.set(key, { ...r, at: now, group });
    this.cacheBytes += r.bytes.length;
  }

  private acquire(): Promise<void> {
    if (this.active < this.cfg.workers) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          reject(new ProofError(503, 'busy', 'waited too long for a free worker, retry shortly', 5));
        }, this.cfg.deadlineMs),
      };
      w.timer.unref();
      this.waiters.push(w);
    });
  }

  private release(): void {
    const w = this.waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(); // the slot passes straight to the next waiter
    } else this.active--;
  }

  private async run(req: ProofRequest, key: string): Promise<ProofResult> {
    await this.acquire();
    const started = Date.now();
    let hold = false;
    try {
      await this.checkSpan(req.checkpoint);
      const result = await this.build(req);
      this.store(key, groupKey(req), result);
      return result;
    } catch (e) {
      const mapped = this.mapError(e, req);
      // Core replies only when the build is finished, so an error from Core (or a fast transport failure) left nothing running;
      // a deadline, or a connection lost after the call had been under way, may have.
      hold = !(e instanceof ProofError) && !(e instanceof CoreRpcError) && (isTimeout(e) || Date.now() - started >= FAST_FAILURE_MS);
      throw mapped;
    } finally {
      if (hold && this.cfg.cooldownMs > 0) setTimeout(() => this.release(), this.cfg.cooldownMs).unref();
      else this.release();
    }
  }

  /** Refuses a checkpoint above the span limit (404 if Core does not know it on the active chain). */
  private async checkSpan(checkpoint: string): Promise<void> {
    const now = this.now();
    let l = this.heights.get(checkpoint);
    if (!l || now - l.at >= LOOKUP_TTL_MS) {
      const h = await this.rpc.call<{ height?: unknown; confirmations?: unknown }>('getblockheader', [checkpoint, true], { timeoutMs: LOOKUP_TIMEOUT_MS, retries: 0 }).catch((e) => {
        throw this.mapLookupError(e);
      });
      if (!Number.isInteger(h?.height) || !Number.isInteger(h?.confirmations)) throw new ProofError(502, 'core', 'Core returned an unexpected getblockheader answer');
      // confirmations is -1 for a block that is not on the active chain
      if ((h.confirmations as number) < 1) throw checkpointUnknown();
      l = { height: h.height as number, span: (h.confirmations as number) - 1, at: now };
      if (this.heights.size >= LOOKUP_ENTRIES) this.heights.delete(this.heights.keys().next().value!);
      this.heights.set(checkpoint, l);
    }
    if (l.span > this.cfg.maxSpan) {
      throw new ProofError(422, 'checkpoint-too-old', `checkpoint is ${l.span} blocks below the tip; this bridge serves proofs for at most ${this.cfg.maxSpan}. Use a newer checkpoint`);
    }
  }

  private async build(req: ProofRequest): Promise<ProofResult> {
    const params = [req.checkpoint, req.height, req.quorumHash ?? '', req.llmqType ?? 0, req.nodeCount];
    const r = await this.rpc.call<CoreProof>('getquorumproofchain', params, { timeoutMs: this.cfg.deadlineMs, retries: 0 });
    const records = req.quorumHash !== null || req.nodeCount > 0;
    const format = records ? 'bootstrap' : 'chain';
    const hex = records ? r?.bootstrap_hex : r?.proof_hex;
    const height = r?.target?.height;
    if (typeof hex !== 'string' || !HEX_RE.test(hex) || hex.length > MAX_PROOF_BYTES * 2 || !Number.isInteger(height)) {
      log.warn('quorum proof: malformed getquorumproofchain result', { format, hexType: typeof hex, hexLength: typeof hex === 'string' ? hex.length : null });
      throw new ProofError(502, 'core', 'Core returned a malformed proof');
    }
    return { bytes: Buffer.from(hex, 'hex'), targetHeight: height as number, format };
  }

  private mapLookupError(e: unknown): ProofError {
    // -5: block not found
    if (e instanceof CoreRpcError && e.code === -5) return checkpointUnknown();
    return this.mapError(e, null);
  }

  /** Core / transport failure -> public error. Never exposes credentials or Core's full error body. */
  private mapError(e: unknown, req: ProofRequest | null): ProofError {
    if (e instanceof ProofError) return e;
    if (e instanceof CoreRpcError) {
      const msg = e.message.replace(/^[^:]*: /, '').replace(/ \(code -?\d+\)$/, '');
      if (e.code === -32601) {
        this.unsupportedUntil = this.now() + UNSUPPORTED_TTL_MS;
        return unsupported();
      }
      if (e.code === -8 && /not on the active chain/i.test(msg)) return checkpointUnknown();
      if (e.code === -8) return new ProofError(400, 'bad-request', 'Core rejected the proof request parameters');
      if (e.code === -1) {
        if (/no archived certificate/i.test(msg)) {
          if (req && req.height > 0) return new ProofError(409, 'not-yet', 'no ChainLocked certificate at or above the requested height yet; retry later');
          return new ProofError(422, 'no-bridge', 'no archived ChainLock certificate newer than the checkpoint within the search budget');
        }
        if (/no bridge to snapshot/i.test(msg)) return new ProofError(422, 'no-bridge', 'no bridge to a snapshot within the search budget; use a newer checkpoint');
        if (/requested quorum is not in the target root/i.test(msg)) return new ProofError(422, 'no-bridge', 'the requested quorum is not in the target root');
        if (/chain changed during proof construction/i.test(msg)) return new ProofError(422, 'no-bridge', 'the chain changed during proof construction; retry');
        // Core's wording is not part of the contract: keep the detail in the log, not in the answer
        log.warn('quorum proof: unmatched Core error', { code: e.code, message: cut(msg) });
        return new ProofError(422, 'no-bridge', 'Core could not build a proof');
      }
      log.warn('quorum proof: unexpected Core error', { code: e.code, message: cut(msg) });
      return new ProofError(502, 'core', `Core RPC error (code ${e.code})`);
    }
    log.warn('quorum proof: Core call failed', { error: cut(String((e as Error)?.message ?? e)) });
    if (isTimeout(e)) return new ProofError(502, 'core', 'Core did not answer in time');
    return new ProofError(502, 'core', 'Core RPC is unavailable');
  }
}

const unsupported = () => new ProofError(501, 'unsupported', "this bridge's dashd has no getquorumproofchain; it needs Dash Core v24");
const checkpointUnknown = () => new ProofError(404, 'checkpoint-unknown', 'the checkpoint is not a block on the active chain of this bridge');

export const cacheKey = (r: ProofRequest): string => `${r.checkpoint}|${r.height}|${r.quorumHash ?? ''}|${r.llmqType ?? ''}|${r.nodeCount}`;
/** The cache key without the minimum height: requests that differ only in height can share a proof. */
const groupKey = (r: ProofRequest): string => `${r.checkpoint}|${r.quorumHash ?? ''}|${r.llmqType ?? ''}|${r.nodeCount}`;

// ---- HTTP ----

export const QUORUM_PROOF_EXPOSED_HEADERS = ['X-Proof-Target-Height', 'X-Proof-Format', 'Retry-After'];

function socketPeer(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address ?? undefined;
  } catch {
    return undefined; // no socket (tests): everyone shares one bucket
  }
}

/** Registers GET and POST /v1/quorum-proof on `app`. Returns the service (tests inspect it). */
export function registerQuorumProof(app: Hono, rpc: ProofRpc, cfg: { quorumProof: QuorumProofConfig; http: { clientIpHeader: string; trustedProxyCidrs: string[] } }, now?: () => number): QuorumProofService {
  const service = new QuorumProofService(rpc, cfg.quorumProof, now);
  const trusted = peerTrust(cfg.http.trustedProxyCidrs);

  const fail = (c: Context, e: ProofError) => {
    c.header('Cache-Control', 'no-store');
    if (e.retryAfter !== undefined) c.header('Retry-After', String(e.retryAfter));
    return c.json({ error: e.code, message: e.message }, e.status);
  };

  const respond = async (c: Context, parsed: Parsed) => {
    if (!parsed.ok) return fail(c, new ProofError(400, 'bad-request', parsed.message));
    const ip = resolveClientIp({ header: cfg.http.clientIpHeader, get: (n) => c.req.header(n), peer: socketPeer(c), trusted });
    try {
      const r = await service.get(parsed.req, ipBucket(ip));
      // freshness matters and the server-side cache absorbs the load; the headers are informational (clients must not trust them)
      return c.body(r.bytes as Uint8Array<ArrayBuffer>, 200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Proof-Target-Height': String(r.targetHeight),
        'X-Proof-Format': r.format,
      });
    } catch (e) {
      if (e instanceof ProofError) return fail(c, e);
      throw e;
    }
  };

  app.get(QUORUM_PROOF_PATH, (c) => respond(c, parseProofQuery(new URL(c.req.url).searchParams)));
  app.post(
    QUORUM_PROOF_PATH,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => fail(c, new ProofError(413, 'too-large', `body is larger than ${MAX_BODY_BYTES} bytes`)),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return fail(c, new ProofError(400, 'bad-request', 'body is not valid JSON'));
      }
      return respond(c, parseProofBody(body));
    },
  );
  return service;
}
