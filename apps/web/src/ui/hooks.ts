import { useEffect, useRef, useState, type DependencyList } from 'react';
import { useApp, type Load } from '../app/context.tsx';
import type { Proposal } from '../data/types.ts';
import { runVerification } from '../verify/client.ts';
import type { CollateralVerdict } from '../verify/collateral.ts';

/** Runs `fn` whenever deps change; ignores results from superseded runs. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): Load<T> {
  const [state, setState] = useState<Load<T>>({ loading: true });
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    fn().then(
      (data) => live && setState({ data, loading: false }),
      (e: unknown) => live && setState({ error: e instanceof Error ? e.message : String(e), loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/**
 * Infinite scroll: reveals `step` more items each time the sentinel is near the viewport, and calls
 * `onExhausted` when everything loaded so far is visible (to fetch the next page). The observer is
 * re-attached after every reveal, so a sentinel that stays in view keeps loading.
 */
export function useReveal(total: number, step = 12, onExhausted?: () => void) {
  const [count, setCount] = useState(step);
  const ref = useRef<HTMLDivElement | null>(null);
  const exhausted = useRef(onExhausted);
  exhausted.current = onExhausted;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (count >= total) exhausted.current?.();
        else setCount(count + step);
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [total, step, count]);
  return { count: Math.min(count, total), sentinel: ref, more: count < total };
}

/** Runs the collateral check in the verification worker whenever the proposal changes. */
export function useCollateralCheck(p: Proposal | undefined) {
  const { source } = useApp();
  const [verdict, setVerdict] = useState<CollateralVerdict | null>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!p) return;
    let live = true;
    setVerdict(null);
    setError(null);
    runVerification({ kind: 'collateral', proposal: p, dapi: source.dapiDescriptor() }, (m) => live && setProgress(m)).then(
      (r) => live && setVerdict(r.verdict),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [p, source]);
  return { verdict, progress, error };
}

export type CollateralCheck = ReturnType<typeof useCollateralCheck>;
