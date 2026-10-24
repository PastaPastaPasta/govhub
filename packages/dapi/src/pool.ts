// Node pool: random selection, per-node request budget (evonodes allow ~150 req/min) and failure cooldowns.
import { GrpcError } from './grpcweb.ts';
import { sample } from './nodes.ts';

export interface PoolOptions {
  /** Client-side request budget per node per rolling minute. Default 150, the nodes' own limit. */
  maxPerMinute?: number;
  /** How long a failed node is avoided. Default 60 s; HTTP 429 uses the server's ratelimit-reset when sent. */
  cooldownMs?: number;
  now?: () => number;
  random?: () => number;
}

const WINDOW_MS = 60_000;

export class NodePool {
  readonly maxPerMinute: number;
  #nodes: string[] = [];
  readonly #cooldown = new Map<string, number>();
  readonly #log = new Map<string, number[]>();
  readonly #cooldownMs: number;
  readonly #now: () => number;
  readonly #random?: () => number;

  constructor(nodes: readonly string[] = [], o: PoolOptions = {}) {
    this.maxPerMinute = o.maxPerMinute ?? 150;
    this.#cooldownMs = o.cooldownMs ?? 60_000;
    this.#now = o.now ?? Date.now;
    this.#random = o.random;
    this.setNodes(nodes);
  }

  get size(): number { return this.#nodes.length; }
  list(): string[] { return this.#nodes.slice(); }

  /** 'replace' swaps the list; 'append' keeps the current nodes first and adds new ones after them. */
  setNodes(nodes: readonly string[], mode: 'replace' | 'append' = 'replace'): void {
    this.#nodes = [...new Set(mode === 'append' ? [...this.#nodes, ...nodes] : nodes)];
  }

  /** Requests sent to `node` in the last minute. */
  used(node: string): number {
    const cut = this.#now() - WINDOW_MS;
    const log = (this.#log.get(node) ?? []).filter((t) => t > cut);
    if (log.length) this.#log.set(node, log); else this.#log.delete(node);
    return log.length;
  }

  /** Record one request (a unary call or a stream open). Throws a budget GrpcError, sending nothing, when the node's budget is spent. */
  charge(node: string): void {
    if (this.used(node) >= this.maxPerMinute) throw new GrpcError(8, `client-side budget of ${this.maxPerMinute} req/min exhausted for ${node}`, { budget: true });
    const log = this.#log.get(node);
    if (log) log.push(this.#now()); else this.#log.set(node, [this.#now()]);
  }

  /** Avoid `node` for a while. Call on any error that says "try another node". */
  fail(node: string, err?: unknown): void {
    let ms = this.#cooldownMs;
    const reset = Number((err as GrpcError | undefined)?.rate?.reset);
    if ((err as GrpcError | undefined)?.http === 429 && Number.isFinite(reset) && reset > 0) ms = Math.min(reset, 300) * 1000;
    this.#cooldown.set(node, this.#now() + ms);
  }

  ok(node: string): void { this.#cooldown.delete(node); }

  cooling(node: string): boolean {
    const until = this.#cooldown.get(node);
    if (until === undefined) return false;
    if (until <= this.#now()) { this.#cooldown.delete(node); return false; }
    return true;
  }

  /** Up to `count` distinct nodes in random order, healthy ones with budget left first, then cooling-down ones with budget. */
  pick(count: number, exclude: Iterable<string> = []): string[] {
    const ex = new Set(exclude);
    const free = this.#nodes.filter((n) => !ex.has(n) && this.used(n) < this.maxPerMinute);
    const good = sample(free.filter((n) => !this.cooling(n)), count, this.#random);
    if (good.length >= count) return good;
    return [...good, ...sample(free.filter((n) => this.cooling(n)), count - good.length, this.#random)];
  }
}

/** Full-jitter exponential backoff: a uniform random delay in [0, min(cap, base * 2^attempt)]. */
export function backoffMs(attempt: number, base = 150, cap = 3000, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(cap, base * 2 ** attempt));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal!.reason ?? new DOMException('aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
