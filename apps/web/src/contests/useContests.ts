import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../app/context.tsx';
import { fixtureContests, liveContests, type ContestSource } from './source.ts';

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
