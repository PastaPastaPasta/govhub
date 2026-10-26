// /names: contested usernames. Open contests come from one query and lead the page; ended ones (hundreds on mainnet) sit in a
// collapsed section that reads nothing until it is opened, then pages through the names, loading tallies only for rows on screen.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ReadError } from '../ui/ReadError.tsx';
import { useAsync, useReveal } from '../ui/hooks.ts';
import { errText, formatInt } from '../lib/format.ts';
import { displayName, normalizeLabel, type ContestState } from '../contests/model.ts';
import type { ContestSource } from '../contests/source.ts';
import { ContestCard } from '../contests/ui.tsx';
import { useClockMs, useContestSource, useContestsShown } from '../contests/useContests.ts';
import { NotShown } from './ContestPage.tsx';

const STATE_CONCURRENCY = 4;

/** States of these contests, read a few at a time in the given order (cached ones at once). A failed read is 'error'. */
export function useContestStates(src: ContestSource, labels: readonly string[]): ReadonlyMap<string, ContestState | 'error'> {
  const [data, setData] = useState<{ src: ContestSource; states: ReadonlyMap<string, ContestState | 'error'> }>(() => ({ src, states: new Map() }));
  if (data.src !== src) setData({ src, states: new Map() });
  // one runner per source: a read that lands after the labels changed still counts (it is never asked twice)
  const runner = useRef<{ src: ContestSource; asked: Set<string>; queue: string[]; running: number } | null>(null);
  if (runner.current?.src !== src) runner.current = { src, asked: new Set(), queue: [], running: 0 };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const key = labels.join('\n');
  useEffect(() => {
    const r = runner.current!;
    const put = (label: string, v: ContestState | 'error') => {
      if (mounted.current && runner.current === r) setData((d) => (d.src === r.src ? { src: d.src, states: new Map(d.states).set(label, v) } : d));
    };
    const pump = () => {
      while (r.running < STATE_CONCURRENCY && r.queue.length) {
        const label = r.queue.shift()!;
        r.running++;
        r.src
          .state(label)
          .then(
            (s) => put(label, s),
            () => put(label, 'error'),
          )
          .finally(() => {
            r.running--;
            if (runner.current === r) pump();
          });
      }
    };
    // labels no longer wanted (a new search) are dropped from the queue, and asked again if they come back
    const wanted = new Set(labels);
    for (const l of r.queue) if (!wanted.has(l)) r.asked.delete(l);
    r.queue = r.queue.filter((l) => wanted.has(l));
    for (const l of labels) {
      if (r.asked.has(l)) continue;
      r.asked.add(l);
      const hit = r.src.peek(l);
      if (hit) put(l, hit);
      else r.queue.push(l);
    }
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, key]);
  return data.src === src ? data.states : EMPTY;
}

const EMPTY: ReadonlyMap<string, ContestState | 'error'> = new Map();

const matches = (label: string, s: ContestState | 'error' | undefined, q: string): boolean => {
  if (!q) return true;
  const n = normalizeLabel(q);
  return label.includes(n) || (typeof s === 'object' && displayName(s, label).toLowerCase().includes(q.trim().toLowerCase()));
};

export function ContestsPage() {
  const shown = useContestsShown();
  const src = useContestSource();
  const nowMs = useClockMs();
  const [attempt, setAttempt] = useState(0);
  const [q, setQ] = useState('');
  const open = useAsync(() => src.open(), [src, attempt]);
  const all = open.data ?? [];
  const states = useContestStates(
    src,
    useMemo(() => all.map((c) => c.label), [all]),
  );
  // a contest whose end passes while the page is open leaves the open list (it shows up among the ended ones)
  const still = all.filter((c) => c.endsAt > nowMs);
  const visible = still.filter((c) => matches(c.label, states.get(c.label), q));
  const openLabels = useMemo(() => new Set(still.map((c) => c.label)), [still]);
  if (!shown) return <NotShown />;
  const duration = src.network === 'testnet' ? '90 minutes' : 'two weeks';

  return (
    <section aria-labelledby="names-title" className="list-section contests">
      <div className="list-head">
        <h1 id="names-title">Usernames</h1>
        <p className="muted contests-intro">
          When more than one identity asks for the same Dash username, or a name could pass for a well-known one, masternodes vote on who gets it. Voting runs for {duration}.
        </p>
        <label className="contests-search">
          <span className="visually-hidden">Find a username</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a username" autoComplete="off" spellCheck={false} data-testid="names-search" />
        </label>
      </div>

      <h2 className="contests-h2">
        Open for voting{open.data && <span className="count">{formatInt(still.length)}</span>}
      </h2>
      {open.loading ? (
        <div className="plist" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="prow prow-skeleton" />
          ))}
        </div>
      ) : open.error ? (
        <ReadError error={open.error} what="Platform" lead="The open contests could not be read" onRetry={() => setAttempt((n) => n + 1)} />
      ) : still.length === 0 ? (
        <p className="empty">No usernames are being contested right now.</p>
      ) : visible.length === 0 ? (
        <p className="empty">No open contest matches “{q.trim()}”.</p>
      ) : (
        <div className="plist" data-testid="open-contests">
          {visible.map((c) => {
            const s = states.get(c.label);
            return <ContestCard key={c.label} label={c.label} endsAt={c.endsAt} state={typeof s === 'object' ? s : undefined} failed={s === 'error'} nowMs={nowMs} />;
          })}
        </div>
      )}

      <EndedContests src={src} openLabels={open.data ? openLabels : null} query={q} nowMs={nowMs} />
    </section>
  );
}

interface Paging {
  labels: string[];
  next: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Every contested name that is not open, in name order. Collapsed, and nothing is read until it is opened. With a search, it starts at
 * that name and stops where the names no longer begin with it (the index is in name order, so this costs one page).
 */
function EndedContests({ src, openLabels, query, nowMs }: { src: ContestSource; openLabels: ReadonlySet<string> | null; query: string; nowMs: number }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const prefix = normalizeLabel(query).replace(/[^a-z01-]/g, '');
  const [paging, setPaging] = useState<Paging>({ labels: [], next: null, loading: false, error: null });
  const run = useRef(0);

  const load = useCallback(
    (after: string | null, reset: boolean) => {
      const mine = ++run.current;
      setPaging((p) => ({ ...(reset ? { labels: [], next: null } : p), loading: true, error: null }));
      src.names(after !== null ? { after } : prefix ? { from: prefix } : {}).then(
        (page) => {
          if (run.current !== mine) return;
          const fit = prefix ? page.labels.filter((l) => l.startsWith(prefix)) : page.labels;
          // past the prefix: nothing further can match
          const done = page.next === null || (prefix !== '' && fit.length < page.labels.length);
          setPaging((p) => ({ labels: [...(reset ? [] : p.labels), ...fit], next: done ? null : page.next, loading: false, error: null }));
        },
        (e: unknown) => run.current === mine && setPaging((p) => ({ ...p, loading: false, error: errText(e) })),
      );
    },
    [src, prefix],
  );

  useEffect(() => {
    if (open) load(null, true);
    else run.current++;
  }, [open, load]);

  // open contests are listed above; until they are known nothing is hidden here
  const labels = useMemo(() => paging.labels.filter((l) => !openLabels?.has(l)), [paging.labels, openLabels]);
  const { count, sentinel } = useReveal(labels.length, 20, () => {
    if (open && paging.next && !paging.loading && !paging.error) load(paging.next, false);
  });
  const revealed = useMemo(() => labels.slice(0, count), [labels, count]);
  const states = useContestStates(src, open ? revealed : []);

  return (
    <section className="lameduck contests-ended" aria-labelledby={`${id}-title`} data-testid="ended-section">
      <h2 className="lameduck-title" id={`${id}-title`}>
        <button type="button" className="lameduck-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)} data-testid="toggle-ended">
          <span className="lameduck-caret" aria-hidden="true" />
          Ended contests
        </button>
      </h2>
      <p className="small muted">Every username that was contested before, and who got it.{prefix && open ? ` Showing names that start with “${query.trim()}”.` : ''}</p>
      <div id={id} hidden={!open}>
        {open && (
          <>
            {revealed.length > 0 && (
              <div className="plist" data-testid="ended-contests">
                {revealed.map((l) => {
                  const s = states.get(l);
                  return <ContestCard key={l} label={l} endsAt={null} state={typeof s === 'object' ? s : undefined} failed={s === 'error'} nowMs={nowMs} />;
                })}
              </div>
            )}
            <div ref={sentinel} className="sentinel" aria-hidden="true" />
            {paging.loading && (
              <p className="muted small center" aria-busy="true">
                <span className="spinner" aria-hidden="true" /> Reading contested names…
              </p>
            )}
            {paging.error && <ReadError error={paging.error} what="Platform" lead="The ended contests could not be read" onRetry={() => load(labels.length ? (paging.labels.at(-1) ?? null) : null, labels.length === 0)} />}
            {!paging.loading && !paging.error && labels.length === 0 && <p className="empty">{prefix ? `No ended contest starts with “${query.trim()}”.` : 'No contests have ended yet.'}</p>}
          </>
        )}
      </div>
    </section>
  );
}
