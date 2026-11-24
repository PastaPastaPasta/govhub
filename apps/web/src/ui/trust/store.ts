// Two small caches behind the trust badge:
//   - the last full result per proposal, for the list cards (IndexedDB + memory). A cached "verified" is only shown while the card
//     shows the very tally (same block) it was computed for: votes move on, the content does not.
//   - the funding order (a recount of every active proposal), shared by every proposal page of one data source for 10 minutes.
//   - each proposal's vote recount, per data source and exact tallies, for 10 minutes (memory, and this tab's sessionStorage).
// Both are retried on their own, later, when the Dash network's nodes asked this browser to slow down.
import { useEffect, useSyncExternalStore } from 'react';
import { cacheGet, cachePut } from '../../data/cache.ts';
import type { DataSource } from '../../data/repo.ts';
import type { Proposal, Tally } from '../../data/types.ts';
import type { TrustLevel } from '../../verify/aggregate.ts';
import { runVerification, VERIFIER_BUILD } from '../../verify/client.ts';
import type { RankingDone, VotesDone, WorkerRequest } from '../../verify/protocol.ts';
import { notYetChecked, retryWhenThrottled } from '../../lib/netError.ts';

export interface StoredTrust {
  level: Exclude<TrustLevel, 'checking' | 'demo'>;
  reason: string | null;
  /** asOfHeight and voteSetHash of the tally the page showed when it was computed (null: none). */
  tallyHeight: number | null;
  voteSetHash: string | null;
  /** In the next budget on proven data (only with level "verified"); null otherwise. */
  funded: boolean | null;
  /** ms */
  at: number;
}

/** How long a cached result is shown on a card at all, and a cached "verified" (votes move on). */
const MAX_AGE_MS = 7 * 86_400_000;
const VERIFIED_MAX_AGE_MS = 6 * 3_600_000;

/** Results depend on the data source and the bridge that served the votes. */
export const trustScope = (source: DataSource): string => `${source.scope}:${JSON.stringify(source.bridgeDescriptor())}`;

const memory = new Map<string, StoredTrust | null>();
const listeners = new Set<() => void>();
let version = 0;
const bump = () => {
  version++;
  for (const f of listeners) f();
};
const keyOf = (scope: string, p: Pick<Proposal, 'govHash' | 'collateralTxid'>) => `${scope}:trust:${p.govHash}:${p.collateralTxid}`;

export function saveTrust(scope: string, p: Pick<Proposal, 'govHash' | 'collateralTxid'>, t: StoredTrust): void {
  const k = keyOf(scope, p);
  const old = memory.get(k);
  if (old && old.level === t.level && old.reason === t.reason && old.tallyHeight === t.tallyHeight && old.voteSetHash === t.voteSetHash && old.funded === t.funded) return;
  memory.set(k, t);
  bump();
  void cachePut(k, t, null).catch(() => {});
}

/**
 * What a card may show for this proposal: the cached result, with "verified" only when it was computed for the tally the card shows
 * now. Anything else (no result, too old, verified for another tally) is null: the card then shows no trust mark.
 */
export function useCachedTrust(scope: string, p: Pick<Proposal, 'govHash' | 'collateralTxid'>, tally: Pick<Tally, 'asOfHeight' | 'voteSetHash'> | null): StoredTrust | null {
  useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => version,
  );
  const k = keyOf(scope, p);
  useEffect(() => {
    if (memory.has(k)) return;
    memory.set(k, null);
    void cacheGet<StoredTrust>(k).then((e) => {
      if (e?.value && !memory.get(k)) {
        memory.set(k, e.value);
        bump();
      }
    });
  }, [k]);
  const t = memory.get(k) ?? null;
  if (!t || Date.now() - t.at > MAX_AGE_MS) return null;
  if (t.level === 'verified') {
    const same = !!tally && t.tallyHeight === tally.asOfHeight && t.voteSetHash?.toLowerCase() === tally.voteSetHash.toLowerCase();
    if (!same || Date.now() - t.at > VERIFIED_MAX_AGE_MS) return null;
  }
  return t;
}

// ---- shared runs ------------------------------------------------------------------------------------------------------------

const SHARED_TTL_MS = 10 * 60_000;
const MAX_SHARED = 32;

interface SharedRun<T> {
  at: number;
  promise: Promise<T>;
  progress: Set<(m: string) => void>;
  /** Callers still waiting for it (one with no `signal` waits for good): when none is left, a throttled run stops retrying. */
  watchers: number;
}

type SharedOptions = { force?: boolean; onProgress?: ((m: string) => void) | undefined; signal?: AbortSignal | undefined };

function watch<T>(entry: SharedRun<T>, o: SharedOptions): void {
  if (o.signal?.aborted) return;
  entry.watchers++;
  if (o.onProgress) entry.progress.add(o.onProgress);
  o.signal?.addEventListener('abort', () => {
    entry.watchers--;
    if (o.onProgress) entry.progress.delete(o.onProgress);
  }, { once: true });
}

/**
 * One run per key for `SHARED_TTL_MS` (or again with `force`), its progress told to every caller. A failed run is not kept. `start`
 * is retried later on its own while the nodes ask this browser to slow down and a caller still waits (`signal` not aborted), saying
 * so as its progress (`what`: the check's name).
 */
export function sharedRun<T>(
  runs: Map<string, SharedRun<T>>, key: string, what: string, start: (progress: (m: string) => void) => Promise<T>,
  o: SharedOptions & { retry?: Parameters<typeof retryWhenThrottled>[1] } = {},
): Promise<T> {
  const hit = runs.get(key);
  if (hit && !o.force && Date.now() - hit.at < SHARED_TTL_MS) {
    watch(hit, o);
    return hit.promise;
  }
  const progress = new Set<(m: string) => void>();
  const say = (m: string) => {
    for (const f of progress) f(m);
  };
  const entry: SharedRun<T> = { at: Date.now(), promise: null as unknown as Promise<T>, progress, watchers: 0 };
  watch(entry, o);
  const promise = (entry.promise = retryWhenThrottled(() => start(say), { ...o.retry, live: () => entry.watchers > 0, onWait: () => say(notYetChecked(what, true)) }));
  runs.delete(key);
  runs.set(key, entry);
  while (runs.size > MAX_SHARED) runs.delete(runs.keys().next().value!);
  promise.catch(() => runs.get(key) === entry && runs.delete(key));
  return promise;
}

// ---- the shared funding order -----------------------------------------------------------------------------------------------

const rankings = new Map<string, SharedRun<RankingDone>>();

/** The funding order of these active proposals, recounted once per data source and list for 10 minutes (or again with `force`). */
export function sharedRanking(source: DataSource, proposals: readonly Proposal[], o: SharedOptions = {}): Promise<RankingDone> {
  const bridge = source.bridgeDescriptor();
  if (!bridge) return Promise.reject(new Error('no data service is configured'));
  const key = `${source.scope}:${JSON.stringify(bridge)}:${JSON.stringify(source.dapiDescriptor())}:${proposals.map((p) => p.govHash).sort().join(',')}`;
  const req = { kind: 'ranking' as const, proposals: [...proposals], bridge, dapi: source.dapiDescriptor(), network: source.coreNetwork, now: source.now() };
  return sharedRun(rankings, key, 'The funding order', (say) => runVerification(req, say), o);
}

// ---- the vote recount --------------------------------------------------------------------------------------------------------

export type VotesRequest = Omit<Extract<WorkerRequest, { kind: 'votes' }>, 'id'>;

const recounts = new Map<string, SharedRun<VotesDone>>();
const SESSION_PREFIX = 'govhub:recount:';
const MAX_SESSION_BYTES = 64_000;

/** Everything a recount's answer depends on: this build, the data source, the bridge and DAPI settings, the proposal, and every tally compared (in full). */
export const recountKey = (scope: string, r: VotesRequest): string =>
  JSON.stringify([VERIFIER_BUILD, scope, r.bridge, r.dapi, r.network, r.govHash, r.crossCheckSml, r.targets]);

const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return `${h.toString(36)}${s.length.toString(36)}`;
};

function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function sessionLoad(key: string): { at: number; value: VotesDone } | null {
  try {
    const raw = session()?.getItem(SESSION_PREFIX + fnv(key));
    const e = raw ? (JSON.parse(raw) as { key?: unknown; at?: unknown; value?: VotesDone }) : null;
    if (!e || e.key !== key || typeof e.at !== 'number' || Date.now() - e.at >= SHARED_TTL_MS || e.value?.kind !== 'votes' || !Array.isArray(e.value.runs)) return null;
    return { at: e.at, value: e.value };
  } catch {
    return null;
  }
}

function sessionSave(key: string, value: VotesDone): void {
  try {
    const s = session();
    if (!s) return;
    for (let i = s.length - 1; i >= 0; i--) {
      const k = s.key(i);
      if (!k?.startsWith(SESSION_PREFIX)) continue;
      let at: unknown;
      try {
        at = (JSON.parse(s.getItem(k) ?? '{}') as { at?: unknown }).at;
      } catch {
        at = null;
      }
      if (typeof at !== 'number' || Date.now() - at >= SHARED_TTL_MS) s.removeItem(k);
    }
    const raw = JSON.stringify({ key, at: Date.now(), value });
    if (raw.length <= MAX_SESSION_BYTES) s.setItem(SESSION_PREFIX + fnv(key), raw);
  } catch {
    // storage full or unavailable: the in-memory copy still serves this page
  }
}

/**
 * The vote recount of one proposal against these exact tallies, once per 10 minutes for the same data source and settings (again with
 * `force`): going back to a proposal shows the recount this browser already made instead of fetching every signature's proof again.
 */
export function sharedRecount(scope: string, req: VotesRequest, o: SharedOptions = {}): Promise<VotesDone> {
  const key = recountKey(scope, req);
  const hit = recounts.get(key);
  const stored = o.force || (hit && Date.now() - hit.at < SHARED_TTL_MS) ? null : sessionLoad(key);
  if (stored) recounts.set(key, { at: stored.at, promise: Promise.resolve(stored.value), progress: new Set(), watchers: 0 });
  return sharedRun(recounts, key, 'The vote count', (say) =>
    runVerification(req, say).then((r) => {
      sessionSave(key, r);
      return r;
    }), o);
}
