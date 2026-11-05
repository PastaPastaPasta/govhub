// /names/<label>: one username contest, laid out like a proposal page: the name, where the vote stands, who wants it, and the
// discussion (its contenders featured, as a proposal's owner is). Reads are proof-verified by the SDK; there is nothing else to check.
import type { Profile } from '@govhub/forum';
import { EVONODE_WEIGHT } from '@govhub/verify';
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { MovedFromVote } from '../contests/MovedFromVote.tsx';
import { useTitle } from '../app/title.ts';
import { Link } from '../ui/Link.tsx';
import { useForum } from '../app/forum.tsx';
import { AuthorName, Avatar } from '../ui/Identity.tsx';
import { Discussion } from '../ui/Discussion.tsx';
import { contenders } from '../lib/social.ts';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { ReadError } from '../ui/ReadError.tsx';
import { useAsync } from '../ui/hooks.ts';
import { formatDateTime, formatDuration, formatInt } from '../lib/format.ts';
import { contestKey, displayName, isContestedLabel, normalizeLabel, percent, phaseOf, registersAs, VOTE_CHANGES, type Contender, type ContestState, type Phase } from '../contests/model.ts';
import { BallotBar, contenderClass, contestHref } from '../contests/ui.tsx';
import { ContestVotePanel } from '../contests/VotePanel.tsx';
import { useContestVotes } from '../contests/ContestVotes.tsx';
import { authorLabel } from '../lib/social.ts';
import { useClockMs, useContestSource } from '../contests/useContests.ts';

/** How long after voting closes the page reads the contest again, for the result. */
const CLOSING_REREAD_MS = 20_000;

export function ContestPage() {
  const { label: raw = '' } = useParams();
  const { search } = useLocation();
  const label = normalizeLabel(raw);
  if (label !== raw) return <Navigate replace to={contestHref(label) + search} />;
  if (!isContestedLabel(label))
    return (
      <Missing label={label}>
        Only names of 3 to 19 letters, hyphens, 0 and 1 (after o becomes 0 and i and l become 1) can be contested.
      </Missing>
    );
  return (
    <>
      <MovedFromVote />
      <ContestView label={label} />
    </>
  );
}

const networkLabel = (n: string) => (n === 'testnet' ? 'Testnet' : 'Mainnet');

/** `network`: where it was looked for; the other network is offered (old EvoVote bookmarks carry no network, so they land on Mainnet). */
function Missing({ label, children, network }: { label: string; children: string; network?: string }) {
  useTitle(`No contest for ${label}.dash`);
  const other = network === 'testnet' ? 'mainnet' : network ? 'testnet' : null;
  return (
    <section className="page-narrow" data-testid="contest-missing">
      <h1>No contest for {label}.dash</h1>
      <p>
        {children} <Link to="/names">All name contests</Link>
      </p>
      {other && (
        <p>
          <Link to={`${contestHref(label)}?network=${other}`} data-testid="contest-other-network">
            Look on {networkLabel(other)} →
          </Link>
        </p>
      )}
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
  const [fresh, setFresh] = useState<{ src: typeof src; key: string; s: ContestState } | null>(null);
  const [rereads, setRereads] = useState(0);
  const s = fresh?.src === src && fresh.key === label && state.data ? fresh.s : state.data;
  const who = useIdentities(s ? s.contenders.map((c) => c.identityId) : []);
  // the contenders are this discussion's featured authors, as a proposal's owner is on its page
  const contenderKey = s ? s.contenders.map((c) => c.identityId).sort().join(',') : '';
  const featured = useMemo(() => contenders(contenderKey ? contenderKey.split(',') : []), [contenderKey]);
  const phase = s ? phaseOf(s, endsAt, nowMs) : null;
  useTitle(`${s ? displayName(s, label) : label}.dash name contest`);
  useEffect(() => {
    if (phase !== 'closing') return;
    let live = true;
    const t = setTimeout(() => {
      src.forget(label);
      src.state(label).then(
        (x) => live && setFresh({ src, key: label, s: x }),
        () => live && setRereads((n) => n + 1), // try again in a while
      );
    }, CLOSING_REREAD_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [phase, src, label, fresh, rereads]);
  // a vote from this browser went out: the tally is read again (the sender dropped the cached one), in the background
  const sentHere = useContestVotes().held.filter((v) => v.label === label && v.status === 'sent').length;
  useEffect(() => {
    if (!sentHere) return;
    let live = true;
    src.state(label).then(
      (x) => live && setFresh({ src, key: label, s: x }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sentHere, src, label]);

  if (state.loading)
    return (
      <p className="muted center pad" aria-busy="true">
        <span className="spinner" aria-hidden="true" /> Reading the contest from Platform…
      </p>
    );
  if (!s) return <ReadError error={state.error ?? 'no answer'} what="Platform" lead="The contest could not be read" onRetry={() => setAttempt((n) => n + 1)} />;
  if (s.contenders.length === 0 && s.total === 0 && !s.outcome)
    return (
      <Missing label={label} network={src.network}>
        {`Platform has no record of a vote on this name on ${networkLabel(src.network)}.`}
      </Missing>
    );

  const name = displayName(s, label);
  const regAs = registersAs(name, label);
  const winner = s.outcome?.kind === 'won' ? s.outcome.identityId : null;

  return (
    <article className="proposal contest" data-testid="contest-page">
      <p className="crumbs">
        <Link to="/names">‹ Name contests</Link>
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

      <p className="small muted">Elsewhere: <a href={window.dashhq?.href('explorer', '/dpns?name=' + encodeURIComponent(label))}>Username in Explorer</a></p>
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
                <ContenderRow key={c.identityId} label={label} c={c} rank={i} total={s.total} won={winner === c.identityId} dpns={who.names.get(c.identityId)} profile={who.profiles.get(c.identityId)} />
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

          {phase === 'open' && (
            <ErrorBoundary what="masternode voting">
              <ContestVotePanel label={label} state={s} endsAt={endsAt} nameOf={(id) => contenderName(id, who.profiles.get(id), who.names.get(id))} />
            </ErrorBoundary>
          )}

          <ErrorBoundary what="discussion">
            <Discussion govHash={contestKey(label)} featured={featured} />
          </ErrorBoundary>
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

/** A contender as a vote option: DPNS name, else the self-chosen name with the short id, else the short id. */
function contenderName(id: string, profile?: Profile, dpns?: string): string {
  const a = authorLabel(id, profile, dpns);
  return a.dpns ?? (a.name ? `${a.quoted ? `“${a.name}”` : a.name} (${a.shortId})` : a.shortId);
}

function Tally({ n, total }: { n: number; total: number }) {
  return (
    <span className="c-tally">
      <b>{formatInt(n)}</b>
      <span className="small muted">{percent(n, total)}</span>
    </span>
  );
}

function ContenderRow({ label, c, rank, total, won, dpns, profile }: { label: string; c: Contender; rank: number; total: number; won: boolean; dpns?: string | undefined; profile?: Profile | undefined }) {
  return (
    <li className={`c-choice${won ? ' c-won' : ''}`} data-testid="contender">
      <span className={`c-swatch ${contenderClass(rank)}`} aria-hidden="true" />
      <div className="c-who">
        <span className="c-ident">
          <Avatar id={c.identityId} profile={profile} size={22} />
          <AuthorName id={c.identityId} profile={profile} dpns={dpns} />
          {won && <span className="tag ctag-won">Got the name</span>}
        </span>
        <ContestVoters label={label} identityId={c.identityId} />
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

function ContestVoters({ label, identityId }: { label: string; identityId: string }) {
  const src = useContestSource();
  const [load, setLoad] = useState(false);
  const voters = useAsync(() => load ? src.voters(label, identityId) : Promise.resolve(null), [src, label, identityId, load]);
  if (!load) return <button type="button" className="btn btn-quiet btn-s" onClick={() => setLoad(true)}>Show voters</button>;
  if (voters.loading) return <p className="small muted" role="status">Reading voter identities…</p>;
  if (voters.error) return <p className="small error" role="alert">Voters could not be read. <button type="button" className="btn btn-s" onClick={() => setLoad(false)}>Try again</button></p>;
  const ids = voters.data ?? [];
  return <div className="contest-voters">
    <p className="small muted">{!src.live ? 'No voter identities in this demo.' : `${formatInt(ids.length)} voter identities${ids.length === 100 ? ' (first 100)' : ''}. Voter identities are distinct from masternode ProTx hashes.`}</p>
    <ul>{ids.map(id => <li key={id}><dashhq-hash value={id} label="Voter identity" href={window.dashhq?.href('explorer', '/identity?id=' + encodeURIComponent(id))}>{id}</dashhq-hash></li>)}</ul>
  </div>;
}
