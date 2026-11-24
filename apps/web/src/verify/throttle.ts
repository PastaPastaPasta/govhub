// Gentle on the Dash network's nodes: every DAPI call of the verification worker goes through one adaptive gate (up to a moderate
// number at a time while nodes answer; halved on a rate refusal, then grown back as calls succeed), and a call the nodes refused for
// rate (HTTP 429, RESOURCE_EXHAUSTED, this client's own per-node budget) waits, pausing every caller, and tries again, honouring the
// node's reset hint, with capped exponential backoff and jitter. Nothing about what a call proves changes.
import { AllNodesFailedError, type Dapi } from '@govhub/dapi';

/** DAPI calls in flight at once while the nodes answer normally, across every check this worker runs (the SDK's own default is 24). */
export const DAPI_CONCURRENCY = 10;
/** The fewest in flight after rate refusals. */
export const DAPI_MIN_CONCURRENCY = 2;

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  capMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Told before each wait (the gate pauses every caller for as long). */
  onWait?: (ms: number) => void;
}

export const RETRY_DEFAULTS = { retries: 4, baseMs: 1_000, capMs: 30_000 } as const;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface Gate {
  run<T>(f: () => Promise<T>): Promise<T>;
  /** Start nothing new for `ms` (the nodes refused a whole call for rate). */
  pause(ms: number): void;
  /** A node refused for rate: halve the limit (at most once per `coolMs`), down to the minimum. */
  slowDown(): void;
  /** A call succeeded: every `recoverAfter` of them raise the limit by one, up to the maximum. */
  succeeded(): void;
  readonly limit: number;
}

/**
 * Monotonic time: the page's and workers' `Date` may be shifted or slowed (the e2e replay runs it 1000 times slower), and a gate
 * reading it would wait that much longer.
 */
const monotonic = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * `holdMs`: a job counts against the limit for at most this long. A call can wait minutes on a header stream for a ChainLock, and
 * one helper calls another inside its own call: past the lease its slot is given to the queue, so the gate can never deadlock.
 */
export function createGate(o: {
  max: number; min?: number; recoverAfter?: number; coolMs?: number; holdMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>;
}): Gate {
  const now = o.now ?? monotonic, sleep = o.sleep ?? wait, holdMs = o.holdMs ?? 20_000, min = Math.min(o.min ?? DAPI_MIN_CONCURRENCY, o.max);
  const recoverAfter = o.recoverAfter ?? 8, coolMs = o.coolMs ?? 1_000;
  const queue: Array<() => void> = [];
  let active = 0, limit = o.max, pausedUntil = 0, pumping = false, wins = 0, slowedAt = -Infinity;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && active < limit) {
        const ms = pausedUntil - now();
        if (ms > 0) {
          await sleep(ms);
          continue;
        }
        active++;
        queue.shift()!();
      }
    } finally {
      pumping = false;
    }
  };
  return {
    get limit() {
      return limit;
    },
    run<T>(f: () => Promise<T>): Promise<T> {
      const turn = new Promise<void>((resolve) => queue.push(resolve));
      void pump();
      let lease: ReturnType<typeof setTimeout> | undefined;
      let held = true;
      const release = () => {
        clearTimeout(lease);
        if (!held) return;
        held = false;
        active--;
        void pump();
      };
      return turn
        .then(() => {
          lease = setTimeout(release, holdMs);
          return f();
        })
        .finally(release);
    },
    pause(ms) {
      pausedUntil = Math.max(pausedUntil, now() + ms);
    },
    slowDown() {
      wins = 0;
      if (now() - slowedAt < coolMs) return;
      slowedAt = now();
      limit = Math.max(min, Math.floor(limit / 2));
    },
    succeeded() {
      if (limit >= o.max || ++wins < recoverAfter) return;
      wins = 0;
      limit++;
      void pump();
    },
  };
}

const refused = (e: unknown): boolean => {
  const g = e as { http?: unknown; code?: unknown; name?: unknown; budget?: unknown; message?: unknown } | null;
  if (!g || g.name !== 'GrpcError') return false;
  return g.http === 429 || (g.code === 8 && (!!g.budget || /rate|too many|quota/i.test(String(g.message))));
};

/** A node that could not be asked (unreachable, unavailable, our own deadline): it said nothing, true or false. */
const unanswered = (e: unknown): boolean => {
  const g = e as { name?: unknown; network?: unknown; code?: unknown } | null;
  return !!g && g.name === 'GrpcError' && (g.network === true || g.code === 14 || g.code === 4);
};

/**
 * Whether the nodes refused for rate rather than answered: a 429 or RESOURCE_EXHAUSTED, or every node attempt failing with at least one
 * of those and the rest unanswered. Any other failure (an answer that did not check out or could not be read, another status) is not.
 * No node to pick at all means every node's budget is spent for this minute.
 */
export function isRateLimited(e: unknown): boolean {
  if (e instanceof AllNodesFailedError) {
    if (!e.errors.length) return true;
    return e.errors.some((x) => refused(x.error)) && e.errors.every((x) => refused(x.error) || unanswered(x.error));
  }
  return refused(e);
}

/** Several failures of one step (e.g. anchoring tried twice) were all only rate refusals. */
export const allRateLimited = (errors: readonly unknown[]): boolean => errors.length > 0 && errors.every(isRateLimited);

/** The longest reset a refusing node asked for (its ratelimit-reset or Retry-After seconds), in ms; 0 without one. */
export function retryAfterMs(e: unknown): number {
  const errs = e instanceof AllNodesFailedError ? e.errors.map((x) => x.error) : [e];
  let s = 0;
  for (const x of errs) {
    if (!refused(x)) continue;
    const r = x as { rate?: { reset?: string | null }; retryAfter?: unknown };
    for (const v of [r.rate?.reset, r.retryAfter]) {
      const n = Number(v);
      if (v != null && Number.isFinite(n) && n > s) s = n;
    }
  }
  return s * 1000;
}

/** Exponential with jitter (half fixed, half random), never under the node's own hint, never over `capMs`. */
export function backoffDelay(attempt: number, hintMs = 0, o: Pick<RetryOptions, 'baseMs' | 'capMs' | 'random'> = {}): number {
  const cap = o.capMs ?? RETRY_DEFAULTS.capMs;
  const exp = Math.min(cap, (o.baseMs ?? RETRY_DEFAULTS.baseMs) * 2 ** attempt);
  const jittered = exp / 2 + (o.random ?? Math.random)() * (exp / 2);
  return Math.round(Math.min(cap, Math.max(hintMs, jittered)));
}

/** `f`, tried again after a rate refusal (up to `retries` times); any other error, or the last refusal, is thrown as it is. */
export async function retryRateLimited<T>(f: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const retries = o.retries ?? RETRY_DEFAULTS.retries, sleep = o.sleep ?? wait;
  for (let attempt = 0; ; attempt++) {
    try {
      return await f();
    } catch (e) {
      if (attempt >= retries || o.signal?.aborted || !isRateLimited(e)) throw e;
      const ms = backoffDelay(attempt, retryAfterMs(e), o);
      o.onWait?.(ms);
      await sleep(ms);
    }
  }
}

/**
 * Route every `dapi.call` (and so every helper built on it: ProRegTx lookups, blocks, transactions, the newest ChainLock) through
 * `gate`, with retries. Each node attempt a node refuses for rate slows the gate, even when another node then answers. Header and
 * masternode-list streams the anchor opens itself are not calls and are not gated.
 */
export function throttleDapi(dapi: Dapi, gate: Gate, o: RetryOptions = {}): Dapi {
  const call = dapi.call.bind(dapi);
  dapi.call = (fn, co = {}) => {
    const attempt: typeof fn = (core, signal) =>
      fn(core, signal).catch((e: unknown) => {
        if (refused(e)) gate.slowDown();
        throw e;
      });
    const once = () =>
      gate.run(async () => {
        if (co.signal?.aborted) throw co.signal.reason;
        const r = await call(attempt, co);
        gate.succeeded();
        return r;
      });
    return retryRateLimited(once, { ...o, ...(co.signal ? { signal: co.signal } : {}), onWait: (ms) => gate.pause(ms) });
  };
  return dapi;
}
