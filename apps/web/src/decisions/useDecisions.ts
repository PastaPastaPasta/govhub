import { useEffect, useMemo, useState } from 'react';
import { errText } from '../lib/format.ts';
import { useApp } from '../app/context.tsx';
import { fixtureDecisions, liveDecisions, type DecisionSource } from './source.ts';

/** The masternode poll source for the current profile and data mode. */
export function useDecisionSource(): DecisionSource {
  const { mode, registry } = useApp();
  return useMemo(() => (mode === 'fixtures' ? fixtureDecisions() : liveDecisions(registry)), [mode, registry]);
}

/** How often a network without masternode polls is asked again while a polls page is open. */
const RECHECK_MS = 5 * 60_000;

export type Availability = { phase: 'checking' } | { phase: 'yes' } | { phase: 'no' } | { phase: 'error'; error: string };

/**
 * Whether this network has masternode polls (the decision proposals contract, a proved read). While it has not, it is asked again every
 * few minutes, so the page lights up by itself when the network moves to protocol version 15.
 */
export function usePollsAvailable(src: DecisionSource): Availability & { retry(): void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ src: DecisionSource; a: Availability }>({ src, a: { phase: 'checking' } });
  const a = state.src === src ? state.a : { phase: 'checking' as const };
  useEffect(() => {
    let live = true;
    src.available().then(
      (yes) => live && setState({ src, a: { phase: yes ? 'yes' : 'no' } }),
      (e: unknown) => live && setState({ src, a: { phase: 'error', error: errText(e) } }),
    );
    return () => {
      live = false;
    };
  }, [src, attempt]);
  useEffect(() => {
    if (a.phase !== 'no') return;
    const t = setInterval(() => setAttempt((n) => n + 1), RECHECK_MS);
    return () => clearInterval(t);
  }, [a.phase]);
  return { ...a, retry: () => setAttempt((n) => n + 1) };
}
