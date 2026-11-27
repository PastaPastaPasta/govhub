// /polls: masternode polls (Platform's decision proposals). Open polls come from two queries (yes/no polls by end date, and the open
// contests of multiple choice polls) and are all read; ended ones are paged newest first from both kinds as the list scrolls, with
// tallies read only for rows on screen. "Mine" lists the polls the signed-in identity asked. On a network without masternode polls
// yet (before protocol version 15) the page says so calmly, and keeps checking.
import { mapLimit } from '@govhub/forum';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useForum } from '../app/forum.tsx';
import { useAuth } from '../auth/context.tsx';
import { useClockMs } from '../contests/useContests.ts';
import type { DecisionSource } from '../decisions/source.ts';
import { pollDiscussionKey, type Poll, type PollKind } from '../decisions/model.ts';
import { PollCard, PollsNotYet, type PollStateEntry } from '../decisions/ui.tsx';
import { usePollsAvailable, useDecisionSource } from '../decisions/useDecisions.ts';
import { errText, formatInt } from '../lib/format.ts';
import { ReadError } from '../ui/ReadError.tsx';
import { useAsync, useReveal } from '../ui/hooks.ts';
import { useCommentCounts } from '../ui/useCommentCounts.ts';

const STATE_CONCURRENCY = 4;
/** How far back the open list looks for multiple choice polls still waiting for their first choice. */
const WAITING_LOOKBACK_MS = 14 * 86_400_000;
/** A multiple choice poll still waiting for its first choice: open, not ended. */
const waitingForChoices = (p: Poll, s: PollStateEntry): boolean => p.kind === 'mc' && !!s && s !== 'error' && 'choices' in s && !s.result && s.choices.length === 0;
const STEP = 20;
type Show = 'open' | 'ended' | 'mine';
const sourceIds = new WeakMap<DecisionSource, number>();
let nextSourceId = 0;
const sourceKey = (src: DecisionSource): number => {
  let n = sourceIds.get(src);
  if (n === undefined) sourceIds.set(src, (n = nextSourceId++));
  return n;
};
const SHOWS: ReadonlyArray<{ id: Show; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'ended', label: 'Ended' },
  { id: 'mine', label: 'Mine' },
];

/** States of these polls, read a few at a time in the given order. A failed read is 'error'; null: Platform has none. */
function usePollStates(src: DecisionSource, polls: readonly Poll[]): ReadonlyMap<string, PollStateEntry> {
  const [data, setData] = useState<{ src: DecisionSource; states: ReadonlyMap<string, PollStateEntry> }>(() => ({ src, states: new Map() }));
  if (data.src !== src) setData({ src, states: new Map() });
  const runner = useRef<{ src: DecisionSource; asked: Set<string>; queue: Poll[]; running: number } | null>(null);
  if (runner.current?.src !== src) runner.current = { src, asked: new Set(), queue: [], running: 0 };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const key = polls.map((p) => p.id).join(',');
  useEffect(() => {
    const r = runner.current!;
    const put = (id: string, v: PollStateEntry) => {
      if (mounted.current && runner.current === r) setData((d) => (d.src === r.src ? { src: d.src, states: new Map(d.states).set(id, v) } : d));
    };
    const pump = () => {
      while (r.running < STATE_CONCURRENCY && r.queue.length) {
        const p = r.queue.shift()!;
        r.running++;
        (p.kind === 'yn' ? r.src.yesNoState(p.id) : r.src.choiceState(p.id))
          .then(
            (s) => put(p.id, s),
            () => put(p.id, 'error'),
          )
          .finally(() => {
            r.running--;
            if (runner.current === r) pump();
          });
      }
    };
    for (const p of polls) {
      if (r.asked.has(p.id)) continue;
      r.asked.add(p.id);
      r.queue.push(p);
    }
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, key]);
  return data.states;
}

export function PollsPage() {
  const src = useDecisionSource();
  const avail = usePollsAvailable(src);
  return (
    <section aria-labelledby="polls-title" className="list-section contests polls">
      <div className="list-head">
        <h1 id="polls-title">Masternode polls</h1>
        <p className="muted contests-intro">
          Questions anyone can put to the masternodes on Dash Platform: a yes or no, or a choice among answers. Masternodes vote with their voting keys, and an evonode’s vote counts 4 times. A result is a signal: nothing on the network acts on it.
        </p>
        {avail.phase === 'yes' && (
          <Link className="btn" to="/polls/new" data-testid="polls-new">
            New poll
          </Link>
        )}
      </div>
      {avail.phase === 'checking' ? (
        <p className="muted center pad" aria-busy="true">
          <span className="spinner" aria-hidden="true" /> Checking Platform for masternode polls…
        </p>
      ) : avail.phase === 'error' ? (
        <ReadError error={avail.error} what="Platform" lead="Platform could not be asked about masternode polls" onRetry={avail.retry} />
      ) : avail.phase === 'no' ? (
        <PollsNotYet network={src.network} />
      ) : (
        <PollLists src={src} />
      )}
    </section>
  );
}

function PollLists({ src }: { src: DecisionSource }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get('show');
  const show: Show = raw === 'ended' || raw === 'mine' ? raw : 'open';
  const nowMs = useClockMs();
  const power = useAsync(() => src.totalPower().catch(() => null), [src]);
  const totalPower = power.data ?? null;
  const pick = (s: Show) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (s === 'open') n.delete('show');
        else n.set('show', s);
        return n;
      },
      { replace: true },
    );
  return (
    <>
      <fieldset className="seg polls-seg" data-testid="polls-filter">
        <legend className="visually-hidden">Show</legend>
        {SHOWS.map((s) => (
          <label key={s.id} className={show === s.id ? 'on' : undefined}>
            <input type="radio" name="polls-show" checked={show === s.id} onChange={() => pick(s.id)} />
            {s.label}
          </label>
        ))}
      </fieldset>
      {/* a new source (profile, data mode) starts every list afresh */}
      {show === 'open' ? (
        <OpenList key={sourceKey(src)} src={src} nowMs={nowMs} totalPower={totalPower} />
      ) : show === 'ended' ? (
        <EndedList key={sourceKey(src)} src={src} nowMs={nowMs} totalPower={totalPower} />
      ) : (
        <MineList src={src} nowMs={nowMs} totalPower={totalPower} />
      )}
    </>
  );
}

/** The cards of a list, revealed as it scrolls (no pages): tallies and comment counts only for the cards on screen. */
function Cards({ polls, src, endsAt, nowMs, totalPower, onEnd, hide, testId }: { polls: readonly Poll[]; src: DecisionSource; endsAt: ReadonlyMap<string, number>; nowMs: number; totalPower: number | null; onEnd?: () => void; hide?: (p: Poll, s: PollStateEntry) => boolean; testId: string }) {
  const { count, sentinel } = useReveal(polls.length, STEP, onEnd);
  const revealed = useMemo(() => polls.slice(0, count), [polls, count]);
  const states = usePollStates(src, revealed);
  const counts = useCommentCounts(useMemo(() => revealed.map((p) => pollDiscussionKey(p.id)), [revealed]));
  return (
    <>
      {revealed.length > 0 && (
        <div className="plist" data-testid={testId}>
          {revealed.filter((p) => !hide?.(p, states.get(p.id))).map((p) => (
            <PollCard key={p.id} poll={p} state={states.get(p.id)} endsAt={p.kind === 'yn' ? p.endDate : (endsAt.get(p.id) ?? null)} nowMs={nowMs} totalPower={totalPower} comments={counts.get(pollDiscussionKey(p.id))} />
          ))}
        </div>
      )}
      <div ref={sentinel} className="sentinel" aria-hidden="true" />
    </>
  );
}

const Skeleton = () => (
  <div className="plist" aria-busy="true">
    {Array.from({ length: 3 }, (_, i) => (
      <div key={i} className="prow prow-skeleton" />
    ))}
  </div>
);

function OpenList({ src, nowMs, totalPower }: { src: DecisionSource; nowMs: number; totalPower: number | null }) {
  const [attempt, setAttempt] = useState(0);
  const open = useAsync(async () => {
    const [yn, ends, recent] = await Promise.all([src.openYesNo(), src.openChoices(), src.page('mc')]);
    const mc: Poll[] = [];
    await mapLimit([...ends.keys()], STATE_CONCURRENCY, async (id) => {
      const p = await src.get(id);
      if (p?.kind === 'mc') mc.push(p);
    });
    // a recent multiple choice poll with no choice yet has no vote to list, but can still take its first choice
    const since = Date.now() - WAITING_LOOKBACK_MS;
    await mapLimit(
      recent.polls.filter((p) => p.createdAt >= since && !ends.has(p.id)),
      STATE_CONCURRENCY,
      async (p) => {
        const s = await src.choiceState(p.id).catch(() => null);
        if (s && !s.result && s.choices.length === 0) mc.push(p);
      },
    );
    return { polls: [...yn, ...mc], ends };
  }, [src, attempt]);
  const polls = useMemo(() => {
    const d = open.data;
    if (!d) return [];
    const end = (p: Poll) => (p.kind === 'yn' ? p.endDate : (d.ends.get(p.id) ?? Infinity));
    // a poll whose end passes while the page is open moves to the ended list
    return d.polls.filter((p) => end(p) > nowMs).sort((a, b) => end(a) - end(b) || a.id.localeCompare(b.id));
  }, [open.data, nowMs]);
  if (open.loading) return <Skeleton />;
  if (open.error) return <ReadError error={open.error} what="Platform" lead="The open polls could not be read" onRetry={() => setAttempt((n) => n + 1)} />;
  return (
    <>
      <h2 className="contests-h2">
        Open for voting<span className="count">{formatInt(polls.length)}</span>
      </h2>
      {polls.length === 0 ? (
        <p className="empty">
          No masternode poll is open right now. <Link to="/polls/new">Ask one</Link>
        </p>
      ) : (
        <Cards polls={polls} src={src} endsAt={open.data!.ends} nowMs={nowMs} totalPower={totalPower} testId="open-polls" />
      )}
    </>
  );
}

interface Stream {
  items: Poll[];
  /** cursor of the next page; null at the end; undefined before the first page */
  next: string | null | undefined;
}
const NO_ENDS: ReadonlyMap<string, number> = new Map();

/**
 * Both kinds' polls newest first, as one list: each kind is its own paged stream, and a poll is shown only once no unread page of the
 * other kind could hold a newer one.
 */
function EndedList({ src, nowMs, totalPower }: { src: DecisionSource; nowMs: number; totalPower: number | null }) {
  const [streams, setStreams] = useState<Record<PollKind, Stream>>({ yn: { items: [], next: undefined }, mc: { items: [], next: undefined } });
  const [busy, setBusy] = useState<Record<PollKind, boolean>>({ yn: false, mc: false });
  const [error, setError] = useState<string | null>(null);
  const openChoices = useAsync(() => src.openChoices(), [src]);
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );
  const load = (kind: PollKind, after: string | undefined) => {
    const mine = run.current;
    setBusy((b) => ({ ...b, [kind]: true }));
    setError(null);
    src.page(kind, after).then(
      (page) => {
        if (run.current !== mine) return;
        setStreams((s) => ({ ...s, [kind]: { items: [...s[kind].items, ...page.polls], next: page.next } }));
        setBusy((b) => ({ ...b, [kind]: false }));
      },
      (e: unknown) => {
        if (run.current !== mine) return;
        setBusy((b) => ({ ...b, [kind]: false }));
        setError(errText(e));
      },
    );
  };
  const unread = (k: PollKind) => streams[k].next !== null;
  // the newest poll a stream with pages left could still hold is no newer than its last one read
  const reach = (k: PollKind) => (streams[k].next === undefined ? Infinity : (streams[k].items.at(-1)?.createdAt ?? Infinity));
  const frontier = Math.max(...(['yn', 'mc'] as const).filter(unread).map(reach), -Infinity);
  const ends = openChoices.data ?? NO_ENDS;
  const polls = useMemo(
    () =>
      [...streams.yn.items, ...streams.mc.items]
        .filter((p) => p.createdAt >= frontier)
        // ended: a yes/no poll past its end date; a multiple choice poll whose vote is not open (known once the open ones are read)
        .filter((p) => (p.kind === 'yn' ? p.endDate <= nowMs : openChoices.data !== undefined && !ends.has(p.id)))
        .sort((a, b) => b.createdAt - a.createdAt),
    [streams, frontier, nowMs, openChoices.data, ends],
  );
  const loading = busy.yn || busy.mc || openChoices.loading;
  const exhausted = !unread('yn') && !unread('mc');
  // how many polls the list wants: it grows as the list scrolls to its end, and pages are read until it has them (a page whose
  // polls are all still open adds nothing to show, so reading goes on) or there are none left
  const [target, setTarget] = useState(STEP);
  useEffect(() => {
    if (loading || error || exhausted || polls.length >= target) return;
    for (const k of ['yn', 'mc'] as const) if (unread(k) && reach(k) >= frontier) load(k, streams[k].next ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, error, exhausted, polls.length, target, streams, frontier]);

  return (
    <>
      <h2 className="contests-h2">Ended</h2>
      {polls.length > 0 && <Cards polls={polls} src={src} endsAt={ends} nowMs={nowMs} totalPower={totalPower} onEnd={() => setTarget(polls.length + STEP)} hide={waitingForChoices} testId="ended-polls" />}
      {loading && (
        <p className="muted small center" aria-busy="true">
          <span className="spinner" aria-hidden="true" /> Reading polls…
        </p>
      )}
      {error && <ReadError error={error} what="Platform" lead="The ended polls could not be read" onRetry={() => setError(null)} />}
      {!loading && !error && exhausted && polls.length === 0 && (
        <p className="empty" role="status">
          No masternode poll has ended yet.
        </p>
      )}
    </>
  );
}

function MineList({ src, nowMs, totalPower }: { src: DecisionSource; nowMs: number; totalPower: number | null }) {
  const { session } = useForum();
  const { openSheet } = useAuth();
  const me = session?.identityId ?? null;
  const [attempt, setAttempt] = useState(0);
  const mine = useAsync(() => (me ? Promise.all([src.byOwner(me), src.openChoices()]) : Promise.resolve(null)), [src, me, attempt]);
  if (!me)
    return (
      <div className="vempty" data-testid="polls-mine-signin">
        <p>Sign in to see the polls you asked.</p>
        <button type="button" className="btn" onClick={() => openSheet('choose')}>
          Sign in
        </button>
      </div>
    );
  if (mine.loading) return <Skeleton />;
  if (mine.error || !mine.data) return <ReadError error={mine.error ?? 'no answer'} what="Platform" lead="Your polls could not be read" onRetry={() => setAttempt((n) => n + 1)} />;
  const [polls, ends] = mine.data;
  return (
    <>
      <h2 className="contests-h2">
        Asked by you<span className="count">{formatInt(polls.length)}</span>
      </h2>
      {polls.length === 0 ? (
        <p className="empty">
          You have not asked a masternode poll with this identity. <Link to="/polls/new">Ask one</Link>
        </p>
      ) : (
        <Cards polls={polls} src={src} endsAt={ends} nowMs={nowMs} totalPower={totalPower} testId="mine-polls" />
      )}
    </>
  );
}
