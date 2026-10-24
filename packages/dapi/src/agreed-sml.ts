// SML retrieval with cross-node agreement (loaded on first use by Dapi.getSml / refreshNodesFromSml).
import type { Dapi } from './client.ts';
import { VerificationError } from './errors.ts';
import { GrpcError, abortReason, isAbort, link } from './grpcweb.ts';
import { backoffMs, sleep } from './pool.ts';
import { type Sml, parseSml } from './sml.ts';
import type { AgreedSml, SmlOptions } from './types.ts';

interface State { at: number; gen: number; value?: AgreedSml; inflight?: Promise<AgreedSml> }
const states = new WeakMap<Dapi, State>();

/** Reject for this caller only when its signal fires; the shared fetch itself keeps going for everyone else (and for the cache). */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const on = () => reject(abortReason(signal));
    signal.addEventListener('abort', on, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', on));
  });
}

export function getSml(d: Dapi, o: SmlOptions = {}): Promise<AgreedSml> {
  const st = states.get(d) ?? { at: 0, gen: 0 };
  states.set(d, st);
  if (!o.force && st.value && Date.now() - st.at < (d.options.smlTtlMs ?? 300_000)) return Promise.resolve(st.value);
  if (!o.force && st.inflight) return abortable(st.inflight, o.signal);
  const gen = ++st.gen;
  // the fetch is shared between callers, so it must not be tied to any one caller's signal
  const p = fetchAgreed(d, { ...o, signal: undefined }).then((value) => {
    if (gen === st.gen) { st.value = value; st.at = Date.now(); } // a slower, older fetch never overwrites a newer one
    return value;
  });
  const clear = () => { if (st.inflight === p) st.inflight = undefined; };
  st.inflight = p;
  p.then(clear, clear);
  return abortable(p, o.signal);
}

async function fetchAgreed(d: Dapi, { nodes = 3, minAgree = 2, rounds = 3, hedgeAfterMs = 6000, hedgeNodes = 2, signal }: SmlOptions): Promise<AgreedSml> {
  await d.ready();
  const used = new Set<string>(), digests: Record<string, string[]> = {};
  for (let round = 0; round < rounds; round++) {
    const picked = d.pool.pick(nodes, used);
    if (!picked.length) break;
    picked.forEach((n) => used.add(n));
    const ctrl = new AbortController();
    const unlink = link(signal, ctrl);
    const groups = new Map<string, { sml: Sml; nodes: string[] }>();
    let hedge: ReturnType<typeof setTimeout> | undefined;
    try {
      const winner = await new Promise<{ sml: Sml; nodes: string[] } | null>((resolve) => {
        let pending = 0, done = false;
        const ask = (node: string) => {
          pending++;
          fetchFrom(d, node, ctrl.signal).then((sml) => {
            const g = groups.get(sml.digest) ?? { sml, nodes: [] };
            g.nodes.push(node); groups.set(sml.digest, g);
            (digests[sml.digest] ??= []).push(node);
            if (g.nodes.length >= minAgree) { done = true; resolve(g); }
          }, (e) => { if (!isAbort(e) && !(e as GrpcError).budget) d.pool.fail(node, e); }).finally(() => { if (--pending === 0 && !done) resolve(null); });
        };
        picked.forEach(ask);
        // the first message is ~1.4 MB and some nodes need 10-20 s for it: if agreement is slow, ask more nodes instead of waiting
        hedge = setTimeout(() => { if (!done) for (const n of d.pool.pick(hedgeNodes, used)) { used.add(n); ask(n); } }, hedgeAfterMs);
      });
      if (winner) return { ...winner.sml, agreedBy: winner.nodes, asked: [...used] };
    } finally {
      clearTimeout(hedge);
      ctrl.abort();
      unlink();
    }
    if (signal?.aborted) throw abortReason(signal);
    await sleep(backoffMs(round), signal);
  }
  throw new VerificationError('sml-disagree', `no ${minAgree} nodes returned the same SML (${Object.values(digests).map((n) => n.length).join('/') || 'none answered'})`);
}

async function fetchFrom(d: Dapi, node: string, signal: AbortSignal): Promise<Sml> {
  d.pool.charge(node);
  return new Promise<Sml>((resolve, reject) => {
    const h = d.core(node).subscribeToMasternodeList((b) => {
      h.cancel();
      try { resolve(parseSml(b)); } catch (e) { reject(e); }
    }, { signal, idleTimeoutMs: 45_000, connectTimeoutMs: d.options.timeoutMs ?? 15000 });
    void h.closed.then((r) => reject(
      r.reason === 'error' ? r.error : signal.aborted ? new DOMException('aborted', 'AbortError') : new GrpcError(14, 'SML stream ended without a message', { network: true }),
    ));
  });
}

export async function refreshNodesFromSml(d: Dapi, o: { mode?: 'append' | 'replace'; sml?: AgreedSml } = {}): Promise<{ count: number; added: number; sml: AgreedSml }> {
  const sml = o.sml ?? await getSml(d);
  const before = d.pool.size;
  d.pool.setNodes(sml.evonodes.map((e) => e.endpoint), o.mode ?? 'append');
  return { count: d.pool.size, added: Math.max(0, d.pool.size - before), sml };
}
