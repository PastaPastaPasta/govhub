// Comment counts for list cards. Platform has no count query (PV13), so a count is the length of the proposal's
// comment list, read 100 at a time. To keep that cheap the (id, author, time) of every comment is kept in IndexedDB:
// a fresh entry (< 10 min) is used as is, a recent one (< 6 h) is topped up with "comments since T" (F2d), and only
// older ones are re-read in full (which also drops retracted comments, invisible to F2d). Hidden authors and
// documents are not counted.
import { useEffect, useMemo, useState } from 'react';
import { mapLimit, type Comment } from '@govhub/forum';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { cacheGet, cachePut } from '../data/cache.ts';

type Entry = [id: string, ownerId: string, createdAt: number];
const FRESH_MS = 10 * 60 * 1000;
const TOP_UP_MS = 6 * 60 * 60 * 1000;

const entriesOf = (cs: readonly Comment[]): Entry[] => cs.map((c) => [c.id, c.ownerId, c.createdAt]);

export function useCommentCounts(govHashes: readonly string[]): Map<string, number> {
  const { mode, registry, source } = useApp();
  const { forum, moderation } = useForum();
  const [entries, setEntries] = useState(new Map<string, Entry[]>());
  const key = govHashes.join(',');

  useEffect(() => {
    let live = true;
    const persist = mode === 'live';
    const cacheKey = (h: string) => `${source.scope}:${registry.forum.contractId}:comments:${h}`;
    const put = (h: string, e: Entry[]) => live && setEntries((m) => new Map(m).set(h, e));
    void mapLimit(govHashes, 3, async (h) => {
      try {
        const cached = persist ? await cacheGet<Entry[]>(cacheKey(h)) : undefined;
        const age = cached ? Date.now() - cached.savedAt : Infinity;
        if (cached) put(h, cached.value);
        if (cached && age < FRESH_MS) return;
        let next: Entry[];
        if (cached && age < TOP_UP_MS && cached.value.length) {
          const since = Math.max(...cached.value.map((e) => e[2]));
          const seen = new Set(cached.value.map((e) => e[0]));
          next = [...cached.value, ...entriesOf(await forum.reader.commentsSince(h, since)).filter((e) => !seen.has(e[0]))];
        } else {
          next = entriesOf((await forum.reader.comments(h)).comments);
        }
        put(h, next);
        if (persist) void cachePut(cacheKey(h), next, null);
      } catch {
        /* a card without a count is fine */
      }
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forum, key, mode, registry, source]);

  return useMemo(() => {
    const out = new Map<string, number>();
    if (!moderation.ready) return out; // never count before the block lists are known
    for (const [h, es] of entries) out.set(h, es.filter(([id, ownerId]) => moderation.index.reasons({ id, ownerId }).length === 0).length);
    return out;
  }, [entries, moderation.index, moderation.ready]);
}
