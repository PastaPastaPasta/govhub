// The primary DPNS names (alice.dash) of identities, for any view that shows one: the forum source batches every id asked for in
// the same tick into one proved query and caches the answers (data/dpns.ts), so each view simply asks for the ids it shows.
import { useEffect, useState } from 'react';
import { useForum } from '../app/forum.tsx';

const NONE: ReadonlyMap<string, string> = new Map();

export function useDpnsNames(ids: readonly (string | null | undefined)[]): ReadonlyMap<string, string> {
  return useDpnsNamesRead(ids).names;
}

/** The names, and whether the answer for exactly these ids has arrived (so "no username" can be said). */
export function useDpnsNamesRead(ids: readonly (string | null | undefined)[]): { names: ReadonlyMap<string, string>; read: boolean } {
  const { forum } = useForum();
  const key = [...new Set(ids.filter((x): x is string => !!x))].sort().join(',');
  const [state, setState] = useState<{ forum: unknown; key: string; names: ReadonlyMap<string, string> }>({ forum, key: '', names: NONE });
  useEffect(() => {
    if (!key) return;
    let live = true;
    forum.names(key.split(',')).then(
      (names) => live && setState({ forum, key, names }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [forum, key]);
  // answers for another source (a network switch) are never shown; a changed id list keeps the names it still has meanwhile
  if (state.forum !== forum) return { names: NONE, read: false };
  return { names: state.names, read: state.key === key };
}
