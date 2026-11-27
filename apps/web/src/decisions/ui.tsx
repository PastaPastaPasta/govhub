// Masternode poll pieces shared by the list and the poll page: tally bars, status wording, the list card and the "not yet" notice.
import { Link } from 'react-router-dom';
import { formatDate, formatDuration, formatInt, shortHash } from '../lib/format.ts';
import { CommentsLink } from '../ui/CommentsLink.tsx';
import { contenderClass } from '../contests/ui.tsx';
import { choicePhase, pct, pollHref, yesNoOutlook, yesNoPhase, type ChoiceState, type Poll, type PollChoice, type YesNoOutlook, type YesNoPoll, type YesNoState } from './model.ts';
import '../contests/contests.css';
import './decisions.css';

/** A poll's state as a list holds it: read, failed, or not read yet. */
export type PollStateEntry = YesNoState | ChoiceState | null | 'error' | undefined;

export const kindLabel = (p: Pick<Poll, 'kind'>): string => (p.kind === 'yn' ? 'Yes/no' : 'Multiple choice');

/** A choice's name: its title, or (once the vote ended, when Platform keeps only the winner's text) its short id. */
export const choiceName = (c: Pick<PollChoice, 'id' | 'title'>): string => c.title ?? `Choice ${shortHash(c.id, 4)}`;

/** Yes, no and abstain in one bar. Empty while nobody voted. */
export function YesNoBar({ state, size = 'm' }: { state: YesNoState; size?: 's' | 'm' }) {
  const t = state.tally;
  const total = t.yes + t.no + t.abstain;
  const parts = [
    { key: 'yes', n: t.yes, cls: 'pb-yes', label: `${formatInt(t.yes)} yes` },
    { key: 'no', n: t.no, cls: 'pb-no', label: `${formatInt(t.no)} no` },
    { key: 'abstain', n: t.abstain, cls: 'cb-abstain', label: `${formatInt(t.abstain)} abstain` },
  ];
  return (
    <div className={`cbar cbar-${size}`} role="img" aria-label={total ? `Voting power: ${parts.map((p) => p.label).join(', ')}` : 'No votes yet'}>
      {total > 0 && parts.filter((p) => p.n > 0).map((p) => <span key={p.key} className={p.cls} style={{ flexGrow: p.n }} />)}
    </div>
  );
}

/** The choices (most votes first), abstain and "none of the choices" in one bar. */
export function ChoiceBar({ state, size = 'm' }: { state: ChoiceState; size?: 's' | 'm' }) {
  const parts = [
    ...state.choices.map((c, i) => ({ key: c.id, n: c.votes, cls: contenderClass(i), label: `${formatInt(c.votes)} for ${choiceName(c)}` })),
    { key: 'abstain', n: state.abstain, cls: 'cb-abstain', label: `${formatInt(state.abstain)} abstain` },
    { key: 'none', n: state.none, cls: 'cb-lock', label: `${formatInt(state.none)} for none of the choices` },
  ];
  return (
    <div className={`cbar cbar-${size}`} role="img" aria-label={state.total ? `Votes: ${parts.map((p) => p.label).join(', ')}` : 'No votes yet'}>
      {state.total > 0 && parts.filter((p) => p.n > 0).map((p) => <span key={p.key} className={p.cls} style={{ flexGrow: p.n }} />)}
    </div>
  );
}

export type Tone = 'open' | 'soon' | 'pass' | 'fail' | 'done';

const closesIn = (endsAt: number, nowMs: number): { text: string; tone: Tone } => {
  const left = (endsAt - nowMs) / 1000;
  return { text: `Closes in ${formatDuration(left)}`, tone: left < 86_400 ? 'soon' : 'open' };
};

/** Short status of a yes/no poll for a card or the page: "Closes in 3 days", "Passed", "Did not pass". */
function yesNoTag(poll: YesNoPoll, state: YesNoState | null, nowMs: number): { text: string; tone: Tone } {
  const phase = yesNoPhase(poll, state, nowMs);
  if (phase === 'ended') return state?.result?.passed ? { text: 'Passed', tone: 'pass' } : { text: 'Did not pass', tone: 'fail' };
  if (phase === 'closing') return { text: 'Voting closed', tone: 'done' };
  return closesIn(poll.endDate, nowMs);
}

function choiceTag(state: ChoiceState | null, endsAt: number | null, nowMs: number): { text: string; tone: Tone } {
  const phase = choicePhase(state, endsAt, nowMs);
  if (phase === 'ended') return state?.result?.keptId ? { text: 'Decided', tone: 'pass' } : { text: 'No choice kept', tone: 'fail' };
  if (phase === 'nochoices') return { text: 'No choices yet', tone: 'done' };
  if (phase === 'closing') return { text: 'Voting closed', tone: 'done' };
  return endsAt === null ? { text: 'Open', tone: 'open' } : closesIn(endsAt, nowMs);
}

/** Where a yes/no poll stands: a word for its tag, and why. */
export function outlook(poll: YesNoPoll, o: YesNoOutlook, ended: boolean): { label: string; tone: Tone; why: string } {
  const share = o.yesShare === null ? 'no yes or no votes' : `yes ${pct(o.yesShare * 1000, 1000)} of yes and no`;
  if (ended)
    return o.passing
      ? { label: 'Passed', tone: 'pass', why: share }
      : { label: 'Did not pass', tone: 'fail', why: !o.meetsThreshold ? `${share}, needed more than ${poll.passPercent}%` : 'too few voted' };
  if (o.turnout === 0) return { label: 'No votes yet', tone: 'done', why: `needs more than ${poll.passPercent}% yes` };
  if (!o.meetsThreshold) return { label: 'Not passing', tone: 'fail', why: `${share}, needs more than ${poll.passPercent}%` };
  if (o.meetsTurnout === false) return { label: 'Not passing yet', tone: 'fail', why: `${share}, but too few voted` };
  if (o.meetsTurnout === null) return { label: 'Yes leads', tone: 'open', why: `${share} (turnout unknown here)` };
  return { label: 'Passing', tone: 'pass', why: share };
}

/** The same in one line, for a card. */
function outlookText(poll: YesNoPoll, o: YesNoOutlook, ended: boolean): string {
  const x = outlook(poll, o, ended);
  return `${x.label}: ${x.why}`;
}

/** Turnout against the minimum, in words: "708 of 432 needed", or "no minimum". */
export function turnoutText(poll: YesNoPoll, o: YesNoOutlook): string {
  if (poll.minimumTurnoutPercent === 0) return `Turnout ${formatInt(o.turnout)}, no minimum`;
  if (o.required === null) return `Turnout ${formatInt(o.turnout)}; needs ${poll.minimumTurnoutPercent}% of all voting power`;
  return `Turnout ${formatInt(o.turnout)} of ${o.requiredIsFinal ? '' : 'about '}${formatInt(o.required)} needed`;
}

/** What the leading choice has, or how the vote ended. */
export function choiceLead(s: ChoiceState): string {
  if (s.result) {
    const kept = s.result.keptId ? s.choices.find((c) => c.id === s.result!.keptId) : undefined;
    return kept ? `Kept ${choiceName(kept)} with ${pct(kept.votes, s.total)} of the votes` : 'None of the choices was kept';
  }
  const top = s.choices[0];
  if (!top) return 'Waiting for its first choice';
  if (s.total === 0) return 'No votes yet';
  if (s.none > top.votes) return `None of the choices leads with ${pct(s.none, s.total)}`;
  // Platform breaks a tie by the earliest choice, which the vote state does not say: no leader is named
  if (s.choices[1] && s.choices[1].votes === top.votes) return `Tied at ${pct(top.votes, s.total)}`;
  return `${choiceName(top)} leads with ${pct(top.votes, s.total)}`;
}

export function PollCard({ poll, state, endsAt, nowMs, totalPower, comments }: { poll: Poll; state: PollStateEntry; endsAt: number | null; nowMs: number; totalPower: number | null; comments?: number | undefined }) {
  const failed = state === 'error';
  const s = state && state !== 'error' ? state : null;
  const tag = poll.kind === 'yn' ? yesNoTag(poll, s as YesNoState | null, nowMs) : choiceTag(s as ChoiceState | null, endsAt, nowMs);
  // a multiple choice poll that ended is no longer among the open ones: its end is the result's block
  const when = poll.kind === 'yn' ? poll.endDate : (endsAt ?? (s && 'choices' in s ? (s.result?.at ?? null) : null));
  return (
    <article className={`prow crow pcard crow-${tag.tone === 'pass' || tag.tone === 'fail' ? 'done' : tag.tone}`} data-testid="poll-card" data-kind={poll.kind} data-id={poll.id}>
      <div className="prow-main">
        <p className="pcard-kind small muted">{kindLabel(poll)}</p>
        <h3 className="prow-title">
          <Link to={pollHref(poll.id)}>
            <bdi>{poll.title}</bdi>
          </Link>
        </h3>
      </div>
      <div className="crow-status">
        <span className={`tag ptag-${tag.tone}`} data-testid="poll-status">
          {tag.text}
        </span>
        {when !== null && <p className="small muted">{when > nowMs ? `Ends ${formatDate(when / 1000)}` : `Ended ${formatDate(when / 1000)}`}</p>}
      </div>
      <div className="crow-bar">
        {s && poll.kind === 'yn' ? (
          <YesNoSummary poll={poll} state={s as YesNoState} totalPower={totalPower} nowMs={nowMs} />
        ) : s && poll.kind === 'mc' ? (
          <>
            <ChoiceBar state={s as ChoiceState} size="s" />
            <p className="small muted">{choiceLead(s as ChoiceState)}</p>
          </>
        ) : failed ? (
          <p className="small muted">The tally could not be read</p>
        ) : state === null ? (
          <p className="small muted">Platform has no vote for this poll</p>
        ) : (
          <span className="cbar cbar-s cbar-loading">
            <span className="visually-hidden">Loading the tally</span>
          </span>
        )}
      </div>
      <p className="prow-meta small">
        <span className="muted">{poll.kind === 'yn' ? `Passes above ${poll.passPercent}% yes${poll.minimumTurnoutPercent ? `, ${poll.minimumTurnoutPercent}% turnout` : ''}` : s && 'choices' in s ? `${formatInt(s.choices.length)} ${s.choices.length === 1 ? 'choice' : 'choices'}` : ''}</span>
        <CommentsLink to={pollHref(poll.id)} count={comments} />
      </p>
    </article>
  );
}

function YesNoSummary({ poll, state, totalPower, nowMs }: { poll: YesNoPoll; state: YesNoState; totalPower: number | null; nowMs: number }) {
  const o = yesNoOutlook(poll, state, totalPower);
  return (
    <>
      <YesNoBar state={state} size="s" />
      <p className="small muted">{outlookText(poll, o, yesNoPhase(poll, state, nowMs) === 'ended')}</p>
      <p className="small muted">{turnoutText(poll, o)}</p>
    </>
  );
}

/** The calm "not yet" state: the network does not run masternode polls yet (it is read again every few minutes). */
export function PollsNotYet({ network }: { network: string }) {
  return (
    <div className="panel polls-soon" data-testid="polls-not-yet">
      <h2>Masternode polls arrive with Dash Platform 5.1 on {network}</h2>
      <p>
        Masternode polls are questions anyone can put to the masternodes: a yes or no, or a choice among several answers. They come with Platform protocol version 15, which {network} has not
        switched to yet. It switches once enough evonodes run Platform 5.1.
      </p>
      <p className="small muted">govhub checks Platform for them every few minutes, so this page shows them as soon as they are there. Nothing needs updating on your side.</p>
    </div>
  );
}

