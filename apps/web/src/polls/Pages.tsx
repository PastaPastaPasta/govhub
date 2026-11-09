import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { profileRegistry } from '../config/registry.ts';
import { useForum } from '../app/forum.tsx';
import { useTitle } from '../app/title.ts';
import { useAuth } from '../auth/context.tsx';
import { errorText } from '../auth/runtime.ts';
import { formatInt, shortHash } from '../lib/format.ts';
import { Link } from '../ui/Link.tsx';
import { useAsync } from '../ui/hooks.ts';
import { ReadError } from '../ui/ReadError.tsx';
import { ARCHIVE_CONTRACT, POLL_CONTRACT, DRAFT_KEY, closed, pollOperation, readDraft, voteType, type Draft, type Poll } from './model.ts';
import { pollSource, type PollSource } from './source.ts';
import './polls.css';

const date = (ms: number) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(ms);
function usePolls() {
  const { registry } = useApp();
  return useMemo(() => pollSource(registry), [registry]);
}
function TestnetOnly({ children, preview = false }: { children: ReactNode; preview?: boolean }) {
  const { registry } = useApp();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('network', 'testnet'); params.delete('profile'); params.delete('fixtures');
  if (registry.platformNetwork === 'testnet') return children;
  return <section className="polls-page">
    <header className="dh-page-header"><h1 className="dh-page-header__title">Polls</h1><p className="dh-page-header__lede">Explore community questions and see how Dash identities have answered.</p></header>
    <div className="dh-notice dh-notice--info"><p>Polls run on Testnet while the poll contract is tested. There are no Mainnet polls yet.</p><a href={`${location.pathname}?${params}`} className="dh-btn dh-btn--secondary">Open Polls on Testnet</a></div>
    {preview && <TestnetPreview />}
    <section className="dh-section polls-intro" aria-labelledby="polls-about"><h2 id="polls-about" className="dh-h2">Community opinions, on record</h2><p>Browse open questions and recent closed polls, with answer counts and results for each option. Sign in on Testnet when you want to ask or answer a question.</p><p className="muted">Polls gather opinions. Treasury funding is decided separately by masternode votes on proposals.</p></section>
  </section>;
}
function TestnetPreview() {
  const source = useMemo(() => pollSource(profileRegistry('testnet')), []);
  const [attempt, setAttempt] = useState(0);
  const load = useAsync(() => source.list(), [source, attempt]);
  const polls = load.data?.slice(0, 3) ?? [];
  return <section className="dh-section" aria-labelledby="testnet-preview">
    <h2 id="testnet-preview" className="dh-h2">Recent Testnet polls</h2>
    <p className="muted">Read-only preview · Open a question on Testnet to see its results.</p>
    {load.loading ? <Loading>Reading recent Testnet polls…</Loading> : load.error ? <ReadError error={load.error} what="Platform" lead="The Testnet preview could not be read" onRetry={() => setAttempt(n => n + 1)} /> : !polls.length ? <div className="poll-empty"><h3 className="dh-h3">No Testnet polls yet</h3><p>New questions will appear here when they are published on Testnet.</p></div> : <div className="poll-preview-list">{polls.map(poll => <article key={poll.id}>
      <h3 className="dh-h3"><a href={`/polls/${poll.id}?network=testnet`}>{poll.question}</a></h3>
      <p className="poll-meta">Testnet · Asked <time dateTime={new Date(poll.createdAt).toISOString()}>{date(poll.createdAt)}</time> · {closed(poll) ? 'Closed' : 'Open'}</p>
      <p className="small muted">{poll.options.join(' · ')}</p>
    </article>)}</div>}
    {!!polls.length && <p className="dh-sources">Testnet poll records checked against Platform proofs in this browser.</p>}
  </section>;
}
function Person({ id }: { id: string }) {
  const { forum } = useForum();
  const names = useAsync(() => forum.names([id]), [forum, id]);
  return <bdi title={id}>{names.data?.get(id) ?? shortHash(id, 5)}</bdi>;
}
function Meta({ poll, asked = false }: { poll: Poll; asked?: boolean }) {
  return <p className="poll-meta dh-meta"><span><span>by <Person id={poll.owner} /></span></span>{asked && <span><span>asked <time dateTime={new Date(poll.createdAt).toISOString()}>{date(poll.createdAt)}</time></span></span>}<span><span>{poll.endsAt ? <>{closed(poll) ? 'Closed' : 'Closes'} <time dateTime={new Date(poll.endsAt).toISOString()}>{date(poll.endsAt)}</time> (advisory)</> : 'no close date'}</span></span>{!asked && <span>{poll.options.length} options</span>}</p>;
}
function Loading({ children }: { children: ReactNode }) { return <p className="muted" role="status">{children}</p>; }
function ResultBar({ value, total }: { value: number; total: number }) {
  return <progress className="poll-bar" max={total || 1} value={value} aria-label={`${total ? Math.round(value / total * 100) : 0}%`} />;
}
function Fee({ source, draft, poll, selections = 1 }: { source: PollSource; draft?: Draft; poll?: Poll; selections?: number }) {
  const type = poll ? voteType(poll) : 'poll';
  const fields = useMemo(() => draft ? {
    question: { length: Math.max(1, [...draft.question.trim()].length) },
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`option${i}`, { present: i < draft.options.length, length: Math.max(1, [...(draft.options[i]?.trim() ?? '')].length) }])),
    multiChoice: { present: draft.multiChoice }, endsAt: { present: !!draft.close },
  } : {}, [draft]);
  const quote = useAsync(() => source.estimate(type, fields), [source, type, fields]);
  return <span className="small muted" title="SDK model estimate from the proof-checked contract, assuming new index values and 1,000 existing documents. It is not a bound or a guaranteed charge.">{quote.data !== undefined ? `Est. ${formatInt(quote.data * Math.max(1, selections))} credits · actual fee varies` : quote.error ? 'Fee estimate unavailable · paid in Platform credits' : 'Estimating the credit fee…'}</span>;
}
function PollRow({ poll, source, archive }: { poll: Poll; source: PollSource; archive: boolean }) {
  const result = useAsync(() => source.results(poll, undefined, archive), [source, poll, archive]);
  const t = result.data;
  const high = t ? Math.max(...t.counts) : 0;
  const leaders = t?.counts.filter(n => n === high).length ?? 0;
  return <article className="poll-row">
    <div><h2 className="dh-h3"><Link to={`/polls/${poll.id}${archive ? '?archive=1' : ''}`} className="poll-title-link">{poll.question}</Link></h2><Meta poll={poll} /></div>
    <div className="poll-leader">{t ? t.selections ? <><span>{leaders > 1 ? 'Tied at' : `${poll.options[t.counts.indexOf(high)]} leads with`} {Math.round(high / t.selections * 100)}%</span><ResultBar value={high} total={t.selections} /></> : <span className="muted">No answers yet</span> : <span className="muted">{result.error ? 'Results unavailable' : 'Reading answers…'}</span>}</div>
    <div className="poll-answer-count">{t ? <><strong>{t.identities}</strong><span>{t.identities === 1 ? 'answer' : 'answers'}</span></> : <span className="muted">—</span>}</div>
  </article>;
}
export function PollsPage({ archive = false }: { archive?: boolean }) {
  useTitle(archive ? 'Earlier polls' : 'Polls');
  return <TestnetOnly preview={!archive}><PollList archive={archive} /></TestnetOnly>;
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
  const recent = !archive && seg === 'open' && !polls.length ? (load.data ?? []).filter(p => closed(p, now)).sort((a, b) => b.endsAt! - a.endsAt!).slice(0, 5) : [];
  return <section className="polls-page">
    <header className="polls-heading dh-page-header"><div><h1 className="dh-page-header__title">{archive ? 'Earlier polls' : 'Polls'}</h1><p className="dh-page-header__lede">{archive ? 'Pollr’s first contract remains readable here. These polls are read-only.' : 'Questions anyone with a Dash identity can ask and answer. Polls gather opinions; treasury proposals have their own votes.'}</p></div>{!archive && <Link to="/polls/new" className="dh-btn dh-btn--primary">New poll</Link>}</header>
    {archive ? <p><Link to="/polls">‹ Current polls</Link></p> : <div className="dh-seg polls-segments" role="group" aria-label="Poll views"><>{[['open', 'Open'], ['closed', 'Closed'], ['mine', 'Mine']].map(([value, label]) => <button key={value} type="button" aria-pressed={seg === value} onClick={() => { const next = new URLSearchParams(params); next.set('seg', value!); setParams(next); setCount(20); }}>{label}</button>)}</></div>}
    {seg === 'mine' && !session && !archive ? <div className="poll-empty"><h2>Your polls, together</h2><p>Sign in with your Governance account to see the questions you’ve asked.</p><button type="button" className="dh-btn dh-btn--secondary" onClick={() => auth.openSheet('choose')}>Sign in</button></div> : load.loading ? <Loading>Reading polls from Platform…</Loading> : load.error ? <ReadError error={load.error} what="Platform" lead="Polls could not be read" onRetry={() => setAttempt(n => n + 1)} /> : !polls.length ? <div className="poll-empty"><h2>{archive ? 'No earlier polls' : seg === 'closed' ? 'No closed polls yet' : seg === 'mine' ? 'You haven’t asked a question yet' : 'No open polls right now'}</h2><p>{seg === 'closed' || archive ? 'Completed questions appear here once they are available.' : 'Start with a question and a few clear options.'}</p></div> : <div className="poll-list">{polls.slice(0, count).map(p => <PollRow key={p.id} poll={p} source={source} archive={archive} />)}</div>}
    {!load.loading && !load.error && recent.length > 0 && <section aria-labelledby="recent-polls"><h2 id="recent-polls" className="dh-h2">Recent closed polls</h2><div className="poll-list">{recent.map(p => <PollRow key={p.id} poll={p} source={source} archive={false} />)}</div></section>}
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
      <div className="dh-field"><label htmlFor="poll-question" className="dh-field__label">Question</label><textarea id="poll-question" className="dh-input" required maxLength={512} rows={3} value={draft.question} onChange={e => update({ question: e.target.value })} placeholder="What would you like to ask?" /></div>
      <fieldset className="poll-options"><legend className="dh-field__label">Options</legend>{draft.options.map((option, i) => <div className="poll-option-edit" key={i}><label className="dh-field"><span className="dh-field__label">Option {i + 1}</span><input className="dh-input" required maxLength={100} value={option} onChange={e => update({ options: draft.options.map((o, n) => n === i ? e.target.value : o) })} /></label>{draft.options.length > 2 && <button type="button" className="dh-btn dh-btn--quiet" aria-label={`Remove option ${i + 1}`} onClick={() => update({ options: draft.options.filter((_, n) => i !== n) })}>Remove</button>}</div>)}{draft.options.length < 10 && <button type="button" className="dh-btn dh-btn--secondary" onClick={() => update({ options: [...draft.options, ''] })}>Add option</button>}</fieldset>
      <label className="poll-checkbox"><input type="checkbox" checked={draft.multiChoice} onChange={e => update({ multiChoice: e.target.checked })} />Allow more than one choice</label>
      <label className="dh-field"><span className="dh-field__label">Close date <span className="muted">(optional, your local time)</span></span><input type="datetime-local" className="dh-input" value={draft.close} onChange={e => update({ close: e.target.value })} /><span className="dh-field__help">Advisory: the contract accepts late answers. They are counted separately.</span></label>
      <p className={storageError ? 'dh-notice dh-notice--warn' : 'small muted'} role="status">{storageError ? 'This browser could not save your draft. Keep this tab open until you publish.' : 'Draft saved for this session, including while you sign in. Closing this tab clears it.'}</p>
      {error && <p className="dh-notice dh-notice--warn" role="alert">{error}</p>}
      <div className="poll-submit"><button className="dh-btn dh-btn--primary" disabled={busy} type="submit">{busy ? 'Publishing…' : session ? 'Publish poll' : 'Sign in to publish'}</button><Fee source={source} draft={draft} /></div>
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
      {archive || isClosed || (answered && !poll.multiChoice) ? <p className="muted">{archive ? 'Earlier polls are read-only.' : isClosed ? 'This poll is closed.' : 'Your answer is recorded.'}</p> : <div className="poll-submit"><button className="dh-btn dh-btn--primary" type="button" disabled={busy || (!!session && (!selected.length || !t))} onClick={() => void answer()}>{busy ? 'Sending answer…' : session ? <>Answer as <Person id={session.identityId} /></> : 'Sign in to answer'}</button><Fee source={source} poll={poll} selections={selected.length} /></div>}
    </div><aside className="poll-record-aside"><dl><div><dt>Answers</dt><dd>{t ? `${t.identities} ${t.identities === 1 ? 'identity' : 'identities'}` : 'Unavailable'}</dd></div><div><dt>Network</dt><dd>Testnet</dd></div><div><dt>Record</dt><dd><a href={explorer}>{shortHash(poll.id, 5)} in Explorer ↗</a></dd></div><div><dt>Share</dt><dd><button type="button" className="dh-btn dh-btn--link" onClick={async () => { try { await navigator.clipboard.writeText(location.href); setCopied(true); } catch { setError('Could not copy the link. Copy it from your address bar.'); } }}>{copied ? 'Copied' : 'Copy link'}</button></dd></div></dl></aside></div>
  </>;
}
