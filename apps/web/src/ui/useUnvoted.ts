// "Not voted yet": which active proposals none of the signed-in user's masternodes has voted on. The current votes come from the
// bridge (one request per proposal, signatures checked against the keyring's keys), so they are only read while the filter is on.
import { useEffect, useMemo, useState } from 'react';
import { errorText } from '../auth/runtime.ts';
import { useKeyring } from '../voting/KeyringContext.tsx';
import { isOpen } from '../voting/pending.ts';
import { currentKey, mnId, type CurrentVote } from '../voting/plan.ts';

export interface Unvoted {
  /** the keyring is open and holds a masternode's voting key: the filter can be offered */
  available: boolean;
  /** govHashes at least one of the user's masternodes has voted on (or has a vote on its way for); null until read */
  voted: ReadonlySet<string> | null;
  loading: boolean;
  error: string | null;
}

export function useUnvoted(enabled: boolean, govHashes: readonly string[]): Unvoted {
  const { status, mns, watched, currentVotes } = useKeyring();
  const owned = mns.owned;
  const available = status === 'open' && owned.length > 0;
  const key = enabled && available ? govHashes.join(',') : '';
  const [read, setRead] = useState<{ key: string; votes?: Map<string, CurrentVote>; error?: string } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    currentVotes(key.split(',')).then(
      (votes) => live && setRead({ key, votes }),
      (e) => live && setRead({ key, error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [key, currentVotes]);
  // an answer for another list (or before a filter change) is never applied
  const cur = key && read?.key === key ? read : null;
  const voted = useMemo(() => {
    if (!cur?.votes) return null;
    const mine = new Set(owned.map(mnId));
    const out = new Set<string>();
    for (const h of govHashes) if (owned.some((m) => cur.votes!.has(currentKey(m, h)))) out.add(h);
    for (const w of watched) if ((isOpen(w) || w.status === 'confirmed') && mine.has(mnId(w))) out.add(w.govHash);
    return out;
  }, [cur, owned, govHashes, watched]);
  return { available, voted, loading: !!key && !cur, error: cur?.error ?? null };
}
