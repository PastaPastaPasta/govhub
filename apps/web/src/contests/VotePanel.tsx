// Masternode voting on one username contest: pick a choice and masternodes, then send now or spread the votes out. The keys come from
// the open keyring, or (without an account) from voting keys pasted into this tab (GuestKeys.tsx). Either way they are copied for the
// signing only (voting/gate.ts castKeys: wiped right after, and by a sign-out), so the keyring's lock rules (D-015, D-029) hold as for
// proposal votes. What leaves the signing is signed votes, never keys.
import { base64 } from '@scure/base';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { SecretField } from '../auth/SecretField.tsx';
import { errText, formatInt } from '../lib/format.ts';
import { useAsync } from '../ui/hooks.ts';
import { Badge, fmtTime, mnName, useLabels, useNow } from '../ui/vote/common.tsx';
import { castKeys } from '../voting/gate.ts';
import { useKeyring } from '../voting/KeyringContext.tsx';
import { assertUsableKey, type OwnedMasternode, type VotingKeyInfo } from '../voting/masternodes.ts';
import { cryptoRand32 } from '../voting/plan.ts';
import type { Tone } from '../voting/status.ts';
import { useContestVotes } from './ContestVotes.tsx';
import { useGuestKeys } from './GuestKeys.tsx';
import { DEFAULT_SPREAD_MS, GUEST_OWNER, nextNonce, releaseTimes, spreadWindow, type HeldVote } from './held.ts';
import { VOTE_CHANGES, type ContestState } from './model.ts';
import { useContestSource } from './useContests.ts';
import { choiceKey, NONCE_MASK, NONCE_WINDOW, sameChoice, signVote, voterIdOf, votingKeyHash, type Choice } from './vote.ts';
import '../voting/voting.css';

/** Where the keys come from: the open keyring, or keys pasted into this tab. */
interface Signer {
  kind: 'keyring' | 'guest';
  owned: readonly OwnedMasternode[];
  keyInfos: readonly VotingKeyInfo[];
  /** fresh copies for one signing; null when the keys are gone (locked, forgotten) */
  copyKeys(): ReturnType<typeof castKeys> | null;
}

function choiceText(c: Choice | null | undefined, nameOf: (identityId: string) => string): string {
  if (c === undefined) return 'unknown';
  if (!c) return 'No vote';
  if (c.kind === 'abstain') return 'Abstain';
  if (c.kind === 'lock') return 'Lock';
  return nameOf(c.identityId);
}

function heldLine(v: HeldVote, now: number): { badge: string; tone: Tone } {
  if (v.status === 'sent') return { badge: v.note ?? 'Sent', tone: 'ok' };
  if (v.status === 'failed') return { badge: v.note ?? 'Not sent', tone: 'bad' };
  if (v.status === 'waiting' && v.nextTryAt && v.nextTryAt > now) return { badge: `${v.note ? `${v.note} ` : ''}Trying again at ${fmtTime(v.nextTryAt / 1000)}`, tone: 'wait' };
  if (v.status === 'waiting' && v.releaseAt > now) return { badge: `Goes out at ${fmtTime(v.releaseAt / 1000)}`, tone: 'wait' };
  return { badge: 'Sending…', tone: 'progress' };
}

export function ContestVotePanel({ label, state, endsAt, nameOf }: { label: string; state: ContestState; endsAt: number | null; nameOf: (identityId: string) => string }) {
  const { registry } = useApp();
  const k = useKeyring();
  const guest = useGuestKeys();
  const votes = useContestVotes();
  const labels = useLabels();
  const now = useNow(10_000);
  const mine = votes.held.filter((v) => v.label === label);
  const shell = (body: ReactNode) => (
    <section className="panel mnvote" aria-labelledby="cvote-title" data-testid="contest-vote-panel">
      <header className="mnvote-head">
        <h2 id="cvote-title">Your vote</h2>
        {k.demo && k.status === 'open' && <span className="tag tag-demo">Demo: votes aren't sent</span>}
      </header>
      {body}
      {mine.length > 0 && <KeptVotes votes={mine} now={now} nameOf={nameOf} labels={labels} onCancel={(id) => void votes.cancel(id)} onSendNow={(ids) => void votes.sendNow(ids)} />}
    </section>
  );

  if (registry.coreNetwork !== registry.platformNetwork) {
    return shell(<p className="muted">This profile reads masternodes from {registry.coreNetwork} but contests from {registry.platformNetwork} Platform, so its masternodes cannot vote here. Switch to the Mainnet or Testnet profile in Settings to vote.</p>);
  }

  const keyring: Signer | null =
    k.status === 'open' && k.keyring
      ? {
          kind: 'keyring',
          owned: k.mns.owned,
          keyInfos: k.keyInfos,
          copyKeys: () => (k.keyring ? castKeys(k.keyring.content.keys, k.mns.owned) : null),
        }
      : null;
  const pasted: Signer | null = guest.status === 'ready' ? { kind: 'guest', owned: guest.owned, keyInfos: guest.keyInfos, copyKeys: guest.copyKeys } : null;
  const signer = keyring ?? pasted;

  if (!signer) {
    return shell(
      <>
        <div className="vempty" data-testid="vote-cta">
          <p>{k.status === 'signed-out' ? 'Masternode owners: sign in and add your voting keys to vote here.' : 'Unlock your masternode keyring to vote here.'}</p>
          <Link className="btn" to="/masternodes">
            My masternodes
          </Link>
        </div>
        {k.status !== 'open' && <GuestKeyForm />}
      </>,
    );
  }
  if (signer.kind === 'keyring' && !signer.owned.some((m) => m.valid)) {
    const finding = k.mns.phase === 'loading' || k.mns.phase === 'idle';
    return shell(
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
      </div>,
    );
  }
  return shell(<Composer label={label} state={state} endsAt={endsAt} nameOf={nameOf} signer={signer} />);
}

function Composer({ label, state, endsAt, nameOf, signer }: { label: string; state: ContestState; endsAt: number | null; nameOf: (identityId: string) => string; signer: Signer }) {
  const { registry } = useApp();
  const k = useKeyring();
  const guest = useGuestKeys();
  const src = useContestSource();
  const votes = useContestVotes();
  const labels = useLabels();
  const now = useNow(10_000);
  const network = registry.platformNetwork;
  const signerRef = useRef(signer);
  signerRef.current = signer;

  const mine = votes.held.filter((v) => v.label === label);
  const sentCount = mine.filter((v) => v.status === 'sent').length;
  const usable = useMemo(() => signer.owned.filter((m) => m.valid), [signer.owned]);
  // the voting identity of each masternode, from its key's public hash (no private key): compressed keys only
  const voterOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const mn of usable) {
      const info = signer.keyInfos[mn.keyIndex];
      if (info?.compressed) m.set(mn.proTxHash, voterIdOf(mn.proTxHash, info.pubKeyHash));
    }
    return m;
  }, [usable, signer.keyInfos]);
  const voterKey = [...voterOf.values()].join(',');
  // a vote that went out from here re-reads them (the sender dropped the cached contest)
  const current = useAsync(() => (voterKey ? src.votesOf(label, voterKey.split(',')) : Promise.resolve(new Map<string, Choice | null>())), [src, label, voterKey, sentCount]);

  const [choice, setChoice] = useState<Choice | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null); // null = all
  const [mode, setMode] = useState<'now' | 'spread'>('now');
  const [withinH, setWithinH] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const hint = (() => {
    if (!choice) return 'Choose who gets the name, abstain or lock.';
    if (!chosen.length) return 'Select at least one masternode.';
    if (current.loading) return 'Reading your masternodes’ current votes…';
    if (!toSend.length) return 'Your selected masternodes already vote this way.';
    if (mode === 'spread' && !(win && latest !== null && latest > win.earliest)) return 'The contest closes too soon to spread votes out. Send them now instead.';
    return null;
  })();

  const go = async () => {
    if (!choice || !toSend.length) return;
    setBusy(true);
    setError(null);
    try {
      // what is held before the reads: a vote of ours that goes out during them leaves storage but keeps its nonce taken
      const before = votes.snapshot();
      const t0 = Date.now();
      const times = mode === 'spread' && win && latest ? releaseTimes(toSend.length, { earliest: win.earliest, latest }, cryptoRand32) : toSend.map(() => t0);
      // Platform's nonces are read before any key is touched
      const onChain = new Map<string, bigint>();
      if (src.live) await Promise.all(toSend.map(async (m) => onChain.set(m.proTxHash, await src.nonceOf(voterOf.get(m.proTxHash)!))));
      const mod = src.live ? await import('@dashevo/evo-sdk') : null;
      // from here on nothing awaits until the votes are signed and the copies wiped
      const keys = signerRef.current.copyKeys();
      if (!keys) throw new Error(signer.kind === 'keyring' ? 'The keyring locked. Unlock it and vote again.' : 'The pasted keys were forgotten. Paste them again to vote.');
      const held = votes.snapshot();
      const signed: HeldVote[] = [];
      const skipped: string[] = [];
      try {
        toSend.forEach((m, i) => {
          const key = keys.keyOf(m);
          if (!key) throw new Error(`No key for masternode ${m.proTxHash.slice(0, 12)}…`);
          assertUsableKey(key.privateKey);
          // the voter the nonce was read for must be the one this key signs as (the keys may have changed during the reads)
          const voterId = voterIdOf(m.proTxHash, votingKeyHash(key.privateKey));
          if (voterId !== voterOf.get(m.proTxHash)) throw new Error('Your voting keys changed while the votes were being prepared. Vote again.');
          const nonce = src.live ? nextNonce(onChain.get(m.proTxHash) ?? 0n, [...before, ...held, ...signed], voterId, NONCE_WINDOW, NONCE_MASK) : 0n;
          if (nonce === null) return void skipped.push(mnName(m, labels));
          signed.push({
            id: crypto.randomUUID(),
            network,
            owner: votes.owner,
            label,
            proTxHash: m.proTxHash,
            voterId,
            choice,
            st: mod ? base64.encode(signVote(mod, { proTxHash: m.proTxHash, privateKey: key.privateKey, compressed: key.compressed, label, choice, nonce })) : '',
            nonce: nonce.toString(),
            mode,
            releaseAt: times[i]!,
            endsAt,
            status: 'waiting',
            tries: 0,
          });
        });
      } finally {
        keys.wipe();
      }
      if (signed.length) {
        try {
          await votes.add(signed);
        } catch {
          throw new Error('Your browser could not store the signed votes, so nothing was sent. Free some storage for this site and vote again.');
        }
      }
      if (skipped.length) setError(`${skipped.join(', ')}: has too many votes waiting in this browser (Platform takes ${NONCE_WINDOW} at most). Send or cancel some of them first.`);
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
  const buttonText = busy ? 'Signing…' : [mode === 'spread' ? 'Schedule' : 'Sign and send', n || null, n === 1 ? 'vote' : 'votes'].filter(Boolean).join(' ');

  return (
    <>
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
                    <span className="vmn-k">Now</span> {current.loading ? <span className="muted">…</span> : current.error ? <span className="muted">unknown</span> : choiceText(current.data?.get(voterOf.get(m.proTxHash) ?? ''), nameOf)}
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
        {signer.kind === 'guest' && (
          <p className="small muted">
            From voting keys pasted into this tab.{' '}
            <button type="button" className="linkish" onClick={guest.forget} data-testid="guest-forget">
              Forget the keys
            </button>
          </p>
        )}
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
                  ? 'Each masternode votes at its own random time, so the votes do not land on Platform together. There is no relay for these votes: this browser sends them, so they only go out while govhub is open here.'
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
            <p className="small muted">
              The longer the window, the harder they are to link. The signed votes wait in this browser’s storage until they go out, even if you sign out; one whose time passes while govhub is closed goes out soon after you open it again, before voting closes. The Platform node your browser sends through still sees all of them come from you.
            </p>
          </div>
        )}
      </details>

      <div className="vgo">
        <button type="button" className="btn btn-primary btn-l vgo-btn" disabled={busy || !!hint} onClick={go} data-testid="vote-send">
          {buttonText}
        </button>
        {!hint && (
          <p className="vgo-sum small muted" data-testid="vote-summary">
            {k.demo && signer.kind === 'keyring'
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
      <p className="small muted">Each masternode can change its vote on a name up to {VOTE_CHANGES} times; its last vote counts. Its vote is public on Platform.</p>
    </>
  );
}

/** Pasting voting keys without an account, as vote.dashhq.org allowed. */
function GuestKeyForm() {
  const guest = useGuestKeys();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <p className="small muted">
        No account?{' '}
        <button type="button" className="linkish" onClick={() => setOpen(true)} data-testid="guest-open">
          Vote with a voting key instead
        </button>
      </p>
    );
  const find = async () => {
    await guest.add(text);
    setText('');
  };
  return (
    <div className="form cvote-guest" data-testid="guest-form">
      <SecretField label="Voting keys" what="voting key" value={text} onChange={setText} testId="guest-key" placeholder="One voting private key per line (WIF or hex)" />
      <p className="small muted">The keys stay in this tab’s memory only: never saved, never sent. They are forgotten after 15 minutes without use, when you close the tab, or when you click Forget.</p>
      <div className="cvote-acts">
        <button type="button" className="btn" onClick={() => void find()} disabled={guest.status === 'looking' || !text.trim()} data-testid="guest-find">
          {guest.status === 'looking' ? 'Finding your masternodes…' : 'Find my masternodes'}
        </button>
      </div>
      {guest.error && (
        <p className="error small" role="alert">
          {guest.error}
        </p>
      )}
    </div>
  );
}

function KeptVotes({ votes, now, nameOf, labels, onCancel, onSendNow }: { votes: readonly HeldVote[]; now: number; nameOf: (id: string) => string; labels: ReadonlyMap<string, string>; onCancel(id: string): void; onSendNow(ids: readonly string[]): void }) {
  const waiting = votes.filter((v) => v.status === 'waiting' && v.releaseAt > now);
  return (
    <div className="cvote-kept" data-testid="kept-votes">
      <h3 className="small">Votes from this browser{votes[0]?.owner === GUEST_OWNER ? ' (pasted keys)' : ''}</h3>
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
