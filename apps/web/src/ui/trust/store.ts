// Two small caches behind the trust badge:
//   - the last full result per proposal, for the list cards (IndexedDB + memory). A cached "verified" is only shown while the card
//     shows the very tally (same block) it was computed for: votes move on, the content does not.
//   - the funding order (a recount of every active proposal), shared by every proposal page of one data source for 10 minutes.
import { useEffect, useSyncExternalStore } from 'react';
import { cacheGet, cachePut } from '../../data/cache.ts';
import type { DataSource } from '../../data/repo.ts';
import type { Proposal } from '../../data/types.ts';
import type { TrustLevel } from '../../verify/aggregate.ts';
import { runVerification } from '../../verify/client.ts';
import type { RankingDone } from '../../verify/protocol.ts';

export interface StoredTrust {
  level: Exclude<TrustLevel, 'checking' | 'demo'>;
  reason: string | null;
  /** asOfHeight of the tally the page showed when it was computed (null: none). */
  tallyHeight: number | null;
  /** In the next budget on proven data (only with level "verified"); null otherwise. */
  funded: boolean | null;
  /** ms */
  at: number;
}

/** How long a cached result is shown on a card at all. */
const MAX_AGE_MS = 7 * 86_400_000;

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
  if (old && old.level === t.level && old.reason === t.reason && old.tallyHeight === t.tallyHeight && old.funded === t.funded) return;
  memory.set(k, t);
  bump();
  void cachePut(k, t, null).catch(() => {});
}

/**
 * What a card may show for this proposal: the cached result, with "verified" only when it was computed for the tally the card shows
 * now. Anything else (no result, too old, verified for another tally) is null: the card then shows no trust mark.
 */
export function useCachedTrust(scope: string, p: Pick<Proposal, 'govHash' | 'collateralTxid'>, tallyHeight: number | null): StoredTrust | null {
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
  if (t.level === 'verified' && (t.tallyHeight === null || t.tallyHeight !== tallyHeight)) return null;
  return t;
}

// ---- the shared funding order -----------------------------------------------------------------------------------------------

const RANKING_TTL_MS = 10 * 60_000;
const rankings = new Map<string, { at: number; promise: Promise<RankingDone>; progress: Set<(m: string) => void> }>();

/** The funding order of these active proposals, recounted once per data source and list for 10 minutes (or again with `force`). */
export function sharedRanking(source: DataSource, proposals: readonly Proposal[], o: { force?: boolean; onProgress?: (m: string) => void } = {}): Promise<RankingDone> {
  const bridge = source.bridgeDescriptor();
  if (!bridge) return Promise.reject(new Error('no bridge is configured'));
  const key = `${source.scope}:${JSON.stringify(source.dapiDescriptor())}:${proposals.map((p) => p.govHash).sort().join(',')}`;
  const hit = rankings.get(key);
  if (hit && !o.force && Date.now() - hit.at < RANKING_TTL_MS) {
    if (o.onProgress) hit.progress.add(o.onProgress);
    return hit.promise;
  }
  const progress = new Set<(m: string) => void>(o.onProgress ? [o.onProgress] : []);
  const promise = runVerification({ kind: 'ranking', proposals: [...proposals], bridge, dapi: source.dapiDescriptor(), network: source.coreNetwork, now: source.now() }, (m) => {
    for (const f of progress) f(m);
  });
  const entry = { at: Date.now(), promise, progress };
  rankings.set(key, entry);
  // a failed recount is not cached
  promise.catch(() => rankings.get(key) === entry && rankings.delete(key));
  return promise;
}
