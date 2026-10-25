// Past proposals, newest end first (G3: the range on endEpoch is what makes desc work on PV13).
// Pages of 100 come from Platform with startAfter; the list reveals 12 at a time.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import type { Proposal, Sourced, Tally } from '../data/types.ts';
import { formatDash, formatDate, formatInt, formatSigned } from '../lib/format.ts';
import { absoluteYes } from '../lib/governance.ts';
import { countNames, partitionByCheck, proposalHref } from '../lib/view.ts';
import { isFailed } from '../verify/checks.ts';
import { FailedNote, FailedProposalsToggle } from '../ui/HiddenToggle.tsx';
import { useReveal } from '../ui/hooks.ts';
import { ProposalTabs } from '../ui/ProposalTabs.tsx';

export function PastPage() {
  const { source, checks } = useApp();
  const [showFailed, setShowFailed] = useState(false);
  const [items, setItems] = useState<Sourced<Proposal>[]>([]);
  const [tallies, setTallies] = useState(new Map<string, Sourced<Tally>>());
  const [next, setNext] = useState<string | undefined>(undefined);
  const [state, setState] = useState<{ loading: boolean; error?: string; done: boolean }>({ loading: true, done: false });
  const gen = useRef(0);
  const inFlight = useRef<number | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      // A first page (no cursor) starts a new generation; results of older generations are dropped.
      const g = cursor ? gen.current : ++gen.current;
      if (cursor && inFlight.current === g) return;
      inFlight.current = g;
      setState((s) => ({ ...s, loading: true }));
      try {
        const page = await source.pastPage(cursor);
        if (g !== gen.current) return;
        setItems((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNext(page.next);
        setState({ loading: false, done: !page.next });
        if (page.items.length) {
          const t = await source.tallies(page.items.map((i) => i.value.govHash));
          if (g === gen.current) setTallies((prev) => new Map([...prev, ...t]));
        }
      } catch (e) {
        if (g === gen.current) setState({ loading: false, done: true, error: e instanceof Error ? e.message : String(e) });
      } finally {
        if (inFlight.current === g) inFlight.current = null;
      }
    },
    [source],
  );

  useEffect(() => {
    setItems([]);
    setTallies(new Map());
    void load();
  }, [load]);

  const checksVersion = useSyncExternalStore(checks.subscribe, checks.getVersion);
  // Proposals that failed verification are hidden until the toggle at the bottom; pending checks stay listed.
  const parts = useMemo(
    () => partitionByCheck(items, (i) => checks.state(i.value)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, checks, checksVersion],
  );
  const rows = showFailed ? [...parts.shown, ...parts.failed] : parts.shown;
  const failed = parts.failed.length;

  const { count, sentinel } = useReveal(rows.length, 12, () => {
    if (next && !state.loading) void load(next);
  });
  const names = useMemo(() => countNames(items.map((i) => i.value)), [items]);
  // Background checks for what has been revealed so far (plus the next screenful), not for every loaded page of 100.
  useEffect(() => checks.ensure(items.slice(0, count + 12).map((i) => i.value)), [checks, items, count]);

  return (
    <section aria-labelledby="past-title" className="list-section">
      <div className="list-head">
        <h1 id="past-title" className="visually-hidden">
          Past proposals
        </h1>
        <ProposalTabs />
        <p className="small muted">Proposals whose payments have ended, most recent first.</p>
      </div>
      {state.error && <p className="error">Platform could not be read: {state.error}</p>}
      {!state.loading && !state.error && items.length === 0 && <p className="empty">No past proposals published yet.</p>}
      {rows.length > 0 && (
        <table className="past">
          <thead>
            <tr>
              <th scope="col">Proposal</th>
              <th scope="col">Ended</th>
              <th scope="col" className="r">
                Amount
              </th>
              <th scope="col" className="r">
                Net yes
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, count).map(({ item: it, check }) => {
              const p = it.value;
              const t = tallies.get(p.govHash);
              const reason = isFailed(check) ? check.reason : null;
              return (
                <tr key={p.govHash} className={reason ? 'row-invalid' : undefined} data-check={check.status}>
                  <th scope="row">
                    <Link to={proposalHref(p, names)}>{p.name}</Link>
                    {reason && <FailedNote reason={reason} />}
                  </th>
                  <td>{formatDate(p.endEpoch)}</td>
                  <td className="r">{formatDash(p.paymentAmount)}</td>
                  <td className="r">{t ? formatSigned(absoluteYes(t.value)) : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div ref={sentinel} className="sentinel" aria-hidden="true" />
      {state.loading && <p className="muted small center">Loading…</p>}
      {state.done && rows.length > 0 && <p className="muted small center">That's all {formatInt(parts.shown.length)} past proposals.</p>}
      {state.done && failed > 0 && <FailedProposalsToggle count={failed} shown={showFailed} onToggle={() => setShowFailed((v) => !v)} />}
    </section>
  );
}
