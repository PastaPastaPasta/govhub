// /names/<label>: one username contest, laid out like a proposal page: the name, where the vote stands, who wants it, and (later)
// the vote panel and the discussion. Reads are proof-verified by the SDK; there is nothing else to check.
import type { Profile } from '@govhub/forum';
import { EVONODE_WEIGHT } from '@govhub/verify';
import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useForum } from '../app/forum.tsx';
import { AuthorName, Avatar } from '../ui/Identity.tsx';
import { ReadError } from '../ui/ReadError.tsx';
import { useAsync } from '../ui/hooks.ts';
import { formatDateTime, formatDuration, formatInt } from '../lib/format.ts';
import { displayName, isContestedLabel, normalizeLabel, percent, phaseOf, registersAs, VOTE_CHANGES, type Contender, type ContestState, type Phase } from '../contests/model.ts';
import { BallotBar, contenderClass, contestHref } from '../contests/ui.tsx';
import { useClockMs, useContestSource } from '../contests/useContests.ts';

/** How long after voting closes the page reads the contest again, for the result. */
const CLOSING_REREAD_MS = 20_000;

export function ContestPage() {
  const { label: raw = '' } = useParams();
  const label = normalizeLabel(raw);
  if (label !== raw) return <Navigate replace to={contestHref(label)} />;
  if (!isContestedLabel(label))
    return (
      <Missing label={label}>
        Only names of 3 to 19 letters, hyphens, 0 and 1 (after o becomes 0 and i and l become 1) can be contested.
      </Missing>
    );
  return <ContestView label={label} />;
}

function Missing({ label, children }: { label: string; children: string }) {
  return (
    <section className="page-narrow">
      <h1>No contest for {label}.dash</h1>
      <p>
        {children} <Link to="/names">All contested usernames</Link>
      </p>
    </section>
  );
}

/** DPNS names and self-chosen profiles of these identities, best effort (an identity without either shows its short id). */
function useIdentities(ids: readonly string[]): { names: ReadonlyMap<string, string>; profiles: ReadonlyMap<string, Profile> } {
  const { forum } = useForum();
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [profiles, setProfiles] = useState<ReadonlyMap<string, Profile>>(new Map());
  const key = [...ids].sort().join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    const list = key.split(',');
    forum.names(list).then((m) => live && setNames(m), () => {});
    forum.reader.profiles(list).then((m) => live && setProfiles(m), () => {});
    return () => {
      live = false;
    };
  }, [forum, key]);
  return { names, profiles };
}

function statusLine(phase: Phase, s: ContestState, endsAt: number | null, nowMs: number): string {
  const when = (ms: number | null) => (ms ? formatDateTime(ms / 1000) : null);
  if (phase === 'decided' && s.outcome) {
    const at = when(s.outcome.at);
    if (s.outcome.kind === 'won') return at ? `Awarded on ${at}.` : 'Awarded.';
    if (s.outcome.kind === 'locked') return `Locked${at ? ` on ${at}` : ''}: lock got the most votes, so nobody can register this name.`;
    return `Ended${at ? ` on ${at}` : ''} with no winner.`;
  }
  if (phase === 'closing') return 'Voting has closed. Platform records the result in its next block.';
  // no end time known (the open list could not be read, or does not have it yet): nothing is claimed
  if (endsAt === null) return 'No result yet.';
  return `Voting closes in ${formatDuration((endsAt - nowMs) / 1000)}, on ${formatDateTime(endsAt / 1000)}.`;
}

function ContestView({ label }: { label: string }) {
  const src = useContestSource();
  const nowMs = useClockMs();
  const [attempt, setAttempt] = useState(0);
  const state = useAsync(() => {
    if (attempt) src.forget(label);
    return src.state(label);
  }, [src, label, attempt]);
  // the end time comes from the open list (one cached query); a decided contest has none
  const open = useAsync(() => src.open().catch(() => []), [src]);
  const endsAt = open.data?.find((c) => c.label === label)?.endsAt ?? null;
  // while a closed contest waits for its result it is read again in the background: the page keeps showing the last good read
  const [fresh, setFresh] = useState<{ key: string; s: ContestState } | null>(null);
  const [rereads, setRereads] = useState(0);
  const s = fresh?.key === label && state.data ? fresh.s : state.data;
  const who = useIdentities(s ? s.contenders.map((c) => c.identityId) : []);
  const phase = s ? phaseOf(s, endsAt, nowMs) : null;
  useEffect(() => {
    if (phase !== 'closing') return;
    let live = true;
    const t = setTimeout(() => {
      src.forget(label);
      src.state(label).then(
        (x) => live && setFresh({ key: label, s: x }),
        () => live && setRereads((n) => n + 1), // try again in a while
      );
    }, CLOSING_REREAD_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [phase, src, label, fresh, rereads]);

  if (state.loading)
    return (
      <p className="muted center pad" aria-busy="true">
        <span className="spinner" aria-hidden="true" /> Reading the contest from Platform…
      </p>
    );
  if (!s) return <ReadError error={state.error ?? 'no answer'} what="Platform" lead="The contest could not be read" onRetry={() => setAttempt((n) => n + 1)} />;
  if (s.contenders.length === 0 && s.total === 0 && !s.outcome) return <Missing label={label}>{`Platform has no record of a vote on this name on ${src.network}.`}</Missing>;

  const name = displayName(s, label);
  const regAs = registersAs(name, label);
  const winner = s.outcome?.kind === 'won' ? s.outcome.identityId : null;

  return (
    <article className="proposal contest" data-testid="contest-page">
      <p className="crumbs">
        <Link to="/names">‹ Usernames</Link>
      </p>
      <header className="p-hero">
        <div className="p-title">
          <h1>
            <bdi>{name}</bdi>
            <span className="tld">.dash</span>
          </h1>
        </div>
        {regAs && <p className="muted">Registers as {regAs}.dash</p>}
      </header>

      <div className="p-layout">
        <div className="p-main">
          <section className="panel c-ballot" aria-labelledby="c-votes-title">
            <h2 id="c-votes-title" className="panel-title">
              Votes
            </h2>
            <p className={`c-status c-status-${phase}`} data-testid="contest-status">
              {statusLine(phase!, s, endsAt, nowMs)}
            </p>
            <BallotBar state={s} />
            <ol className="c-choices" data-testid="contenders">
              {s.contenders.map((c, i) => (
                <ContenderRow key={c.identityId} c={c} rank={i} total={s.total} won={winner === c.identityId} dpns={who.names.get(c.identityId)} profile={who.profiles.get(c.identityId)} />
              ))}
              <li className="c-choice">
                <span className="c-swatch cb-abstain" aria-hidden="true" />
                <div className="c-who">
                  <b>Abstain</b>
                  <span className="small muted">Counted, but for nobody.</span>
                </div>
                <Tally n={s.abstain} total={s.total} />
              </li>
              <li className={`c-choice${s.outcome?.kind === 'locked' ? ' c-won' : ''}`}>
                <span className="c-swatch cb-lock" aria-hidden="true" />
                <div className="c-who">
                  <b>Lock</b>
                  <span className="small muted">Nobody gets the name.</span>
                </div>
                <Tally n={s.lock} total={s.total} />
              </li>
            </ol>
            <p className="small muted">
              Each masternode can change its vote up to {VOTE_CHANGES} times; its last vote counts. Evonode votes count {EVONODE_WEIGHT} times.
            </p>
          </section>
        </div>

        <aside className="p-side" aria-label="Summary">
          <section className="panel">
            <h2 className="panel-title">Summary</h2>
            <dl className="kv" data-testid="summary">
              <div>
                <dt>{phase === 'decided' ? 'Decided' : 'Closes'}</dt>
                <dd>{phase === 'decided' ? (s.outcome?.at ? formatDateTime(s.outcome.at / 1000) : 'Yes') : endsAt ? formatDateTime(endsAt / 1000) : 'Unknown'}</dd>
              </div>
              <div>
                <dt>Contenders</dt>
                <dd>{formatInt(s.contenders.length)}</dd>
              </div>
              <div>
                <dt>Votes</dt>
                <dd>{formatInt(s.total)}</dd>
              </div>
            </dl>
            <p className="small muted">{s.height !== null ? `Read from Dash Platform with proofs, at Platform block ${formatInt(s.height)}.` : 'Read from Dash Platform with proofs.'}</p>
          </section>
        </aside>
      </div>
    </article>
  );
}

function Tally({ n, total }: { n: number; total: number }) {
  return (
    <span className="c-tally">
      <b>{formatInt(n)}</b>
      <span className="small muted">{percent(n, total)}</span>
    </span>
  );
}

function ContenderRow({ c, rank, total, won, dpns, profile }: { c: Contender; rank: number; total: number; won: boolean; dpns?: string | undefined; profile?: Profile | undefined }) {
  return (
    <li className={`c-choice${won ? ' c-won' : ''}`} data-testid="contender">
      <span className={`c-swatch ${contenderClass(rank)}`} aria-hidden="true" />
      <div className="c-who">
        <span className="c-ident">
          <Avatar id={c.identityId} profile={profile} size={22} />
          <AuthorName id={c.identityId} profile={profile} dpns={dpns} />
          {won && <span className="tag ctag-won">Got the name</span>}
        </span>
        {c.requested && (
          <span className="small muted">
            Asked for <bdi className="c-requested">{c.requested}</bdi>
          </span>
        )}
      </div>
      <Tally n={c.votes} total={total} />
    </li>
  );
}
