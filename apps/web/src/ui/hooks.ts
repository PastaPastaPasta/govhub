import { useCallback, useEffect, useMemo, useRef, useState, type DependencyList } from 'react';
import { useApp, type Load } from '../app/context.tsx';
import type { Proposal } from '../data/types.ts';
import type { ChainReport } from '../verify/chain.ts';
import { runVerification } from '../verify/client.ts';
import type { CollateralVerdict } from '../verify/collateral.ts';

/**
 * Runs `fn` whenever deps change; ignores results from superseded runs, and never returns a previous run's data (not even in the
 * render before the new run's effect starts): a page built from it never shows, or checks, the old data source's documents.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): Load<T> {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useMemo(() => ({}), deps);
  const [state, setState] = useState<{ run: object; load: Load<T> } | null>(null);
  useEffect(() => {
    let live = true;
    fn().then(
      (data) => live && setState({ run, load: { data, loading: false } }),
      (e: unknown) => live && setState({ run, load: { error: e instanceof Error ? e.message : String(e), loading: false } }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);
  return state && state.run === run ? state.load : { loading: true };
}

/**
 * Infinite scroll: reveals `step` more items each time the sentinel is near the viewport, and calls
 * `onExhausted` when everything loaded so far is visible (to fetch the next page). The observer is
 * re-attached after every reveal, so a sentinel that stays in view keeps loading.
 */
export function useReveal(total: number, step = 12, onExhausted?: () => void, initial = step) {
  const [count, setCount] = useState(initial);
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

/**
 * A result of an async run, tagged with the run it belongs to: a result is only ever returned for the run (proposal, source, Re-check
 * nonce...) that produced it, never for a newer one in the render before the newer run's effect has reset the state.
 */
export function useRunResult<T>(run: object): [T | null, (r: T) => void, () => void] {
  const [held, setHeld] = useState<{ run: object; value: T } | null>(null);
  const set = useCallback((value: T) => setHeld({ run, value }), [run]);
  const clear = useCallback(() => setHeld(null), []);
  return [held && held.run === run ? held.value : null, set, clear];
}

/** Runs the collateral check in the verification worker whenever the proposal changes (or `nonce` does: "Re-check"). */
export function useCollateralCheck(p: Proposal | undefined, nonce = 0) {
  const { source } = useApp();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new identity per run
  const run = useMemo(() => ({}), [p, source, nonce]);
  const [verdict, setVerdict, clearVerdict] = useRunResult<CollateralVerdict>(run);
  const [error, setError, clearError] = useRunResult<string>(run);
  const [progress, setProgress] = useState('');
  useEffect(() => {
    if (!p) return;
    let live = true;
    clearVerdict();
    clearError();
    setProgress('');
    runVerification({ kind: 'collateral', proposal: p, dapi: source.dapiDescriptor() }, (m) => live && setProgress(m)).then(
      (r) => live && setVerdict(r.verdict),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [p, source, nonce, setVerdict, setError, clearVerdict, clearError]);
  return { verdict, progress, error };
}

export type CollateralCheck = ReturnType<typeof useCollateralCheck>;

/**
 * Chain facts for the proposal page (threshold, superblock schedule and budget, payments), once the collateral check has placed the
 * collateral in the verified chain. Live DAPI only: recorded data has no header chain.
 */
export function useChainReport(p: Proposal | undefined, verdict: CollateralVerdict | null, nonce = 0) {
  const { source, gov } = useApp();
  // only for a proposal whose content and collateral checked out: payments are matched by its committed address and amount
  const from = verdict?.ok && verdict.chain?.anchored ? verdict.chain.height : null;
  const live = source.dapiDescriptor().kind === 'live';
  // payments to the same address and amount may belong to another proposal: wait for the active list, then add past ones
  const activeReady = !gov.active.loading;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new identity per run
  const run = useMemo(() => ({}), [p, source, from, live, activeReady, nonce]);
  const [report, setReport, clearReport] = useRunResult<ChainReport>(run);
  const [error, setError, clearError] = useRunResult<string>(run);
  const [progress, setProgress] = useState('');
  useEffect(() => {
    if (!p || !live || from === null || !activeReady) return;
    let on = true;
    clearReport();
    clearError();
    void (async () => {
      const { others, complete } = await listedProposals(source, gov.active, p);
      const twins = others.filter((o) => o.govHash !== p.govHash).map(({ govHash, paymentAddress, paymentAmount, startEpoch, endEpoch }) => ({ govHash, paymentAddress, paymentAmount, startEpoch, endEpoch }));
      return runVerification({ kind: 'chain', proposal: p, from, others: twins, othersComplete: complete, dapi: source.dapiDescriptor(), network: source.coreNetwork, now: source.now() }, (m) => on && setProgress(m));
    })().then(
      (r) => on && setReport(r.report),
      (e: Error) => on && setError(e.message),
    );
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reruns when the active list has loaded, not on every refresh of it
  }, [p, source, from, live, activeReady, nonce]);
  const unavailable = !live
    ? "demo data can't be checked against the live chain"
    : verdict && from === null
      ? (!verdict.ok ? 'the collateral check did not pass' : (verdict.anchorError ?? 'the collateral could not be placed in the verified chain'))
      : null;
  return { report, progress, error, unavailable };
}

/**
 * Every listed proposal whose payment window could overlap `p`'s: the active ones and the past ones, newest-ending first, until they end
 * before `p`'s window opens. `complete` is false when a list failed or paging stopped early.
 */
async function listedProposals(source: ReturnType<typeof useApp>['source'], active: ReturnType<typeof useApp>['gov']['active'], p: Proposal) {
  const others: Proposal[] = (active.data ?? []).map((x) => x.value);
  let complete = !active.error;
  try {
    let cursor: string | undefined;
    for (let i = 0; ; i++) {
      const page = await source.pastPage(cursor);
      others.push(...page.items.map((x) => x.value));
      if (!page.next || page.items.some((x) => x.value.endEpoch < p.startEpoch - 3 * 86_400)) break;
      if (i === 20) { complete = false; break; }
      cursor = page.next;
    }
  } catch {
    complete = false;
  }
  return { others, complete };
}

export type ChainCheck = ReturnType<typeof useChainReport>;
