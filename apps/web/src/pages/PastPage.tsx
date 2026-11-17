// Past proposals, newest end first (G3: the range on endEpoch is what makes desc work on PV13).
// Pages of 100 come from Platform, keyset-paged on endEpoch (repo.ts pastPage); the list reveals 12 at a time.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import type { Proposal, Sourced, Tally } from '../data/types.ts';
import { errText, formatDash, formatDate, formatInt, formatSigned } from '../lib/format.ts';
import { absoluteYes } from '../lib/governance.ts';
import { countNames, partitionByCheck, proposalHref } from '../lib/view.ts';
import { isFailed } from '../verify/checks.ts';
import { FailedNote, FailedProposalsToggle } from '../ui/HiddenToggle.tsx';
import { useReveal } from '../ui/hooks.ts';
import { NoMatches, ResultCount, SearchField, useQueryState } from '../ui/ListControls.tsx';
import { ProposalTabs } from '../ui/ProposalTabs.tsx';
import { comparePast, matches, nextPastSort, pastNeedsAll, proposalFields, readPast, writePast, type PastSort } from '../lib/listQuery.ts';

export function PastPage() {
  const { source, checks } = useApp();
  const [showFailed, setShowFailed] = useState(false);
  const [items, setItems] = useState<Sourced<Proposal>[]>([]);
  const [tallies, setTallies] = useState(new Map<string, Sourced<Tally>>());
  const [next, setNext] = useState<string | undefined>(undefined);
  const [state, setState] = useState<{ loading: boolean; error?: string; done: boolean }>({ loading: true, done: false });
  /** A page's tallies could not be read (its proposals did load): kept apart, so a later page's load does not hide it. */
  const [tallyError, setTallyError] = useState<string | null>(null);
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
        // not awaited: the next page (reading every page for a search or another order) never waits for this one's tallies
        if (page.items.length)
          source.tallies(page.items.map((i) => i.value.govHash)).then(
            (t) => g === gen.current && setTallies((prev) => new Map([...prev, ...t])),
            (e) => g === gen.current && setTallyError(errText(e)),
          );
      } catch (e) {
        if (g === gen.current) setState({ loading: false, done: true, error: errText(e) });
      } finally {
        if (inFlight.current === g) inFlight.current = null;
      }
    },
    [source],
  );

  useEffect(() => {
    setItems([]);
    setTallies(new Map());
    setTallyError(null);
    void load();
  }, [load]);

  const retry = () => {
    if (state.error) void load(items.length && next ? next : undefined);
    if (!tallyError) return;
    setTallyError(null);
    const missing = items.map((i) => i.value.govHash).filter((h) => !tallies.has(h));
    const g = gen.current;
    if (missing.length)
      source.tallies(missing).then(
        (t) => g === gen.current && setTallies((prev) => new Map([...prev, ...t])),
        (e) => g === gen.current && setTallyError(errText(e)),
      );
  };

  const [query, setQuery] = useQueryState(readPast, writePast);
  const needsAll = pastNeedsAll(query);
  // A search or another order needs every past proposal, not just the pages read so far: read the rest, page by page.
  useEffect(() => {
    if (needsAll && next && !state.loading && !state.error) void load(next);
  }, [needsAll, next, state.loading, state.error, load]);
  const ordered = useMemo(() => {
    if (!needsAll) return items;
    const found = items.filter((i) => matches(query.q, proposalFields(i.value)));
    const yes = (p: Proposal) => {
      const t = tallies.get(p.govHash);
      return t ? absoluteYes(t.value) : null;
    };
    const cmp = comparePast(query.sort, query.dir, yes);
    return found.sort((a, b) => cmp(a.value, b.value));
  }, [items, tallies, query, needsAll]);

  const checksVersion = useSyncExternalStore(checks.subscribe, checks.getVersion);
  // Proposals that failed verification are hidden until the toggle at the bottom; pending checks stay listed.
  const parts = useMemo(
    () => partitionByCheck(ordered, (i) => checks.state(i.value)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ordered, checks, checksVersion],
  );
  const failedAll = useMemo(
    () => items.filter((i) => isFailed(checks.state(i.value))).length,
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
  useEffect(() => checks.ensure(ordered.slice(0, count + 12).map((i) => i.value)), [checks, ordered, count]);
  const searching = !!query.q.trim();
  const clear = () => setQuery({ q: '' });
  const loadingAll = needsAll && !state.done;
  const header = (col: PastSort, text: string, className?: string) => {
    const on = query.sort === col;
    return (
      <th scope="col" className={className} aria-sort={on ? (query.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
        <button type="button" className={`sort-head${on ? ' on' : ''}`} onClick={() => setQuery(nextPastSort(query, col))} data-testid={`sort-${col}`}>
          {text}
          <span className="sort-arrow" aria-hidden="true">
            {on ? (query.dir === 'asc' ? '↑' : '↓') : '↕'}
          </span>
        </button>
      </th>
    );
  };

  return (
    <section aria-labelledby="past-title" className="list-section">
      <div className="list-head">
        <h1 id="past-title" className="visually-hidden">
          Past proposals
        </h1>
        <ProposalTabs />
        <p className="small muted">Proposals whose payments have ended. Sort by any column heading.</p>
      </div>
      {(items.length > 0 || searching) && (
        <div className="list-tools" role="search" aria-label="Past proposals">
          <SearchField label="Search past proposals" placeholder="Search by name, URL or address" value={query.q} onChange={(q, replace) => setQuery({ q }, { replace })} />
          {searching && !loadingAll && !state.error && <ResultCount shown={rows.length} total={showFailed ? items.length : items.length - failedAll} what="past proposals" onClear={rows.length ? clear : undefined} />}
        </div>
      )}
      {(state.error || tallyError) && (
        <p className="error" role="alert">
          {state.error ? 'Past proposals' : 'Their votes'} could not be loaded right now ({state.error ?? tallyError}).{' '}
          <button type="button" className="btn btn-s" onClick={retry} data-testid="past-retry">
            Try again
          </button>
        </p>
      )}
      {!state.loading && !state.error && items.length === 0 && (
        <p className="empty">
          No past proposals published yet. Proposals move here once their last payment date has passed. <Link to="/">See the active ones</Link>
        </p>
      )}
      {rows.length > 0 && (
        <table className="past">
          <thead>
            <tr>
              {header('name', 'Proposal')}
              {header('ended', 'Ended')}
              {header('amount', 'Amount', 'r')}
              {header('yes', 'Net yes', 'r')}
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
      {searching && !loadingAll && !state.error && items.length > 0 && rows.length === 0 && <NoMatches query={query.q} onClear={clear} />}
      {state.loading && (
        <p className="muted small center" role="status">
          {loadingAll && items.length ? `Reading every past proposal… ${formatInt(items.length)} so far` : 'Loading…'}
        </p>
      )}
      {state.done && rows.length > 0 && !searching && <p className="muted small center">That's all {formatInt(parts.shown.length)} past proposals.</p>}
      {state.done && failed > 0 && <FailedProposalsToggle count={failed} shown={showFailed} onToggle={() => setShowFailed((v) => !v)} />}
    </section>
  );
}
