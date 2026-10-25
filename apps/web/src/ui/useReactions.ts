// Reactions on a set of targets (a proposal, or the comments on screen): read with F6 (paged, 4 targets in flight),
// scored client-side, and voted on through the session with local updates so the UI does not wait for a node
// that lags behind the write. Each target is read once per data source: a growing set (more comments shown) reads only the
// new targets. F6 stays one query per target: no PV13 index takes an `in` over targets for every author (`in` must be on an
// index's last property; byTarget ends in $createdAt, and byOwnerTarget needs one $ownerId).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { idToHex, mapLimit, REACTION_KIND, score, targetB64, type Reaction, type Score } from '@govhub/forum';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { errText } from '../lib/format.ts';

export type Target = { govHash: string } | { commentId: string };
const keyOf = (t: Target) => ('govHash' in t ? t.govHash : t.commentId);
const hexOf = (t: Target) => ('govHash' in t ? t.govHash : idToHex(t.commentId));
const kindOf = (t: Target) => ('govHash' in t ? REACTION_KIND.proposal : REACTION_KIND.comment);

export function useReactions(targets: readonly Target[]) {
  const { source } = useApp();
  const { forum, session, write, moderation } = useForum();
  const [byKey, setByKey] = useState(new Map<string, Reaction[]>());
  const [error, setError] = useState<string | null>(null);
  const keys = targets.map(keyOf).join(',');
  /** targets read (or being read) from this data source */
  const requested = useRef<{ forum: typeof forum; keys: Set<string> }>({ forum, keys: new Set() });

  useEffect(() => {
    if (requested.current.forum !== forum) {
      requested.current = { forum, keys: new Set() };
      setByKey(new Map());
    }
    const asked = requested.current;
    const todo = targets.filter((t) => !asked.keys.has(keyOf(t)));
    if (todo.length === 0) return;
    for (const t of todo) asked.keys.add(keyOf(t));
    setError(null);
    mapLimit(todo, 4, async (t) => [keyOf(t), await forum.reader.reactions(targetB64(t))] as const).then(
      (pairs) => {
        if (requested.current === asked) setByKey((m) => new Map([...m, ...pairs]));
      },
      (e: unknown) => {
        for (const t of todo) asked.keys.delete(keyOf(t)); // read again next time
        if (requested.current === asked) setError(errText(e));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forum, keys]);

  const scores = useMemo(() => {
    const out = new Map<string, Score>();
    for (const t of targets) {
      out.set(keyOf(t), score(byKey.get(keyOf(t)) ?? [], { kind: kindOf(t), target: hexOf(t), viewer: session?.identityId ?? null, exclude: moderation.index.identityHidden }));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byKey, keys, session, moderation.index]);

  const vote = useCallback(
    async (t: Target, value: 1 | -1) => {
      if (!session) throw new Error('sign in to vote');
      const k = keyOf(t);
      const mine = scores.get(k)?.mine;
      const op = forum.ops.react(t, value, mine);
      const r = await write(op);
      const now = source.now() * 1000 || Date.now();
      setByKey((m) => {
        const list = (m.get(k) ?? []).filter((x) => x.ownerId !== session.identityId);
        if (op.action !== 'delete') list.push({ id: r.id, ownerId: session.identityId, target: hexOf(t), kind: kindOf(t), value, revision: r.revision ?? 1, createdAt: mine?.createdAt ?? now, updatedAt: now });
        return new Map(m).set(k, list);
      });
    },
    [session, scores, forum, write, source],
  );

  return { scores, vote, error };
}
