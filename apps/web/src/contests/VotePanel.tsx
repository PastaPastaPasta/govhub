// Masternode voting on one username contest, with the keys of the open keyring: pick a choice and masternodes, then send now or
// spread the votes out. Keys are copied for the signing only (voting/gate.ts castKeys: wiped right after, and by a sign-out), so the
// keyring's lock rules (D-015, D-029) hold as for proposal votes. What leaves this function is signed votes, never keys.
import { base64 } from '@scure/base';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { errText, formatInt } from '../lib/format.ts';
import { useAsync } from '../ui/hooks.ts';
import { Badge, fmtTime, mnName, useLabels } from '../ui/vote/common.tsx';
import { castKeys } from '../voting/gate.ts';
import { useKeyring } from '../voting/KeyringContext.tsx';
import { assertUsableKey, type OwnedMasternode } from '../voting/masternodes.ts';
import { cryptoRand32 } from '../voting/plan.ts';
import type { Tone } from '../voting/status.ts';
import { useContestVotes } from './ContestVotes.tsx';
import { DEFAULT_SPREAD_MS, releaseTimes, spreadWindow, type HeldVote, type Network } from './held.ts';
import { VOTE_CHANGES, type ContestState } from './model.ts';
import { useContestSource } from './useContests.ts';
import { sameChoice, signVote, voterIdOf, type Choice } from './vote.ts';
import '../voting/voting.css';

const choiceKey = (c: Choice) => (c.kind === 'contender' ? `c:${c.identityId}` : c.kind);

/** "TheRoadNotTaken (alice.dash)", "Abstain", "Lock". */
export function choiceText(c: Choice | null | undefined, nameOf: (identityId: string) => string): string {
  if (!c) return 'No vote';
  if (c.kind === 'abstain') return 'Abstain';
  if (c.kind === 'lock') return 'Lock';
  return nameOf(c.identityId);
}

function heldLine(v: HeldVote, now: number): { badge: string; tone: Tone } {
  if (v.status === 'sent') return { badge: v.note ?? 'Sent', tone: 'ok' };
  if (v.status === 'failed') return { badge: v.note ?? 'Not sent', tone: 'bad' };
  if (v.status === 'sending') return { badge: 'Sending…', tone: 'progress' };
  if (v.nextTryAt && v.nextTryAt > now) return { badge: `Trying again at ${fmtTime(v.nextTryAt / 1000)}`, tone: 'wait' };
  if (v.releaseAt > now) return { badge: `Goes out at ${fmtTime(v.releaseAt / 1000)}`, tone: 'wait' };
  return { badge: 'Sending…', tone: 'progress' };
}

export function ContestVotePanel({ label, state, endsAt, nameOf }: { label: string; state: ContestState; endsAt: number | null; nameOf: (identityId: string) => string }) {
  const { registry } = useApp();
  const k = useKeyring();
  const kRef = useRef(k);
  kRef.current = k;
  const src = useContestSource();
  const votes = useContestVotes();
  const labels = useLabels();
  const network = registry.platformNetwork as Network;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  // this contest's votes kept in this browser; a newly sent one re-reads the masternodes' current votes
  const mine = votes.held.filter((v) => v.label === label && v.network === network);
  const sentCount = mine.filter((v) => v.status === 'sent').length;
  const usable = useMemo(() => k.mns.owned.filter((m) => m.valid), [k.mns.owned]);
  const voterOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const mn of usable) {
      const info = k.keyInfos[mn.keyIndex];
      if (info?.compressed) m.set(mn.proTxHash, voterIdOf(mn.proTxHash, info.pubKeyHash));
    }
    return m;
  }, [usable, k.keyInfos]);
  const voterKey = [...voterOf.values()].join(',');
  const current = useAsync(() => (voterKey ? src.votesOf(label, state, voterKey.split(',')) : Promise.resolve(new Map<string, Choice | null>())), [src, label, state, voterKey, sentCount]);

  const [choice, setChoice] = useState<Choice | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null); // null = all
  const [mode, setMode] = useState<'now' | 'spread'>('now');
  const [withinH, setWithinH] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sameNetwork = registry.coreNetwork === registry.platformNetwork;
  if (!sameNetwork) {
    return (
      <section className="panel mnvote" aria-labelledby="cvote-title" data-testid="contest-vote-panel">
        <h2 id="cvote-title">Your vote</h2>
        <p className="muted">This profile reads masternodes from {registry.coreNetwork} but contests from {registry.platformNetwork} Platform, so its masternodes cannot vote here. Switch to the Mainnet or Testnet profile in Settings to vote.</p>
      </section>
    );
  }

  const header = (
    <header className="mnvote-head">
      <h2 id="cvote-title">Your vote</h2>
      {k.demo && k.status === 'open' && <span className="tag tag-demo">Demo: votes aren't sent</span>}
    </header>
  );
  const kept = mine.length > 0 && <KeptVotes votes={mine} now={now} nameOf={nameOf} labels={labels} onCancel={votes.cancel} onSendNow={votes.sendNow} />;

  if (k.status !== 'open' || !k.keyring) {
    return (
      <section className="panel mnvote" aria-labelledby="cvote-title" data-testid="contest-vote-panel">
        {header}
        <div className="vempty" data-testid="vote-cta">
          <p>{k.status === 'signed-out' ? 'Masternode owners: sign in and add your voting keys to vote here.' : 'Unlock your masternode keyring to vote here.'}</p>
          <Link className="btn" to="/masternodes">
            My masternodes
          </Link>
        </div>
        {kept}
      </section>
    );
  }
  if (!usable.length) {
    const finding = k.mns.phase === 'loading' || k.mns.phase === 'idle';
    return (
      <section className="panel mnvote" aria-labelledby="cvote-title" data-testid="contest-vote-panel">
        {header}
        <div className="vempty" data-testid="vote-none">
          {finding ? (
            <p>
              <span className="spinner" aria-hidden="true" /> Finding your masternodes…
            </p>
          ) : k.mns.phase === 'error' ? (
            <p className="error">Your masternodes could not be looked up: {k.mns.error}</p>
          ) : (
            <p>None of your keyring’s masternodes can vote.</p>
          )}
          <Link className="btn btn-s" to="/masternodes">
            My masternodes
          </Link>
        </div>
        {kept}
      </section>
    );
  }

  const sel = (m: OwnedMasternode) => (selected ? selected.has(m.proTxHash) : true);
  const chosen = usable.filter(sel);
  const waitingFor = (m: OwnedMasternode) => mine.find((v) => v.proTxHash === m.proTxHash && (v.status === 'waiting' || v.status === 'sending'));
  // a masternode whose current vote (or the one waiting here) already is this choice is left out: it would spend one of its changes
  const already = (m: OwnedMasternode) => {
    if (!choice) return false;
    const w = waitingFor(m);
    if (w) return sameChoice(w.choice, choice);
    const cur = current.data?.get(voterOf.get(m.proTxHash) ?? '');
    return !!cur && sameChoice(cur, choice);
  };
  const toSend = choice ? chosen.filter((m) => voterOf.has(m.proTxHash) && !already(m)) : [];
  const uncompressed = chosen.filter((m) => !voterOf.has(m.proTxHash));
  const win = spreadWindow(now, endsAt, network);
  const latest = win ? Math.min(win.latest, now + (withinH ? Number(withinH) * 3_600_000 : DEFAULT_SPREAD_MS)) : null;
  const spreadOk = mode !== 'spread' || (!!win && !!latest && latest > win.earliest);
  const hint = !choice
    ? 'Choose who gets the name, abstain or lock.'
    : !chosen.length
      ? 'Select at least one masternode.'
      : current.loading
        ? 'Reading your masternodes’ current votes…'
        : !toSend.length
          ? 'Your selected masternodes already vote this way.'
          : !spreadOk
            ? 'The contest closes too soon to spread votes out. Send them now instead.'
            : null;

  const go = async () => {
    if (!choice || !toSend.length) return;
    setBusy(true);
    setError(null);
    try {
      const list = toSend;
      const t0 = Date.now();
      const times = mode === 'spread' && win && latest ? releaseTimes(list.length, { earliest: win.earliest, latest }, cryptoRand32) : list.map(() => t0);
      // nonces first (the network is read before any key is touched): Platform's, or past what this browser already holds
      const nonces = new Map<string, bigint>();
      if (src.live) {
        await Promise.all(
          list.map(async (m) => {
            const voter = voterOf.get(m.proTxHash)!;
            const held = votes.held.filter((v) => v.voterId === voter && v.label !== label && (v.status === 'waiting' || v.status === 'sending')).map((v) => BigInt(v.nonce));
            const onChain = await src.nonceOf(voter);
            nonces.set(m.proTxHash, [onChain, ...held].reduce((a, b) => (b > a ? b : a), 0n) + 1n);
          }),
        );
      }
      const mod = src.live ? await import('@dashevo/evo-sdk') : null;
      // the keys: copied now (the keyring may have locked during the reads above), used synchronously, wiped
      const kNow = kRef.current;
      if (kNow.status !== 'open' || !kNow.keyring) throw new Error('The keyring locked. Unlock it and vote again.');
      const { keyOf, wipe } = castKeys(kNow.keyring.content.keys, kNow.mns.owned);
      const signed: HeldVote[] = [];
      try {
        list.forEach((m, i) => {
          const voterId = voterOf.get(m.proTxHash)!;
          const nonce = nonces.get(m.proTxHash) ?? 0n;
          let st = '';
          if (mod) {
            const key = keyOf(m);
            if (!key) throw new Error(`No key for masternode ${m.proTxHash.slice(0, 12)}…`);
            assertUsableKey(key.privateKey);
            st = base64.encode(signVote(mod, network, { proTxHash: m.proTxHash, privateKey: key.privateKey, compressed: key.compressed, label, choice, nonce }));
          }
          signed.push({
            id: crypto.randomUUID(),
            network,
            label,
            proTxHash: m.proTxHash,
            voterId,
            weight: m.type === 'evo' ? 4 : 1,
            choice,
            st,
            nonce: nonce.toString(),
            mode,
            releaseAt: times[i]!,
            endsAt,
            status: 'waiting',
            tries: 0,
          });
        });
      } finally {
        wipe();
      }
      votes.add(signed);
      setChoice(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (m: OwnedMasternode, on: boolean) => {
    const s = new Set(selected ?? usable.map((x) => x.proTxHash));
    if (on) s.add(m.proTxHash);
    else s.delete(m.proTxHash);
    setSelected(s);
  };
  const options: Array<{ c: Choice; text: string; sub: string }> = [
    ...state.contenders.map((x) => ({ c: { kind: 'contender', identityId: x.identityId } as Choice, text: nameOf(x.identityId), sub: x.requested ? `Asked for ${x.requested}` : 'Contender' })),
    { c: { kind: 'abstain' }, text: 'Abstain', sub: 'Counted, but for nobody' },
    { c: { kind: 'lock' }, text: 'Lock', sub: 'Nobody gets the name' },
  ];
  const n = toSend.length;
  const buttonText = busy ? 'Signing…' : `${mode === 'spread' ? 'Schedule' : 'Sign and send'} ${n || ''} ${n === 1 ? 'vote' : 'votes'}`.replace('  ', ' ');

  return (
    <section className="panel mnvote" aria-labelledby="cvote-title" data-testid="contest-vote-panel">
      {header}
      <fieldset className="cvote-choices" data-testid="contest-choice">
        <legend className="visually-hidden">Your vote</legend>
        {options.map((o) => (
          <label key={choiceKey(o.c)} className={`cvote-opt${choice && sameChoice(choice, o.c) ? ' on' : ''}`}>
            <input type="radio" name={`cvote-${label}`} checked={!!choice && sameChoice(choice, o.c)} onChange={() => setChoice(o.c)} />
            <span>
              <b>{o.text}</b>
              <span className="small muted">{o.sub}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <details className="vcomp-mns" data-testid="vote-mns">
        <summary>
          <span>{chosen.length === usable.length ? `With ${usable.length === 1 ? 'your masternode' : `all ${usable.length} of your masternodes`}` : `With ${chosen.length} of ${usable.length} masternodes`}</span>
          <span className="vcomp-change">Change</span>
        </summary>
        {usable.length > 1 && (
          <label className="check vcomp-all">
            <input type="checkbox" checked={chosen.length === usable.length} onChange={(e) => setSelected(e.target.checked ? null : new Set())} /> All masternodes
          </label>
        )}
        <ul className="vmn-list">
          {usable.map((m) => {
            const cur = current.data?.get(voterOf.get(m.proTxHash) ?? '');
            const w = waitingFor(m);
            return (
              <li key={m.proTxHash} className={`vmn${sel(m) ? ' vmn-on' : ''}`} data-testid="vote-mn-row" data-protx={m.proTxHash}>
                <label className="vmn-pick">
                  <input type="checkbox" checked={sel(m)} onChange={(e) => toggle(m, e.target.checked)} aria-label={`Vote with ${mnName(m, labels)}`} />
                  <span className="vmn-name">{mnName(m, labels)}</span>
                  {m.type === 'evo' && <span className="chip vmn-evo">Evonode ×4</span>}
                </label>
                <div className="vmn-state">
                  <span className="vmn-cur" data-testid="current-vote">
                    <span className="vmn-k">Now</span> {current.loading ? <span className="muted">…</span> : current.error ? <span className="muted">unknown</span> : choiceText(cur, nameOf)}
                  </span>
                  {w && (
                    <span className="vmn-pend" data-testid="pending-vote">
                      <span className="vmn-k">Waiting</span> {choiceText(w.choice, nameOf)}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {current.error && <p className="small error">Their current votes could not be read: {current.error}</p>}
      </details>

      <details className="vwhen">
        <summary>
          <span>{mode === 'spread' ? 'Spread out over time' : 'Send now'}</span>
          <span className="vcomp-change">Options</span>
        </summary>
        <fieldset className="vwhen-opts">
          <legend className="visually-hidden">When to send</legend>
          <label className={`vwhen-opt${mode === 'now' ? ' on' : ''}`}>
            <input type="radio" name={`cvote-when-${label}`} checked={mode === 'now'} onChange={() => setMode('now')} />
            <span>
              <b>Now</b>
              <span className="small muted">Platform counts each vote within seconds.</span>
            </span>
          </label>
          <label className={`vwhen-opt${mode === 'spread' ? ' on' : ''}${win ? '' : ' off'}`}>
            <input type="radio" name={`cvote-when-${label}`} checked={mode === 'spread'} onChange={() => setMode('spread')} disabled={!win} data-testid="vote-spread" />
            <span>
              <b>Spread out (more private)</b>
              <span className="small muted">
                {win
                  ? 'Each masternode votes at its own random time, so they are not seen voting together. There is no relay for these votes: this browser sends them, so they only go out while govhub is open here.'
                  : 'The contest closes too soon to spread votes out.'}
              </span>
            </span>
          </label>
        </fieldset>
        {mode === 'spread' && win && (
          <div className="vwhen-more">
            <label>
              Send within the next{' '}
              <input type="number" min={0.1} step={0.1} value={withinH} onChange={(e) => setWithinH(e.target.value)} placeholder={String(Math.round((Math.min(win.latest - now, DEFAULT_SPREAD_MS) / 3_600_000) * 10) / 10)} className="vote-hours" data-testid="vote-within" /> hours
            </label>
            <p className="small muted">The longer the window, the harder they are to link. Signed votes wait in this browser until they go out; one whose time passes while govhub is closed goes out soon after you open it again, before voting closes.</p>
          </div>
        )}
      </details>

      <div className="vgo">
        <button type="button" className="btn btn-primary btn-l vgo-btn" disabled={busy || !!hint} onClick={go} data-testid="vote-send">
          {buttonText}
        </button>
        {!hint && (
          <p className="vgo-sum small muted" data-testid="vote-summary">
            {k.demo
              ? 'Signed in your browser. In demo mode nothing is sent.'
              : mode === 'spread' && latest
                ? `Signed now, sent at random times before ${fmtTime(latest / 1000)} while govhub is open in this browser.`
                : 'Signed in your browser and sent straight to Platform.'}
          </p>
        )}
        {hint && (
          <p className="small muted" data-testid="vote-send-hint">
            {hint}
          </p>
        )}
        {uncompressed.length > 0 && <p className="small muted">{formatInt(uncompressed.length)} of these masternodes use an old uncompressed voting key, which Platform does not accept for votes.</p>}
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
      </div>
      <p className="small muted">
        Each masternode can change its vote on a name up to {VOTE_CHANGES} times; its last vote counts. Its vote is public on Platform.
      </p>
      {kept}
    </section>
  );
}

function KeptVotes({ votes, now, nameOf, labels, onCancel, onSendNow }: { votes: readonly HeldVote[]; now: number; nameOf: (id: string) => string; labels: ReadonlyMap<string, string>; onCancel(id: string): void; onSendNow(ids: readonly string[]): void }) {
  const waiting = votes.filter((v) => v.status === 'waiting' && v.releaseAt > now);
  return (
    <div className="cvote-kept" data-testid="kept-votes">
      <h3 className="small">Votes from this browser</h3>
      <ul className="vmn-list">
        {votes.map((v) => {
          const l = heldLine(v, now);
          return (
            <li key={v.id} className="vmn" data-testid="kept-vote">
              <span className="vmn-name">{mnName({ proTxHash: v.proTxHash }, labels)}</span>
              <span>{choiceText(v.choice, nameOf)}</span>
              <Badge tone={l.tone}>{l.badge}</Badge>
              {v.status === 'waiting' && (
                <span className="cvote-acts">
                  {v.releaseAt > now && (
                    <button type="button" className="btn btn-s" onClick={() => onSendNow([v.id])}>
                      Send now
                    </button>
                  )}
                  <button type="button" className="btn btn-s" onClick={() => onCancel(v.id)}>
                    Cancel
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {waiting.length > 1 && (
        <button type="button" className="linkish small" onClick={() => onSendNow(waiting.map((v) => v.id))}>
          Send all {waiting.length} now
        </button>
      )}
    </div>
  );
}
