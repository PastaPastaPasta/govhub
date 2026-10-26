import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import type { Registry } from '../config/registry.ts';
import { fixtureContests, liveContests, type ContestSource } from './source.ts';

const FLAG = 'govhub.contests';

/**
 * Username contests are shown on testnet Platform (the Testnet and Dev profiles), and on mainnet Platform only with `?contests=1`
 * (kept in this browser; `?contests=0` turns it off) until they launch there.
 */
export function contestsShown(r: Pick<Registry, 'platformNetwork'>, search = globalThis.location?.search ?? '', store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = globalThis.localStorage): boolean {
  const p = new URLSearchParams(search).get('contests');
  try {
    if (p === '1') store?.setItem(FLAG, '1');
    else if (p === '0') store?.removeItem(FLAG);
  } catch {
    // storage full or blocked: the flag simply does not stick
  }
  if (r.platformNetwork !== 'mainnet') return true;
  try {
    return store?.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

export function useContestsShown(): boolean {
  const { registry } = useApp();
  const { search } = useLocation();
  return useMemo(() => contestsShown(registry, search), [registry, search]);
}

/** The contest source for the current profile and data mode. */
export function useContestSource(): ContestSource {
  const { mode, registry } = useApp();
  return useMemo(() => (mode === 'fixtures' ? fixtureContests() : liveContests(registry)), [mode, registry]);
}

/** The data source's clock in ms (frozen in fixture mode), ticking every 30 s so countdowns and open/closed stay current. */
export function useClockMs(): number {
  const { source } = useApp();
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  // read on every render: the fixture clock is only set once the snapshot has loaded
  return source.now() * 1000;
}
