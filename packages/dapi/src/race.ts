// Multi-node helpers: race unary calls, and merge N streams with dedupe (IS-lock delivery robustness).
import type { StreamClose } from './grpcweb.ts';

export interface RaceFailure { node: string; error: unknown }
export interface RaceResult<T> { value: T; node: string; ms: number; failures: RaceFailure[] }

/**
 * Run fn(node, signal) over `nodes`: keep up to `n` in flight, replace failures with the next unused node, resolve with the
 * first result that passes `accept`, abort the losers. Rejects with `AggregateError`-like `{ failures }` when every node failed.
 */
export function race<T>(
  nodes: readonly string[],
  fn: (node: string, signal: AbortSignal) => Promise<T>,
  { n = 3, accept = () => true, signal }: { n?: number; accept?: (v: T) => boolean; signal?: AbortSignal } = {},
): Promise<RaceResult<T>> {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const failures: RaceFailure[] = [];
    let next = 0, inflight = 0, done = false;
    const finish = (f: () => void) => { if (done) return; done = true; ctrl.abort(); signal?.removeEventListener('abort', onExt); f(); };
    const onExt = () => finish(() => reject(signal!.reason ?? new DOMException('aborted', 'AbortError')));
    if (signal?.aborted) return onExt();
    signal?.addEventListener('abort', onExt, { once: true });

    const launch = (): boolean => {
      if (done || next >= nodes.length) return false;
      const node = nodes[next++]!, t0 = performance.now();
      inflight++;
      Promise.resolve().then(() => fn(node, ctrl.signal)).then(
        (value) => {
          inflight--;
          if (done) return;
          let good = false;
          try { good = accept(value); } catch { good = false; }
          if (good) finish(() => resolve({ value, node, ms: Math.round(performance.now() - t0), failures }));
          else { failures.push({ node, error: new Error('rejected by accept()') }); fill(); }
        },
        (error) => { inflight--; if (done) return; failures.push({ node, error }); fill(); },
      );
      return true;
    };
    const fill = () => {
      while (inflight < n && launch());
      if (!done && inflight === 0) finish(() => reject(Object.assign(new Error('all nodes failed'), { failures })));
    };
    fill();
  });
}

export interface MergeHandle { cancel(): void; closed: Promise<StreamClose | unknown> }
export interface MergeStats { opened: string[]; failed: { node: string; reason?: string; error: string }[]; firstBy: Record<string, number>; dupes: number; items: number; live: number }

/**
 * Keep `n` streams open on distinct nodes and deliver each distinct item once, from whichever node is first.
 * `open(node, emit, signal)` starts a stream and returns a handle; call emit(dedupeKey, item) for each item. A stream that
 * ends or errors is replaced by one on a fresh node (up to `maxReplacements`). `nodes` may be a function returning the next node.
 */
export function mergeStreams<T>(
  nodes: readonly string[] | (() => string | undefined),
  open: (node: string, emit: (key: string, item: T) => void, signal: AbortSignal) => MergeHandle,
  onItem: (item: T, node: string) => void,
  { n = 3, maxReplacements = 10, maxSeen = 10000, onClose, replaceDelayMs }: {
    n?: number; maxReplacements?: number; maxSeen?: number; onClose?: (node: string, res: unknown) => void;
    /** Delay before the k-th replacement stream is opened (use jittered backoff so a dead network is not hammered). */
    replaceDelayMs?: (k: number) => number;
  } = {},
): { cancel(): void; stats(): MergeStats; closed: Promise<void> } {
  const seen = new Set<string>(), ctrl = new AbortController();
  const stats: Omit<MergeStats, 'live'> = { opened: [], failed: [], firstBy: {}, dupes: 0, items: 0 };
  const handles = new Set<MergeHandle>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let idx = 0, replacements = 0, cancelled = false, resolveAll!: () => void;
  const closed = new Promise<void>((r) => { resolveAll = r; });
  const nextNode = typeof nodes === 'function' ? nodes : () => nodes[idx++];
  const emitFrom = (node: string) => (key: string, item: T) => {
    if (cancelled) return;
    if (seen.has(key)) { stats.dupes++; return; }
    seen.add(key);
    if (seen.size > maxSeen) seen.delete(seen.values().next().value!);
    stats.items++; stats.firstBy[node] = (stats.firstBy[node] || 0) + 1;
    onItem(item, node);
  };
  const launch = (): boolean => {
    for (;;) {
      if (cancelled) return false;
      const node = nextNode();
      if (node === undefined) return false;
      stats.opened.push(node);
      let h: MergeHandle;
      try { h = open(node, emitFrom(node), ctrl.signal); } catch (e) { stats.failed.push({ node, error: String(e) }); continue; }
      handles.add(h);
      Promise.resolve(h.closed).catch((error: unknown) => ({ reason: 'error', error })).then((res) => {
        handles.delete(h);
        if (cancelled) { if (!handles.size) resolveAll(); return; }
        const r = res as { reason?: string; error?: unknown } | undefined;
        stats.failed.push({ node, reason: r?.reason, error: String(r?.error ?? '') });
        try { onClose?.(node, res); } catch { /* observer errors must not break stream replacement */ }
        if (replacements++ < maxReplacements) {
          const d = replaceDelayMs?.(replacements) ?? 0;
          if (d > 0) {
            const t = setTimeout(() => { timers.delete(t); launch(); if (!handles.size && !timers.size) resolveAll(); }, d);
            timers.add(t);
          } else launch();
        }
        if (!handles.size && !timers.size) resolveAll();
      });
      return true;
    }
  };
  for (let i = 0; i < n; i++) launch();
  if (!handles.size) resolveAll();
  return {
    cancel() { cancelled = true; ctrl.abort(); for (const t of timers) clearTimeout(t); timers.clear(); for (const h of handles) h.cancel(); if (!handles.size) resolveAll(); },
    stats: () => ({ ...stats, live: handles.size }),
    closed,
  };
}
