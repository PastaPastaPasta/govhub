// Past proposals, newest end first (G3: the range on endEpoch is what makes desc work on PV13).
// Pages of 100 come from Platform with startAfter; the list reveals 12 at a time.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import type { Proposal, Sourced, Tally } from '../data/types.ts';
import { formatDash, formatDate, formatInt, formatSigned } from '../lib/format.ts';
import { absoluteYes } from '../lib/governance.ts';
import { countNames, proposalHref } from '../lib/view.ts';
import { useReveal } from '../ui/hooks.ts';
import { ProvMark } from '../ui/Provenance.tsx';

export function PastPage() {
  const { source } = useApp();
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

  const { count, sentinel } = useReveal(items.length, 12, () => {
    if (next && !state.loading) void load(next);
  });
  const names = useMemo(() => countNames(items.map((i) => i.value)), [items]);

  return (
    <section aria-labelledby="past-title" className="list-section">
      <div className="list-head">
        <h1 id="past-title">Past proposals</h1>
        <p className="muted">Proposals whose payment window has ended, most recent first.</p>
      </div>
      {state.error && <p className="error">Platform could not be read: {state.error}</p>}
      {!state.loading && !state.error && items.length === 0 && <p className="empty">No past proposals published yet.</p>}
      {items.length > 0 && (
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
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, count).map((it) => {
              const p = it.value;
              const t = tallies.get(p.govHash);
              return (
                <tr key={p.govHash}>
                  <th scope="row">
                    <Link to={proposalHref(p, names)}>{p.name}</Link>
                  </th>
                  <td>{formatDate(p.endEpoch)}</td>
                  <td className="r">{formatDash(p.paymentAmount)}</td>
                  <td className="r">{t ? formatSigned(absoluteYes(t.value)) : '–'}</td>
                  <td>
                    <ProvMark prov={it.prov} />
                    {t && <ProvMark prov={t.prov} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div ref={sentinel} className="sentinel" aria-hidden="true" />
      {state.loading && <p className="muted small center">Loading…</p>}
      {state.done && items.length > 0 && <p className="muted small center">{formatInt(items.length)} past proposals, that is all of them.</p>}
    </section>
  );
}
