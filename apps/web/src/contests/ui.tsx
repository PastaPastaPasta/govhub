// Contest pieces shared by the list and the contest page: the ballot bar, status wording and the list card.
import { Link } from 'react-router-dom';
import { formatDate, formatDuration, formatInt } from '../lib/format.ts';
import { displayName, percent, phaseOf, type ContestState, type Phase } from './model.ts';
import './contests.css';

export const contestHref = (label: string) => `/names/${encodeURIComponent(label)}`;

/** Bar colour of the contender at this rank (most votes first). */
export const contenderClass = (rank: number) => `cb-c${Math.min(rank, 3)}`;

/** One bar for the whole vote: contenders (most first), then abstain, then lock. Empty bar while there are no votes. */
export function BallotBar({ state, size = 'm' }: { state: ContestState; size?: 's' | 'm' }) {
  const parts = [
    ...state.contenders.map((c, i) => ({ key: c.identityId, n: c.votes, cls: contenderClass(i), label: `${formatInt(c.votes)} for ${state.contenders.length > 1 ? `contender ${i + 1}` : 'the contender'}` })),
    { key: 'abstain', n: state.abstain, cls: 'cb-abstain', label: `${formatInt(state.abstain)} abstain` },
    { key: 'lock', n: state.lock, cls: 'cb-lock', label: `${formatInt(state.lock)} lock` },
  ];
  return (
    <div className={`cbar cbar-${size}`} role="img" aria-label={state.total ? `Votes: ${parts.map((p) => p.label).join(', ')}` : 'No votes yet'}>
      {state.total > 0 && parts.filter((p) => p.n > 0).map((p) => <span key={p.key} className={p.cls} style={{ flexGrow: p.n }} />)}
    </div>
  );
}

/** Who is ahead, in a few words, for a card. */
export function leadText(s: ContestState): string {
  const top = s.contenders[0];
  if (s.outcome) {
    const w = s.outcome.kind === 'won' ? s.outcome.identityId : null;
    const got = s.contenders.find((c) => c.identityId === w);
    if (got) return `Won with ${percent(got.votes, s.total)} of the votes`;
    if (s.outcome.kind === 'locked') return `Locked by ${percent(s.lock, s.total)} of the votes`;
    return s.total === 0 ? 'No votes' : 'No winner';
  }
  if (s.total === 0) return 'No votes yet';
  if (!top || s.lock > top.votes) return `Lock leads with ${percent(s.lock, s.total)}`;
  if (top.votes === 0) return 'Only abstain votes so far';
  if (s.contenders.length === 1) return `${percent(top.votes, s.total)} for the only contender`;
  return `Leader ${percent(top.votes, s.total)}, next ${percent(s.contenders[1]!.votes, s.total)}`;
}

/** Short status for a card: "Closes in 3.2 days", "Awarded", "Locked". */
export function statusTag(phase: Phase, s: ContestState | null, endsAt: number | null, nowMs: number): { text: string; tone: 'open' | 'soon' | 'won' | 'locked' | 'done' } {
  if (phase === 'decided' && s?.outcome) {
    if (s.outcome.kind === 'won') return { text: 'Awarded', tone: 'won' };
    if (s.outcome.kind === 'locked') return { text: 'Locked', tone: 'locked' };
    return { text: 'No winner', tone: 'done' };
  }
  if (phase === 'closing') return { text: 'Voting closed', tone: 'done' };
  if (endsAt === null) return { text: 'Open', tone: 'open' };
  const left = (endsAt - nowMs) / 1000;
  return { text: `Closes in ${formatDuration(left)}`, tone: left < 86_400 ? 'soon' : 'open' };
}

export function ContestCard({ label, endsAt, state, failed, nowMs }: { label: string; endsAt: number | null; state: ContestState | undefined; failed?: boolean; nowMs: number }) {
  const s = state ?? null;
  const phase = phaseOf(s, endsAt, nowMs);
  const tag = statusTag(phase, s, endsAt, nowMs);
  const name = displayName(s, label);
  const href = contestHref(label);
  return (
    <article className={`prow crow crow-${tag.tone}`} data-label={label} data-testid="contest-card">
      <div className="prow-main">
        <h2 className="prow-title">
          <Link to={href}>
            <bdi>{name}</bdi>
            <span className="tld">.dash</span>
          </Link>
        </h2>
        <p className="small muted">
          {s ? (s.contenders.length === 1 ? '1 contender' : `${formatInt(s.contenders.length)} contenders`) : failed ? 'Could not be read' : ' '}
        </p>
      </div>
      <div className="crow-status">
        <span className={`tag ctag-${tag.tone}`}>{tag.text}</span>
        {phase === 'decided' && s?.outcome?.at ? <p className="small muted">{formatDate(s.outcome.at / 1000)}</p> : null}
      </div>
      <div className="crow-bar">
        {s ? (
          <>
            <BallotBar state={s} size="s" />
            <p className="small muted">{leadText(s)}</p>
          </>
        ) : failed ? (
          <p className="small muted">The tally could not be read</p>
        ) : (
          <span className="cbar cbar-s cbar-loading" aria-label="Loading the tally" />
        )}
      </div>
      <p className="prow-meta small">
        <span className="muted">{s ? `${formatInt(s.total)} ${s.total === 1 ? 'vote' : 'votes'}` : ''}</span>
      </p>
    </article>
  );
}
