import { useEffect, useRef, useState, type DependencyList } from 'react';
import { useApp, type Load } from '../app/context.tsx';
import type { Proposal } from '../data/types.ts';
import type { ChainReport } from '../verify/chain.ts';
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

/**
 * Chain facts for the proposal page (threshold, superblock schedule and budget, payments), once the collateral check has placed the
 * collateral in the verified chain. Live DAPI only: recorded data has no header chain.
 */
export function useChainReport(p: Proposal | undefined, verdict: CollateralVerdict | null) {
  const { source, gov } = useApp();
  const [report, setReport] = useState<ChainReport | null>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  // only for a proposal whose content and collateral checked out: payments are matched by its committed address and amount
  const from = verdict?.ok && verdict.chain?.anchored ? verdict.chain.height : null;
  const active = gov.active.data;
  const live = source.dapiDescriptor().kind === 'live';
  useEffect(() => {
    if (!p || !live || from === null) return;
    let on = true;
    setReport(null);
    setError(null);
    const others = (active ?? []).map((x) => x.value).filter((o) => o.govHash !== p.govHash).map(({ govHash, paymentAddress, paymentAmount, startEpoch, endEpoch }) => ({ govHash, paymentAddress, paymentAmount, startEpoch, endEpoch }));
    runVerification({ kind: 'chain', proposal: p, from, others, dapi: source.dapiDescriptor(), network: source.coreNetwork, now: source.now() }, (m) => on && setProgress(m)).then(
      (r) => on && setReport(r.report),
      (e: Error) => on && setError(e.message),
    );
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the active list only refines payment ambiguity; not a reason to rerun
  }, [p, source, from, live]);
  const unavailable = !live
    ? 'needs live DAPI nodes (recorded data has no header chain)'
    : verdict && from === null
      ? (!verdict.ok ? 'the collateral check did not pass' : (verdict.anchorError ?? 'the collateral could not be placed in the verified chain'))
      : null;
  return { report, progress, error, unavailable };
}

export type ChainCheck = ReturnType<typeof useChainReport>;
