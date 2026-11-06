import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { useTitle } from '../app/title.ts';
import { useAuth } from '../auth/context.tsx';
import { errorText } from '../auth/runtime.ts';
import { shortHash } from '../lib/format.ts';
import { Link } from '../ui/Link.tsx';
import { useAsync } from '../ui/hooks.ts';
import { ReadError } from '../ui/ReadError.tsx';
import { ARCHIVE_CONTRACT, POLL_CONTRACT, DRAFT_KEY, closed, pollOperation, readDraft, type Draft, type Poll } from './model.ts';
import { pollSource, type PollSource } from './source.ts';
import './polls.css';

const date = (ms: number) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(ms);
function usePolls() {
  const { registry } = useApp();
  return useMemo(() => pollSource(registry), [registry]);
}
function TestnetOnly({ children }: { children: ReactNode }) {
  const { registry } = useApp();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('network', 'testnet'); params.delete('profile'); params.delete('fixtures');
  return registry.platformNetwork !== 'testnet' ? <section className="polls-page"><header className="dh-page-header"><h1 className="dh-page-header__title">Polls</h1></header><div className="dh-notice dh-notice--info"><p>Polls run on Testnet while the poll contract is tested.</p><Link to={`${location.pathname}?${params}`} className="dh-btn dh-btn--secondary">Open Polls on Testnet</Link></div></section> : children;
}
function Person({ id }: { id: string }) {
  const { forum } = useForum();
  const names = useAsync(() => forum.names([id]), [forum, id]);
  return <bdi title={id}>{names.data?.get(id) ?? shortHash(id, 5)}</bdi>;
}
function Meta({ poll, asked = false }: { poll: Poll; asked?: boolean }) {
  return <p className="poll-meta">by <Person id={poll.owner} /> · {asked && <>asked <time dateTime={new Date(poll.createdAt).toISOString()}>{date(poll.createdAt)}</time> · </>}{poll.endsAt ? <>closes <time dateTime={new Date(poll.endsAt).toISOString()}>{date(poll.endsAt)}</time> (advisory)</> : 'no close date'}{!asked && ` · ${poll.options.length} options`}</p>;
}
function Loading({ children }: { children: ReactNode }) { return <p className="muted" role="status">{children}</p>; }
function ResultBar({ value, total }: { value: number; total: number }) {
  return <progress className="poll-bar" max={total || 1} value={value} aria-label={`${total ? Math.round(value / total * 100) : 0}%`} />;
}
function PollRow({ poll, source, archive }: { poll: Poll; source: PollSource; archive: boolean }) {
  const result = useAsync(() => source.results(poll, undefined, archive), [source, poll, archive]);
  const t = result.data;
  const leader = t ? t.counts.indexOf(Math.max(...t.counts)) : 0;
  return <article className="poll-row">
    <div><h2><Link to={`/polls/${poll.id}${archive ? '?archive=1' : ''}`} className="poll-title-link">{poll.question}</Link></h2><Meta poll={poll} /></div>
    <div className="poll-leader">{t ? t.selections ? <><span>{poll.options[leader]} leads with {Math.round(t.counts[leader]! / t.selections * 100)}%</span><ResultBar value={t.counts[leader]!} total={t.selections} /></> : <span className="muted">No answers yet</span> : <span className="muted">{result.error ? 'Results unavailable' : 'Reading answers…'}</span>}</div>
    <div className="poll-answer-count">{t ? <><strong>{t.identities}</strong><span>{t.identities === 1 ? 'answer' : 'answers'}</span></> : <span className="muted">—</span>}</div>
  </article>;
}
export function PollsPage({ archive = false }: { archive?: boolean }) {
  useTitle(archive ? 'Earlier polls' : 'Polls');
  return <TestnetOnly><PollList archive={archive} /></TestnetOnly>;
}
function PollList({ archive }: { archive: boolean }) {
  const source = usePolls();
  const { session } = useForum();
  const auth = useAuth();
  const [params, setParams] = useSearchParams();
  const [attempt, setAttempt] = useState(0), [count, setCount] = useState(20);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const seg = ['closed', 'mine'].includes(params.get('seg') ?? '') ? params.get('seg')! : 'open';
  const load = useAsync(() => source.list(archive), [source, archive, attempt]);
  const polls = load.data?.filter(p => archive || (seg === 'mine' ? p.owner === session?.identityId : closed(p, now) === (seg === 'closed'))) ?? [];
  return <section className="polls-page">
    <header className="polls-heading dh-page-header"><div><h1 className="dh-page-header__title">{archive ? 'Earlier polls' : 'Polls'}</h1><p className="dh-page-header__lede">{archive ? 'Pollr’s first contract remains readable here. These polls are read-only.' : 'Questions anyone with a Dash identity can ask and answer. Polls gather opinions; treasury proposals have their own votes.'}</p></div>{!archive && <Link to="/polls/new" className="dh-btn dh-btn--primary">New poll</Link>}</header>
    {archive ? <p><Link to="/polls">‹ Current polls</Link></p> : <nav className="dh-seg polls-segments" aria-label="Polls"><>{[['open', 'Open'], ['closed', 'Closed'], ['mine', 'Mine']].map(([value, label]) => <button key={value} type="button" aria-current={seg === value ? 'page' : undefined} onClick={() => { const next = new URLSearchParams(params); next.set('seg', value!); setParams(next); setCount(20); }}>{label}</button>)}</></nav>}
    {seg === 'mine' && !session && !archive ? <div className="poll-empty"><h2>Your polls, together</h2><p>Sign in with your Governance account to see the questions you’ve asked.</p><button type="button" className="dh-btn dh-btn--secondary" onClick={() => auth.openSheet('choose')}>Sign in</button></div> : load.loading ? <Loading>Reading polls from Platform…</Loading> : load.error ? <ReadError error={load.error} what="Platform" lead="Polls could not be read" onRetry={() => setAttempt(n => n + 1)} /> : !polls.length ? <div className="poll-empty"><h2>{archive ? 'No earlier polls' : seg === 'closed' ? 'No closed polls yet' : seg === 'mine' ? 'You haven’t asked a question yet' : 'No open polls right now'}</h2><p>{seg === 'closed' || archive ? 'Completed questions appear here once they are available.' : 'Start with a question and a few clear options.'}</p></div> : <div className="poll-list">{polls.slice(0, count).map(p => <PollRow key={p.id} poll={p} source={source} archive={archive} />)}</div>}
    {polls.length > count && <button type="button" className="dh-btn dh-btn--secondary" onClick={() => setCount(n => n + 20)}>Show more polls</button>}
    {!archive && <p className="polls-earlier muted">Polls from Pollr’s first contract stay readable: <Link to="/polls/archive">Earlier polls</Link>.</p>}
    <p className="dh-sources">Platform records are checked in this browser. Single-choice polls allow one answer per identity; multiple-choice polls allow each option once. Close dates are advisory.</p>
  </section>;
}
export function NewPollPage() {
  useTitle('New poll');
  return <TestnetOnly><Composer /></TestnetOnly>;
}
function Composer() {
  const [draft, setDraft] = useState<Draft>(() => readDraft(sessionStorage));
  const [storageError, setStorageError] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const source = usePolls(), auth = useAuth(), { session } = useForum();
  const navigate = useNavigate();
  const { search } = useLocation();
  useEffect(() => { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); setStorageError(false); } catch { setStorageError(true); } }, [draft]);
  const update = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }));
  async function publish() {
    setError('');
    try {
      pollOperation(draft);
      if (!session) { auth.openSheet('choose'); return; }
      setBusy(true);
      const result = await source.create(session, draft);
      try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* Publishing succeeded even if browser storage changed. */ }
      navigate(`/polls/${result.id}${search}`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <section className="poll-composer">
    <Link to="/polls" className="poll-back">‹ Polls</Link>
    <header className="dh-page-header"><h1 className="dh-page-header__title">New poll</h1><p className="dh-page-header__lede">Ask one clear question. Your question and answers will be public and cannot be edited after publishing.</p></header>
    <form onSubmit={e => { e.preventDefault(); void publish(); }} className="poll-form">
      <label className="dh-field"><span className="dh-field__label">Question</span><textarea className="dh-input" required maxLength={512} rows={3} value={draft.question} onChange={e => update({ question: e.target.value })} placeholder="What would you like to ask?" /></label>
      <fieldset className="poll-options"><legend className="dh-field__label">Options</legend>{draft.options.map((option, i) => <div className="poll-option-edit" key={i}><label className="dh-field"><span className="dh-field__label">Option {i + 1}</span><input className="dh-input" required maxLength={100} value={option} onChange={e => update({ options: draft.options.map((o, n) => n === i ? e.target.value : o) })} /></label>{draft.options.length > 2 && <button type="button" className="dh-btn dh-btn--quiet" aria-label={`Remove option ${i + 1}`} onClick={() => update({ options: draft.options.filter((_, n) => i !== n) })}>Remove</button>}</div>)}{draft.options.length < 10 && <button type="button" className="dh-btn dh-btn--secondary" onClick={() => update({ options: [...draft.options, ''] })}>Add option</button>}</fieldset>
      <label className="poll-checkbox"><input type="checkbox" checked={draft.multiChoice} onChange={e => update({ multiChoice: e.target.checked })} />Allow more than one choice</label>
      <label className="dh-field"><span className="dh-field__label">Close date <span className="muted">(optional, your local time)</span></span><input type="datetime-local" className="dh-input" value={draft.close} onChange={e => update({ close: e.target.value })} /><span className="dh-field__help">Advisory: the contract accepts late answers. They are counted separately.</span></label>
      <p className={storageError ? 'dh-notice dh-notice--warn' : 'small muted'} role="status">{storageError ? 'This browser could not save your draft. Keep this tab open until you publish.' : 'Draft saved for this session, including while you sign in. Closing this tab clears it.'}</p>
      {error && <p className="dh-notice dh-notice--warn" role="alert">{error}</p>}
      <div className="poll-submit"><button className="dh-btn dh-btn--primary" disabled={busy} type="submit">{busy ? 'Publishing…' : session ? 'Publish poll' : 'Sign in to publish'}</button><span className="small muted">Paid in Platform credits. The network sets the fee.</span></div>
    </form>
  </section>;
}
export function PollPage() {
  const { id = '' } = useParams();
  useTitle('Poll');
  return <TestnetOnly><PollRecord key={id} id={id} /></TestnetOnly>;
}
function PollRecord({ id }: { id: string }) {
  const source = usePolls(), [params] = useSearchParams();
  const archive = params.get('archive') === '1';
  const [attempt, setAttempt] = useState(0);
  const load = useAsync(() => source.get(id, archive), [source, id, archive, attempt]);
  return <section className="polls-page"><Link to={archive ? '/polls/archive' : '/polls'} className="poll-back">‹ {archive ? 'Earlier polls' : 'Polls'}</Link>{load.loading ? <Loading>Reading the poll…</Loading> : load.error ? <ReadError error={load.error} what="Platform" lead="The poll could not be read" onRetry={() => setAttempt(n => n + 1)} /> : load.data ? <PollDetail poll={load.data} source={source} archive={archive} /> : <div className="poll-empty"><h1 className="dh-page-header__title">Poll not found on Testnet</h1><p>The record may be from Pollr’s earlier contract. <Link to={`/polls/${id}?archive=1`}>Look in earlier polls</Link>.</p></div>}</section>;
}
function PollDetail({ poll, source, archive }: { poll: Poll; source: PollSource; archive: boolean }) {
  useTitle(poll.question);
  const auth = useAuth(), { session } = useForum();
  const [attempt, setAttempt] = useState(0), [selected, setSelected] = useState<number[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false), [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const result = useAsync(() => source.results(poll, session?.identityId, archive), [source, poll, session?.identityId, archive, attempt]);
  const t = result.data, isClosed = closed(poll, now), answered = !!t?.userChoices.length;
  const lead = t && t.selections ? Math.max(...t.counts) : -1;
  const canChoose = !archive && !isClosed && !(answered && !poll.multiChoice) && !busy;
  async function answer() {
    if (!session) { auth.openSheet('choose'); return; }
    setError(''); setBusy(true);
    try { await source.answer(session, poll, selected); setSelected([]); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); setAttempt(n => n + 1); }
  }
  const recordPath = `/contract/document/?id=${archive ? ARCHIVE_CONTRACT : POLL_CONTRACT}&type=poll&docId=${poll.id}`;
  const explorer = window.dashhq?.href('explorer', recordPath, { network: 'testnet' }) ?? `https://explorer.dashhq.org${recordPath}&network=testnet`;
  return <>
    <header className="dh-page-header poll-record-heading"><h1 className="dh-page-header__title">{poll.question}</h1><Meta poll={poll} asked /><p className="small muted">{poll.multiChoice ? 'Choose one or more options. Percentages show the share of selections.' : 'One answer per identity, enforced by the contract.'}{poll.endsAt && ' The close date is advisory: answers after it are counted separately.'}</p><span className="dh-proof dh-proof--ok" title="The poll document was read with a Platform proof checked in this browser.">Platform record verified</span></header>
    <div className="poll-detail-grid"><div>
      {result.error && <ReadError error={result.error} what="Platform" lead="Results are unavailable" onRetry={() => setAttempt(n => n + 1)} />}
      <fieldset className="poll-answer-options" disabled={!canChoose}><legend className="visually-hidden">Your answer</legend>{poll.options.map((option, i) => <label key={i} className={`poll-answer${t && t.counts[i] === lead ? ' poll-answer--leader' : ''}`}>
        <span className="poll-answer-label">{canChoose && <input type={poll.multiChoice ? 'checkbox' : 'radio'} name="answer" checked={selected.includes(i) || !!t?.userChoices.includes(i)} disabled={!!t?.userChoices.includes(i)} onChange={() => setSelected(s => poll.multiChoice ? s.includes(i) ? s.filter(n => n !== i) : [...s, i] : [i])} />}<span>{option}</span><span className="poll-answer-value">{t ? `${t.counts[i]} · ${t.selections ? Math.round(t.counts[i]! / t.selections * 100) : 0}%` : '—'}</span></span>{t && <ResultBar value={t.counts[i]!} total={t.selections} />}{!!t?.late[i] && <span className="small muted">{t.late[i]} late {t.late[i] === 1 ? 'selection' : 'selections'} · counted separately</span>}</label>)}</fieldset>
      {!t && !result.error && <Loading>Reading answers…</Loading>}
      {error && <p className="dh-notice dh-notice--warn" role="alert">{error}</p>}
      {archive || isClosed || (answered && !poll.multiChoice) ? <p className="muted">{archive ? 'Earlier polls are read-only.' : isClosed ? 'This poll is closed.' : 'Your answer is recorded.'}</p> : <div className="poll-submit"><button className="dh-btn dh-btn--primary" type="button" disabled={busy || (!!session && (!selected.length || !t))} onClick={() => void answer()}>{busy ? 'Sending answer…' : session ? <>Answer as <Person id={session.identityId} /></> : 'Sign in to answer'}</button><span className="small muted">Paid in Platform credits. The network sets the fee.</span></div>}
    </div><aside className="poll-record-aside"><dl><div><dt>Answers</dt><dd>{t ? `${t.identities} ${t.identities === 1 ? 'identity' : 'identities'}` : 'Unavailable'}</dd></div><div><dt>Network</dt><dd>Testnet</dd></div><div><dt>Record</dt><dd><a href={explorer}>{shortHash(poll.id, 5)} in Explorer ↗</a></dd></div><div><dt>Share</dt><dd><button type="button" className="dh-btn dh-btn--link" onClick={async () => { try { await navigator.clipboard.writeText(location.href); setCopied(true); } catch { setError('Could not copy the link. Copy it from your address bar.'); } }}>{copied ? 'Copied' : 'Copy link'}</button></dd></div></dl></aside></div>
  </>;
}
