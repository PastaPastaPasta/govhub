// Multi-node helpers: race unary calls, and merge N streams with dedupe (IS-lock delivery robustness).

/**
 * Race fn(node, signal) over `nodes`: keep up to `n` in flight, replace failures with the next unused node,
 * resolve with the first result that passes `accept`; abort the losers.
 * @returns {Promise<{value, node, ms, failures: {node, error}[]}>}
 */
export function race(nodes, fn, { n = 3, accept = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const failures = [];
    let next = 0, inflight = 0, done = false;
    const launch = () => {
      if (done || next >= nodes.length) return false;
      const node = nodes[next++], t0 = performance.now();
      inflight++;
      Promise.resolve().then(() => fn(node, ctrl.signal)).then(
        (value) => {
          inflight--;
          if (done) return;
          let good = false;
          try { good = accept(value); } catch { good = false; }
          if (good) { done = true; ctrl.abort(); resolve({ value, node, ms: Math.round(performance.now() - t0), failures }); }
          else { failures.push({ node, error: new Error('rejected by accept()') }); fill(); }
        },
        (error) => { inflight--; if (done) return; failures.push({ node, error }); fill(); },
      );
      return true;
    };
    const fill = () => {
      while (inflight < n && launch());
      if (!done && inflight === 0) { done = true; reject(Object.assign(new Error('all nodes failed'), { failures })); }
    };
    fill();
  });
}

/**
 * Keep `n` streams open on distinct nodes and deliver each distinct item once, from whichever node is first.
 * `open(node, emit, signal)` must start a stream and return a handle {cancel(), closed}; call emit(dedupeKey, item)
 * for each item. A stream that ends/errors is replaced by one on a fresh node (up to `maxReplacements`).
 * @returns {{cancel(): void, stats(): object, closed: Promise<void>}}
 */
export function mergeStreams(nodes, open, onItem, { n = 3, maxReplacements = 10, maxSeen = 10000 } = {}) {
  const seen = new Set(), ctrl = new AbortController();
  const stats = { opened: [], failed: [], firstBy: {}, dupes: 0, items: 0 };
  const handles = new Set();
  let next = 0, replacements = 0, cancelled = false, resolveAll;
  const closed = new Promise((r) => { resolveAll = r; });
  const emitFrom = (node) => (key, item) => {
    if (cancelled) return;
    if (seen.has(key)) { stats.dupes++; return; }
    seen.add(key); if (seen.size > maxSeen) seen.delete(seen.values().next().value);
    stats.items++; stats.firstBy[node] = (stats.firstBy[node] || 0) + 1;
    if (!cancelled) onItem(item, node);
  };
  const launch = () => {
    if (cancelled || next >= nodes.length) return false;
    const node = nodes[next++];
    stats.opened.push(node);
    let h;
    try { h = open(node, emitFrom(node), ctrl.signal); } catch (e) { stats.failed.push({ node, error: String(e) }); return launch(); }
    handles.add(h);
    Promise.resolve(h.closed).catch((error) => ({ reason: 'error', error })).then((res) => {
      handles.delete(h);
      if (cancelled) { if (!handles.size) resolveAll(); return; }
      stats.failed.push({ node, reason: res?.reason, error: String(res?.error ?? '') });
      if (replacements++ < maxReplacements) launch();
      if (!handles.size) resolveAll();
    });
    return true;
  };
  for (let i = 0; i < n; i++) launch();
  if (!handles.size) resolveAll();
  return {
    cancel() { cancelled = true; ctrl.abort(); for (const h of handles) h.cancel(); if (!handles.size) resolveAll(); },
    stats: () => ({ ...stats, live: handles.size }),
    closed,
  };
}
