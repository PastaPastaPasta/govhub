import { useEffect, useRef, useState, type DependencyList } from 'react';
import type { Load } from '../app/context.tsx';

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
