// /polls/<id>: one masternode poll, laid out like a proposal page: the question, where the vote stands against its rule, the vote
// panel, the text and its edit history, and the discussion (the asker featured, as a proposal's owner is). Every read is proof-verified
// by the SDK; the only figure that is not is the network's voting power before a poll closes, taken from the current masternode list.
import type { Profile } from '@govhub/forum';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useForum } from '../app/forum.tsx';
import { useContestVotes } from '../contests/ContestVotes.tsx';
import { contenderClass } from '../contests/ui.tsx';
import { useClockMs } from '../contests/useContests.ts';
import { AddChoice } from '../decisions/AddChoice.tsx';
import { choicePhase, contestRun, editableUntil, isIdentifier, linkUrl, pct, pollDiscussionKey, pollVoteKey, yesNoOutlook, yesNoPhase, type ChoicePoll, type ChoiceState, type Poll, type YesNoPoll, type YesNoState } from '../decisions/model.ts';
import { PollVotePanel } from '../decisions/PollVotePanel.tsx';
import type { DecisionSource } from '../decisions/source.ts';
import { ChoiceBar, choiceName, kindLabel, outlook, PollsNotYet, turnoutText, YesNoBar } from '../decisions/ui.tsx';
import { useDecisionSource, usePollsAvailable } from '../decisions/useDecisions.ts';
import { errText, formatDateTime, formatDuration, formatInt } from '../lib/format.ts';
import { pollAsker } from '../lib/social.ts';
import { isWalletSession } from '../session/authSession.ts';
import { Discussion } from '../ui/Discussion.tsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { useAsync } from '../ui/hooks.ts';
import { AuthorName, Avatar } from '../ui/Identity.tsx';
import { ReadError } from '../ui/ReadError.tsx';
import { useDpnsNames } from '../ui/useDpnsNames.ts';

/** How long after voting closes the page reads the poll again, for the result. */
const CLOSING_REREAD_MS = 20_000;

const when = (ms: number) => formatDateTime(ms / 1000);

function Missing({ children }: { children: string }) {
  return (
    <section className="page-narrow">
      <h1>No such poll</h1>
      <p>
        {children} <Link to="/polls">All masternode polls</Link>
      </p>
    </section>
  );
}

export function PollPage() {
  const { id = '' } = useParams();
  const src = useDecisionSource();
  const avail = usePollsAvailable(src);
  if (!isIdentifier(id)) return <Missing>A poll's address ends in its Platform id, 32 to 44 letters and digits.</Missing>;
  if (avail.phase === 'checking')
    return (
      <p className="muted center pad" aria-busy="true">
        <span className="spinner" aria-hidden="true" /> Checking Platform for masternode polls…
      </p>
    );
  if (avail.phase === 'error') return <ReadError error={avail.error} what="Platform" lead="Platform could not be asked about masternode polls" onRetry={avail.retry} />;
  if (avail.phase === 'no')
    return (
      <section className="page-narrow polls">
        <p className="crumbs">
          <Link to="/polls">‹ Masternode polls</Link>
        </p>
        <PollsNotYet network={src.network} />
      </section>
    );
  return <PollView key={id} id={id} src={src} />;
}

function PollView({ id, src }: { id: string; src: DecisionSource }) {
  const [attempt, setAttempt] = useState(0);
  const poll = useAsync(() => src.get(id), [src, id, attempt]);
  if (poll.loading)
    return (
      <p className="muted center pad" aria-busy="true">
        <span className="spinner" aria-hidden="true" /> Reading the poll from Platform…
      </p>
    );
  if (poll.error) return <ReadError error={poll.error} what="Platform" lead="The poll could not be read" onRetry={() => setAttempt((n) => n + 1)} />;
  if (!poll.data) return <Missing>{`Platform has no masternode poll with this id on ${src.network}.`}</Missing>;
  return <PollBody poll={poll.data} src={src} />;
}

/**
 * A poll's state, kept fresh: read again while voting has closed and the result is not recorded yet (`closing`, every 20 s), after a
 * vote from this browser went out, and on `refresh`. A background read that fails keeps the last good one on screen.
 */
function usePollState<T>(src: DecisionSource, poll: Poll, read: () => Promise<T>, closing: (data: T | undefined) => boolean) {
  const [reads, setReads] = useState(0);
  const [st, setSt] = useState<{ data?: T; error?: string; loading: boolean; settled: number }>({ loading: true, settled: 0 });
  useEffect(() => {
    let live = true;
    if (reads) src.forget(poll.id);
    read().then(
      (data) => live && setSt((p) => ({ data, loading: false, settled: p.settled + 1 })),
      (e: unknown) => live && setSt((p) => (p.data !== undefined ? { ...p, loading: false, settled: p.settled + 1 } : { error: errText(e), loading: false, settled: p.settled + 1 })),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, poll.id, reads]);
  const refresh = () => setReads((n) => n + 1);
  const waiting = closing(st.data);
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setReads((n) => n + 1), CLOSING_REREAD_MS);
    return () => clearTimeout(t);
  }, [waiting, st.settled]);
  const key = pollVoteKey(poll.kind, poll.id);
  const sentHere = useContestVotes().held.filter((v) => v.label === key && v.status === 'sent').length;
  useEffect(() => {
    if (sentHere) setReads((n) => n + 1);
  }, [sentHere]);
  return {
    data: st.data,
    loading: st.loading,
    error: st.error,
    retry: () => {
      setSt((p) => (p.data !== undefined ? p : { loading: true, settled: p.settled }));
      refresh();
    },
  };
}

function useAsker(id: string): { dpns?: string | undefined; profile?: Profile | undefined } {
  const { forum } = useForum();
  const names = useDpnsNames([id]);
  const [profile, setProfile] = useState<Profile | undefined>(undefined);
  useEffect(() => {
    let live = true;
    forum.reader.profiles([id]).then(
      (m) => live && setProfile(m.get(id)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [forum, id]);
  return { dpns: names.get(id), profile };
}

function PollBody({ poll, src }: { poll: Poll; src: DecisionSource }) {
  const asker = useAsker(poll.ownerId);
  const featured = useMemo(() => pollAsker(poll.ownerId), [poll.ownerId]);
  return (
    <article className="proposal contest poll" data-testid="poll-page" data-kind={poll.kind}>
      <p className="crumbs">
        <Link to="/polls">‹ Masternode polls</Link>
      </p>
      <header className="p-hero">
        <div className="p-title">
          <p className="pcard-kind small muted">{kindLabel(poll)} poll</p>
          <h1>
            <bdi>{poll.title}</bdi>
          </h1>
        </div>
        <p className="poll-asker muted">
          <Avatar id={poll.ownerId} profile={asker.profile} size={22} />
          <span>
            Asked by <AuthorName id={poll.ownerId} profile={asker.profile} dpns={asker.dpns} /> on {when(poll.createdAt)}
          </span>
        </p>
      </header>
      {poll.kind === 'yn' ? <YesNoBody poll={poll} src={src} /> : <ChoiceBody poll={poll} src={src} />}
      <div className="p-layout poll-after">
        <div className="p-main">
          <ErrorBoundary what="discussion">
            <Discussion govHash={pollDiscussionKey(poll.id)} featured={featured} />
          </ErrorBoundary>
        </div>
      </div>
    </article>
  );
}

function YesNoBody({ poll, src }: { poll: YesNoPoll; src: DecisionSource }) {
  const nowMs = useClockMs();
  const st = usePollState(src, poll, () => src.yesNoState(poll.id), (d) => !!d && d.status !== 'finished' && poll.endDate <= nowMs);
  const power = useAsync(() => src.totalPower().catch(() => null), [src]);
  const s: YesNoState | null = st.data ?? null;
  const phase = yesNoPhase(poll, s, nowMs);
  const o = s ? yesNoOutlook(poll, s, power.data ?? null) : null;
  const look = o ? outlook(poll, o, phase === 'ended') : null;
  return (
    <div className="p-layout">
      <div className="p-main">
        <section className="panel c-ballot" aria-labelledby="poll-votes-title" data-testid="poll-votes">
          <h2 id="poll-votes-title" className="panel-title">
            Votes
          </h2>
          {st.loading ? (
            <p className="muted" aria-busy="true">
              <span className="spinner" aria-hidden="true" /> Reading the tally…
            </p>
          ) : st.error ? (
            <ReadError error={st.error} what="Platform" lead="The tally could not be read" onRetry={st.retry} />
          ) : !s || !o ? (
            <p className="muted">Platform has no vote for this poll.</p>
          ) : (
            <>
              <p className={`c-status c-status-${phase === 'ended' ? 'decided' : phase}`} data-testid="poll-status-line">
                {phase === 'ended'
                  ? `Ended${s.result?.at ? ` on ${when(s.result.at)}` : ''}: ${s.result?.passed ? 'passed' : 'did not pass'}.`
                  : phase === 'closing'
                    ? 'Voting has closed. Platform records the result in its next block.'
                    : `Voting closes in ${formatDuration((poll.endDate - nowMs) / 1000)}, on ${when(poll.endDate)}.`}
              </p>
              <YesNoBar state={s} />
              <ol className="c-choices" data-testid="poll-tally">
                {(
                  [
                    ['Yes', s.tally.yes, 'pb-yes', pct(s.tally.yes, s.tally.yes + s.tally.no), 'of yes and no'],
                    ['No', s.tally.no, 'pb-no', pct(s.tally.no, s.tally.yes + s.tally.no), 'of yes and no'],
                    ['Abstain', s.tally.abstain, 'cb-abstain', '', 'on neither side'],
                  ] as const
                ).map(([name, n, cls, share, note]) => (
                  <li key={name} className="c-choice">
                    <span className={`c-swatch ${cls}`} aria-hidden="true" />
                    <div className="c-who">
                      <b>{name}</b>
                      <span className="small muted">{share ? `${share} ${note}` : note}</span>
                    </div>
                    <span className="c-tally">
                      <b>{formatInt(n)}</b>
                      <span className="small muted">voting power</span>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="poll-outlook" data-testid="poll-outlook">
                <span className={`tag ptag-${look!.tone}`}>{look!.label}</span> {look!.why[0]!.toUpperCase() + look!.why.slice(1)}. {turnoutText(poll, o)}.
              </p>
              <p className="small muted">
                It passes when yes is more than {poll.passPercent}% of yes and no
                {poll.minimumTurnoutPercent
                  ? `, and yes and no together reach ${poll.minimumTurnoutPercent}% of all masternode voting power when it closes${o.requiredIsFinal ? '' : o.required !== null ? ` (about ${formatInt(o.required)} now, from the current masternode list; Platform counts the list at the close)` : ''}`
                  : ''}
                . Abstain votes count on neither side. A masternode counts 1, an evonode 4. The result is a signal only: nothing on the network acts on it.
              </p>
            </>
          )}
        </section>

        {phase === 'open' && s && (
          <ErrorBoundary what="masternode voting">
            <PollVotePanel poll={poll} state={null} endsAt={poll.endDate} />
          </ErrorBoundary>
        )}

        <PollText poll={poll} src={src} />
      </div>

      <aside className="p-side" aria-label="Summary">
        <section className="panel">
          <h2 className="panel-title">Summary</h2>
          <dl className="kv" data-testid="summary">
            <div>
              <dt>{phase === 'open' ? 'Closes' : 'Closed'}</dt>
              <dd>{when(poll.endDate)}</dd>
            </div>
            <div>
              <dt>Passes above</dt>
              <dd>{poll.passPercent}% yes</dd>
            </div>
            <div>
              <dt>Minimum turnout</dt>
              <dd>{poll.minimumTurnoutPercent ? `${poll.minimumTurnoutPercent}% of all voting power` : 'None'}</dd>
            </div>
            {power.data != null && phase !== 'ended' && (
              <div>
                <dt>Voting power now</dt>
                <dd>about {formatInt(power.data)}</dd>
              </div>
            )}
            <div>
              <dt>Text</dt>
              <dd>{textEditLine(poll, nowMs)}</dd>
            </div>
          </dl>
          <p className="small muted">Read from Dash Platform with proofs. The voting power before the close is an estimate from the masternode list that several DAPI nodes agree on.</p>
        </section>
      </aside>
    </div>
  );
}

const textEditLine = (poll: Poll, nowMs: number): string => {
  const until = editableUntil(poll);
  return until > nowMs ? `The asker can edit it until ${when(until)}` : 'Final';
};

function ChoiceBody({ poll, src }: { poll: ChoicePoll; src: DecisionSource }) {
  const nowMs = useClockMs();
  // the end comes from the open contests: read again when the choices change (the first choice opens the vote)
  const [endsRead, setEndsRead] = useState(0);
  const ends = useAsync(() => src.openChoices(endsRead > 0), [src, endsRead]);
  const endsAt = ends.data?.get(poll.id) ?? null;
  const st = usePollState(src, poll, () => src.choiceState(poll.id), (d) => !!d && !d.result && endsAt !== null && endsAt <= nowMs);
  const s: ChoiceState | null = st.data ?? null;
  const phase = choicePhase(s, endsAt, nowMs);
  const { session } = useForum();
  const run = contestRun(src.network);
  // choices join while the vote's join window is open: from its first choice (its end, less the vote's length, gives that)
  const choiceCount = s?.choices.length ?? 0;
  useEffect(() => {
    // only a vote that just opened here: an ended one is never among the open, and a scan still loading is no answer
    if (choiceCount && endsAt === null && !ends.loading && !ends.error && phase === 'open') setEndsRead((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choiceCount]);
  // an open vote whose end is not known yet (just opened) is taken as still joining: Platform refuses a choice after its join window
  // anyway; when the open votes could not be read nothing is offered
  const joinOpen = phase === 'nochoices' || (phase === 'open' && !ends.error && (endsAt === null || nowMs < endsAt - run.voteMs + run.joinMs));
  const mayAdd = !!session && !isWalletSession(session) && (poll.open || session.identityId === poll.ownerId);
  return (
    <div className="p-layout">
      <div className="p-main">
        <section className="panel c-ballot" aria-labelledby="poll-votes-title" data-testid="poll-votes">
          <h2 id="poll-votes-title" className="panel-title">
            Votes
          </h2>
          {st.loading || ends.loading ? (
            <p className="muted" aria-busy="true">
              <span className="spinner" aria-hidden="true" /> Reading the vote…
            </p>
          ) : st.error || !s ? (
            <ReadError error={st.error ?? 'no answer'} what="Platform" lead="The vote could not be read" onRetry={st.retry} />
          ) : (
            <>
              <p className={`c-status c-status-${phase === 'ended' ? 'decided' : phase}`} data-testid="poll-status-line">
                {phase === 'ended'
                  ? `Ended${s.result?.at ? ` on ${when(s.result.at)}` : ''}: ${s.result?.keptId ? `${choiceName(s.choices.find((c) => c.id === s.result!.keptId) ?? { id: s.result.keptId })} was kept` : 'none of the choices was kept'}.`
                  : phase === 'nochoices'
                    ? 'Waiting for its first choice: the vote opens when one is entered.'
                    : phase === 'closing'
                      ? 'Voting has closed. Platform records the result in its next block.'
                      : endsAt !== null
                        ? `Voting closes in ${formatDuration((endsAt - nowMs) / 1000)}, on ${when(endsAt)}.`
                        : 'Voting is open.'}
              </p>
              {s.choices.length > 0 && <ChoiceBar state={s} />}
              <ol className="c-choices" data-testid="poll-tally">
                {s.choices.map((c, i) => (
                  <li key={c.id} className={`c-choice${s.result?.keptId === c.id ? ' c-won' : ''}`} data-testid="poll-choice">
                    <span className={`c-swatch ${contenderClass(i)}`} aria-hidden="true" />
                    <div className="c-who">
                      <span className="c-ident">
                        <b>
                          <bdi>{choiceName(c)}</bdi>
                        </b>
                        {s.result?.keptId === c.id && <span className="tag ptag-pass">Kept</span>}
                      </span>
                      {c.description && <span className="small muted poll-choice-text">{c.description}</span>}
                      {!c.title && s.result && <span className="small muted">Its text left Platform when the vote ended; only the kept choice keeps it.</span>}
                    </div>
                    <span className="c-tally">
                      <b>{formatInt(c.votes)}</b>
                      <span className="small muted">{pct(c.votes, s.total)}</span>
                    </span>
                  </li>
                ))}
                <li className="c-choice">
                  <span className="c-swatch cb-abstain" aria-hidden="true" />
                  <div className="c-who">
                    <b>Abstain</b>
                    <span className="small muted">Counted, but for no choice.</span>
                  </div>
                  <span className="c-tally">
                    <b>{formatInt(s.abstain)}</b>
                    <span className="small muted">{pct(s.abstain, s.total)}</span>
                  </span>
                </li>
                <li className={`c-choice${s.result && !s.result.keptId ? ' c-won' : ''}`}>
                  <span className="c-swatch cb-lock" aria-hidden="true" />
                  <div className="c-who">
                    <b>None of the choices</b>
                    <span className="small muted">If these votes outnumber the leading choice, no choice is kept.</span>
                  </div>
                  <span className="c-tally">
                    <b>{formatInt(s.none)}</b>
                    <span className="small muted">{pct(s.none, s.total)}</span>
                  </span>
                </li>
              </ol>
              <p className="small muted">
                Most votes wins; a tie goes to the earliest choice. The vote runs {src.network === 'testnet' ? '90 minutes' : 'two weeks'} from the first choice. A masternode counts 1, an evonode 4. The result is a signal only: nothing on the network acts on it.
              </p>
            </>
          )}
        </section>

        {phase === 'open' && s && (
          <ErrorBoundary what="masternode voting">
            <PollVotePanel poll={poll} state={s} endsAt={endsAt} />
          </ErrorBoundary>
        )}

        {s && joinOpen && mayAdd && (
          <ErrorBoundary what="adding a choice">
            <AddChoice
              poll={poll}
              onAdded={() => {
                // the node read next may not have the new choice yet: read again a little later too
                st.retry();
                setTimeout(st.retry, 4000);
              }}
            />
          </ErrorBoundary>
        )}

        <PollText poll={poll} src={src} />
      </div>

      <aside className="p-side" aria-label="Summary">
        <section className="panel">
          <h2 className="panel-title">Summary</h2>
          <dl className="kv" data-testid="summary">
            <div>
              <dt>{phase === 'ended' ? 'Decided' : 'Closes'}</dt>
              <dd>{phase === 'ended' ? (s?.result?.at ? when(s.result.at) : 'Yes') : endsAt !== null ? when(endsAt) : phase === 'nochoices' ? 'Not open yet' : 'Unknown'}</dd>
            </div>
            <div>
              <dt>Choices</dt>
              <dd>{s ? formatInt(s.choices.length) : '…'}</dd>
            </div>
            <div>
              <dt>Votes</dt>
              <dd>{s ? formatInt(s.total) : '…'}</dd>
            </div>
            <div>
              <dt>Who adds choices</dt>
              <dd>{poll.open ? 'Anyone' : 'Only the asker'}</dd>
            </div>
            <div>
              <dt>Text</dt>
              <dd>{textEditLine(poll, nowMs)}</dd>
            </div>
          </dl>
          <p className="small muted">Read from Dash Platform with proofs.</p>
        </section>
      </aside>
    </div>
  );
}

/** The poll's text, where it is discussed, and every earlier version (Platform keeps them all). */
function PollText({ poll, src }: { poll: Poll; src: DecisionSource }) {
  const href = linkUrl(poll.url);
  const history = useAsync(() => (poll.revision > 1 ? src.history(poll) : Promise.resolve([])), [src, poll.id, poll.revision]);
  return (
    <section className="p-about poll-text" aria-labelledby="poll-text-title">
      <h2 id="poll-text-title">{poll.kind === 'yn' ? 'What yes and no mean' : 'What is being decided'}</h2>
      {poll.kind === 'yn' && <p className="poll-desc" data-testid="poll-description">{poll.description}</p>}
      {poll.kind === 'mc' && poll.description && (
        <p className="muted">
          Described by a document on Platform: <code>{poll.description.id}</code> ({poll.description.documentType} in contract <code>{poll.description.contractId}</code>). govhub does not show its text yet.
        </p>
      )}
      {poll.url && (
        <p>
          {poll.kind === 'mc' && !poll.description ? 'Described at ' : 'Discussed at '}
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc" className="ext" data-testid="poll-url">
              {href}
              <span className="visually-hidden"> (opens another site)</span>
            </a>
          ) : (
            <code>{poll.url}</code>
          )}
          {poll.kind === 'mc' && !poll.description && <span className="small muted"> Nothing on the network moderates what that page says, and it can change after votes were cast.</span>}
        </p>
      )}
      {history.data && history.data.length > 1 && (
        <details className="poll-history" data-testid="poll-history">
          <summary>
            Edited {history.data.length - 1} {history.data.length === 2 ? 'time' : 'times'}: every version is kept on Platform
          </summary>
          <ol>
            {history.data.map((v) => (
              <li key={v.revision}>
                <p className="small muted">
                  Version {v.revision}, {when(v.at)}
                </p>
                <p>
                  <b>
                    <bdi>{v.title}</bdi>
                  </b>
                </p>
                {v.description !== undefined && <p className="poll-desc small">{v.description}</p>}
                {v.url && <p className="small">{v.url}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
      {history.error && <p className="small muted">The earlier versions could not be read: {history.error}</p>}
    </section>
  );
}
