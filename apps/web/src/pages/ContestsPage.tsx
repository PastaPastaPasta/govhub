// /names: contested usernames. Open contests come from one query and lead the page; ended ones (hundreds on mainnet) sit in a
// collapsed section that reads nothing until it is opened, then pages through the names, loading tallies only for rows on screen.
import { useLocation } from 'react-router-dom';
import { useRouteTitle } from '../app/title.ts';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ReadError } from '../ui/ReadError.tsx';
import { useAsync, useReveal } from '../ui/hooks.ts';
import { errText, formatInt } from '../lib/format.ts';
import { contestKey, displayName, normalizeLabel, VOTE_CHANGES, type ContestState, type OpenContest } from '../contests/model.ts';
import { useCommentCounts } from '../ui/useCommentCounts.ts';
import type { ContestSource } from '../contests/source.ts';
import { ContestCard, type StateEntry } from '../contests/ui.tsx';
import { useClockMs, useContestSource } from '../contests/useContests.ts';

const STATE_CONCURRENCY = 4;
const NO_OPEN: OpenContest[] = [];
const sourceIds = new WeakMap<ContestSource, number>();
let nextSourceId = 0;
/** A key that changes with the source object (two profiles can share a network). */
const sourceKey = (src: ContestSource): number => {
  let n = sourceIds.get(src);
  if (n === undefined) sourceIds.set(src, (n = nextSourceId++));
  return n;
};

/** States of these contests, read a few at a time in the given order (cached ones at once). A failed read is 'error'. */
export function useContestStates(src: ContestSource, labels: readonly string[]): ReadonlyMap<string, StateEntry> {
  const [data, setData] = useState<{ src: ContestSource; states: ReadonlyMap<string, StateEntry> }>(() => ({ src, states: new Map() }));
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
  return data.states;
}

const matches = (label: string, s: StateEntry, q: string): boolean => {
  if (!q.trim()) return true;
  const n = normalizeLabel(q);
  return label.includes(n) || (typeof s === 'object' && displayName(s, label).toLowerCase().includes(q.trim().toLowerCase()));
};

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ContestsPage() {
  useRouteTitle('/names');
  const { hash } = useLocation();
  const about = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (hash === '#name-contests-about') {
      about.current!.open = true;
      window.scrollTo({ top: 0 });
    }
  }, [hash]);
  const src = useContestSource();
  const nowMs = useClockMs();
  const [attempt, setAttempt] = useState(0);
  const [q, setQ] = useState('');
  const open = useAsync(() => src.open(), [src, attempt]);
  const all = open.data ?? NO_OPEN;
  // Every open contest's tally is read (there are a few dozen at most): the search also matches a contender's own spelling.
  const states = useContestStates(
    src,
    useMemo(() => all.map((c) => c.label), [all]),
  );
  // a contest whose end passes while the page is open leaves the open list (it shows up among the ended ones)
  const still = useMemo(() => all.filter((c) => c.endsAt > nowMs), [all, nowMs]);
  const openLabels = useMemo(() => new Set(still.map((c) => c.label)), [still]);
  const visible = still.filter((c) => matches(c.label, states.get(c.label), q));
  const counts = useCommentCounts(useMemo(() => still.map((c) => contestKey(c.label)), [still]));
  // Platform takes new contenders for a week from the first one (its mainnet setting, on every network), longer than a testnet vote
  const timing = src.network === 'testnet' ? 'while the vote runs. Voting runs for 90 minutes' : 'in the first week. Voting runs for two weeks';

  return (
    <section aria-labelledby="names-title" className="list-section contests">
      <header className="dh-page-header">
        <h1 className="dh-page-header__title" id="names-title">Name contests</h1>
        <p className="dh-page-header__lede contests-intro">Masternodes decide who gets a contested name. Open contests close soonest first.</p>
        <details ref={about} id="name-contests-about" className="learn dh-disclosure"><summary>How name contests work</summary>
        <div className="contest-rules">
          <section>
            <h2>Which names go to a vote</h2>
            <p>Usernames of 3 to 19 characters that use only letters, hyphens, 0 and 1 after normalization go to a masternode vote when someone registers one. Others can ask for the same name {timing}.</p>
            <p>DPNS groups look-alike spellings into one contest: names become lowercase, <code>o</code> becomes <code>0</code>, and <code>i</code> and <code>l</code> become <code>1</code>. For example, <code>Alice</code> and <code>a11ce</code> share a contest; <code>Moon</code> becomes <code>m00n</code>. Hyphens stay in the name.</p>
          </section>
          <section>
            <h2>Choices and vote weight</h2>
            <p>Vote for a contender, choose <b>Abstain</b>, or choose <b>Lock</b> to award the name to nobody. A regular masternode has weight 1; an evonode has weight 4. Each masternode can change its vote up to {VOTE_CHANGES} times per contest. Its latest vote counts, so leave room to change your mind. Votes are public on Platform.</p>
          </section>
          <section>
            <h2>Sign with your voting key</h2>
            <p>Open a contest and add your masternode’s registered voting-address private key (WIF or hex). Governance finds your masternodes and their ProTxHashes from the key. You can vote without an account or Platform credits. The vote is signed locally in your browser; only the signed vote goes to Platform nodes.</p>
            <p>Without an account, pasted keys stay in this tab’s memory: never saved or sent to a server. Use <b>Forget</b> to clear them; they also clear after 15 minutes without use or when the tab closes. Signed-in voters can use their encrypted masternode keyring.</p>
            <p><strong>Use only the key for <code>votingAddress</code> in <code>protx info</code>. NEVER paste owner, operator (BLS), or collateral keys.</strong></p>
          </section>
          <section>
            <h2>Discussing a contest</h2>
            <p>A masternode voting key cannot post comments. Governance discussions use a separate Platform identity with credits; voting itself needs neither. Contenders can also share their requested name and identity ID on the Dash forum.</p>
          </section>
        </div>
        </details>
        <label className="contests-search dh-field__label">
          <span className="visually-hidden">Find a username</span>
          <input className="dh-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a username" autoComplete="off" spellCheck={false} data-testid="names-search" />
        </label>
      </header>

      <h2 className="dh-section__title">
        Open for voting{open.data && <span className="count">{formatInt(still.length)}</span>}
      </h2>
      <p className="contest-legend small muted" aria-label="Vote bar legend">
        <span><i className="cb-c0" aria-hidden="true" />Leader</span>
        <span><i className="cb-c1" aria-hidden="true" />Challengers</span>
        <span><i className="cb-abstain" aria-hidden="true" />Abstain</span>
        <span><i className="cb-lock" aria-hidden="true" />Lock</span>
      </p>
      {open.loading ? (
        <div className="plist" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="prow prow-skeleton" />
          ))}
        </div>
      ) : open.error ? (
        <ReadError error={open.error} what="Platform" lead="The open contests could not be read" onRetry={() => setAttempt((n) => n + 1)} />
      ) : still.length === 0 ? (
        <p className="empty dh-empty">No usernames are being contested right now.</p>
      ) : visible.length === 0 ? (
        <p className="empty dh-empty" role="status">
          No open contest matches “{q.trim()}”.
        </p>
      ) : (
        <div className="plist" data-testid="open-contests">
          {visible.map((c) => (
            <ContestCard key={c.label} label={c.label} endsAt={c.endsAt} state={states.get(c.label)} nowMs={nowMs} comments={counts.get(contestKey(c.label))} />
          ))}
        </div>
      )}

      <EndedContests src={src} openLabels={open.data ? openLabels : null} query={q} nowMs={nowMs} />
    </section>
  );
}

/**
 * Every contested name that is not open, in name order. Collapsed, and nothing is read until it is opened. With a search, it starts at
 * that name and stops where the names no longer begin with it (the index is in name order, so this costs one page).
 */
function EndedContests({ src, openLabels, query, nowMs }: { src: ContestSource; openLabels: ReadonlySet<string> | null; query: string; nowMs: number }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  // only a settled search reaches Platform (not every keystroke)
  const prefix = useSettled(normalizeLabel(query).replace(/[^a-z01-]/g, ''), 300);
  return (
    <section className="lameduck contests-ended" aria-labelledby={`${id}-title`} data-testid="ended-section">
      <h2 className="lameduck-title" id={`${id}-title`}>
        <button type="button" className="lameduck-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)} data-testid="toggle-ended">
          <span className="lameduck-caret" aria-hidden="true" />
          Ended contests
        </button>
      </h2>
      <p className="small muted">Every username that was contested before, and who got it.</p>
      <div id={id} hidden={!open}>
        {/* a new search or source starts a fresh list: its own paging, reveal count and reads */}
        {open && <EndedList key={`${prefix}\n${sourceKey(src)}`} src={src} prefix={prefix} openLabels={openLabels} nowMs={nowMs} />}
      </div>
    </section>
  );
}

interface Paging {
  labels: string[];
  /** cursor of the next page (also of a failed one, for Retry); null at the end */
  next: string | null;
  loading: boolean;
  error: string | null;
}

function EndedList({ src, prefix, openLabels, nowMs }: { src: ContestSource; prefix: string; openLabels: ReadonlySet<string> | null; nowMs: number }) {
  const [paging, setPaging] = useState<Paging>({ labels: [], next: null, loading: true, error: null });
  // only the latest read may land: an unmount (or React's StrictMode remount) drops what is in flight
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );

  const load = (after: string | null) => {
    const mine = ++run.current;
    setPaging((p) => ({ ...p, loading: true, error: null }));
    src.names(after !== null ? { after } : prefix ? { from: prefix } : {}).then(
      (page) => {
        if (run.current !== mine) return;
        const fit = prefix ? page.labels.filter((l) => l.startsWith(prefix)) : page.labels;
        // past the prefix: nothing further can match
        const done = page.next === null || fit.length < page.labels.length;
        setPaging((p) => ({ labels: after === null ? fit : [...p.labels, ...fit], next: done ? null : page.next, loading: false, error: null }));
      },
      (e: unknown) => run.current === mine && setPaging((p) => ({ ...p, next: after, loading: false, error: errText(e) })),
    );
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(null), []);

  // open contests are listed above; until they are known nothing is hidden here
  const labels = useMemo(() => paging.labels.filter((l) => !openLabels?.has(l)), [paging.labels, openLabels]);
  const { count, sentinel } = useReveal(labels.length, 20, () => {
    if (paging.next && !paging.loading && !paging.error) load(paging.next);
  });
  const revealed = useMemo(() => labels.slice(0, count), [labels, count]);
  const states = useContestStates(src, revealed);
  const counts = useCommentCounts(useMemo(() => revealed.map(contestKey), [revealed]));

  return (
    <>
      {prefix && <p className="small muted">Names that start with “{prefix}”.</p>}
      {revealed.length > 0 && (
        <div className="plist" data-testid="ended-contests">
          {revealed.map((l) => (
            <ContestCard key={l} label={l} endsAt={null} state={states.get(l)} nowMs={nowMs} comments={counts.get(contestKey(l))} />
          ))}
        </div>
      )}
      <div ref={sentinel} className="sentinel" aria-hidden="true" />
      {paging.loading && (
        <p className="muted small center" aria-busy="true">
          <span className="spinner" aria-hidden="true" /> Reading contested names…
        </p>
      )}
      {paging.error && <ReadError error={paging.error} what="Platform" lead="The ended contests could not be read" onRetry={() => load(paging.next)} />}
      {!paging.loading && !paging.error && labels.length === 0 && (
        <p className="empty dh-empty" role="status">
          {prefix ? `No ended contest starts with “${prefix}”.` : 'No contests have ended yet.'}
        </p>
      )}
    </>
  );
}
