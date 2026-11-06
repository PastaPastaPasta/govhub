// "Vote on this proposal": the proposal page's vote, near the top. It names what is being voted on (the title, the ask, where it stands),
// so a masternode arriving at #vote never has to scroll back to see it. Yes / No / Abstain, then the way to sign that fits what the visitor
// has: the keyring's composer when signed in with voting keys, the voting keys pasted for this tab (contest pages take the same keys),
// or offline signing with the Dash Core command filled in. `?mn=<proTxHash>` (from a masternode's votes page) carries which masternode
// is voting: its current vote, its voting address for offline signing, and the way back. Nothing here is stored, and no key or
// signature ever goes into a URL.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useApp } from '../../app/context.tsx';
import { useForum } from '../../app/forum.tsx';
import { SecretField } from '../../auth/SecretField.tsx';
import { useGuestKeys } from '../../contests/GuestKeys.tsx';
import type { BridgeVote } from '../../data/bridge.ts';
import type { Proposal } from '../../data/types.ts';
import { errText, formatDuration, shortHash } from '../../lib/format.ts';
import { useKeyring } from '../../voting/KeyringContext.tsx';
import { votingKeyId, type OwnedMasternode } from '../../voting/masternodes.ts';
import { isOpen, type WatchedVote } from '../../voting/pending.ts';
import { mnId, offlineVoteTime, signPlanned, type CurrentVote, type Outcome } from '../../voting/plan.ts';
import { describeVote, relaySummary, voteButtonText } from '../../voting/status.ts';
import { Link } from '../Link.tsx';
import { openSignIn } from '../SignIn.tsx';
import { Slug } from '../Slug.tsx';
import { bridgeVotesFor, latestKnownVote, OfflineSign, OfflineSignBody, OutcomePicker, VoteComposer } from '../VotePanel.tsx';
import { Badge, fmtTime, mnName, OutcomeChip, OUTCOME_LABEL, useLabels } from './common.tsx';
import { useMasternodeVotes, type MnLookup, type VoteCell } from './useMasternodeVotes.ts';
import { VoteTracker } from './VoteTracker.tsx';
import '../../voting/voting.css';

/** The masternode a visitor arrived with (`?mn=`), when it is a well-formed ProTx hash. */
export const mnParam = (search: string): string | null => {
  const v = new URLSearchParams(search).get('mn')?.toLowerCase() ?? '';
  return /^[0-9a-f]{64}$/.test(v) ? v : null;
};

interface MnContext {
  proTx: string;
  lookup: MnLookup;
  cell: VoteCell | undefined;
}

/** What the vote is on, as the page heads it: the title, and the ask and standing when the proposal's fields match its hash. */
export interface VoteSubject {
  title: string;
  /** "4,832 DASH per month" */
  ask: string | null;
  /** "1 of 4 payments left" */
  payments: string | null;
  standing: { text: string; tone: string } | null;
}

interface BlockProps {
  proposal: Proposal;
  subject: VoteSubject;
  closesIn: number | null;
  onVerify(): void;
}

export function ProposalVoteBlock({ mn, ...props }: BlockProps & { mn: string | null }) {
  return mn ? <WithMasternode {...props} proTx={mn} /> : <VoteBlock {...props} ctx={null} />;
}

function WithMasternode({ proTx, ...props }: BlockProps & { proTx: string }) {
  const one = useMemo(() => [props.proposal], [props.proposal]);
  const v = useMasternodeVotes(proTx, one);
  return <VoteBlock {...props} ctx={{ proTx, lookup: v.lookup, cell: v.cells.get(props.proposal.govHash) }} />;
}

/** The proposal being voted on: its title and exact name, what it asks and where it stands. */
function Subject({ proposal, subject }: { proposal: Proposal; subject: VoteSubject }) {
  const facts = [subject.ask, subject.payments].filter(Boolean).join(' · ');
  return (
    <div className="pvote-subject" data-testid="vote-subject">
      <p className="pvote-subject-title">
        <bdi>{subject.title}</bdi>
      </p>
      <p className="pvote-subject-facts small">
        <span className="mono-ish pvote-subject-name">
          <Slug name={proposal.name} />
        </span>
        {facts && <span>{facts}</span>}
        {subject.standing && (
          <span className={`mnv-status${subject.standing.tone ? ` mnv-${subject.standing.tone}` : ''}`}>
            <span className="dot" aria-hidden="true" />
            {subject.standing.text}
          </span>
        )}
      </p>
    </div>
  );
}

type Way = 'offline' | 'paste' | 'account';

function VoteBlock({ proposal, subject, ctx, closesIn, onVerify }: BlockProps & { ctx: MnContext | null }) {
  const k = useKeyring();
  const guest = useGuestKeys();
  const signedIn = !!useForum().session;
  const [outcome, setOutcome] = useState<Outcome | 0>(0);
  const [chosenWay, setWay] = useState<Way>(signedIn ? 'account' : 'offline');
  // pasted keys are for visitors without an account (signing in wipes them: the keyring takes over)
  const ways = WAYS.filter((w) => !(signedIn && w.id === 'paste'));
  const way = ways.some((w) => w.id === chosenWay) ? chosenWay : ways[0]!.id;
  const is = (m: { proTxHash: string; valid: boolean }) => m.valid && (!ctx || m.proTxHash.toLowerCase() === ctx.proTx);
  const keyring = k.status === 'open' && (!ctx || k.mns.owned.some(is) || k.mns.phase === 'loading');
  const pasted = !keyring && guest.status === 'ready' && guest.owned.some(is);
  const address = ctx?.lookup.kind === 'found' ? ctx.lookup.mn.votingAddress : '';
  // a masternode's "Vote" lands on #vote: the block, once the proposal has rendered
  const ref = useRef<HTMLElement>(null);
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === '#vote') ref.current?.scrollIntoView({ block: 'start' });
  }, [hash]);
  return (
    <section ref={ref} id="vote" className="panel dh-card pvote" aria-labelledby="pvote-title" data-testid="mn-vote-panel">
      <header className="pvote-head">
        <h2 id="pvote-title">Vote on this proposal</h2>
        {closesIn !== null && <span className="small muted">{closesIn > 0 ? `Voting closes in ${formatDuration(closesIn)}` : 'Votes now count toward the next payout'}</span>}
        {k.demo && k.status === 'open' && <span className="tag dh-badge tag-demo">Demo: votes aren't sent</span>}
      </header>
      <Subject proposal={proposal} subject={subject} />
      {ctx && <MasternodeLine ctx={ctx} />}
      {k.error && (keyring || pasted || way !== 'account') && (
        <p className="error small" role="alert">
          {k.error}
        </p>
      )}
      {keyring ? (
        <>
          <VoteComposer proposals={[proposal]} onVerify={onVerify} {...(ctx ? { onlyMn: ctx.proTx } : {})} />
          <OfflineSign proposal={proposal} address={address} />
        </>
      ) : pasted ? (
        // a new masternode or another set of pasted keys starts a fresh selection
        <PastedKeyVote key={`${ctx?.proTx ?? ''}|${guest.keyInfos.map((x) => x.keyId).join()}`} proposal={proposal} outcome={outcome} setOutcome={setOutcome} only={ctx?.proTx ?? null} />
      ) : (
        <>
          <OutcomePicker label="Your vote" value={outcome} onChange={setOutcome} testId="vote-choice" />
          <WayPicker ways={ways} way={way} setWay={setWay} />
          {way === 'offline' ? (
            outcome ? <OfflineSignBody proposal={proposal} address={address} outcome={outcome} /> : null
          ) : way === 'paste' ? (
            <PasteKey ctx={ctx} />
          ) : (
            <AccountWay ctx={ctx} />
          )}
        </>
      )}
      <SentHere proposal={proposal} />
    </section>
  );
}

/** "As masternode d353cd…7eff, Evonode: its vote counts 4 times, Now: Yes", and the way back to its votes. */
function MasternodeLine({ ctx }: { ctx: MnContext }) {
  const { registry } = useApp();
  const mn = ctx.lookup.kind === 'found' ? ctx.lookup.mn : null;
  const network = registry.coreNetwork === 'testnet' ? 'Testnet' : 'Mainnet';
  const cell = ctx.cell;
  return (
    <div className="pvote-mn" data-testid="vote-mn-context">
      <p>
        <span className="muted">As masternode</span>{' '}
        <dashhq-hash value={ctx.proTx} label="ProTx hash">
          {ctx.proTx}
        </dashhq-hash>
        {mn && <span className="muted small">{mn.type === 'evo' ? 'Evonode: its vote counts 4 times' : 'Regular masternode'}</span>}
        {mn && !mn.valid && <span className="tag dh-badge tag-fail dh-badge--bad">PoSe-banned: its votes are not counted</span>}
        {mn && (
          <span className="pvote-now small">
            <span className="muted">Now</span>{' '}
            {!cell || cell.kind === 'waiting' ? <span className="muted">reading…</span> : cell.kind === 'unread' ? <span className="muted">couldn’t read</span> : <OutcomeChip outcome={cell.kind === 'voted' ? cell.outcome : undefined} />}
          </span>
        )}
      </p>
      {ctx.lookup.kind === 'absent' && <p className="small muted">It isn’t in the {network} masternode list the governance data service reports, so it can’t vote here.</p>}
      {ctx.lookup.kind === 'error' && <p className="small muted">Its details couldn’t be read just now ({ctx.lookup.message}); you can still vote below.</p>}
      <p className="small pvote-mn-links">
        <Link to={`/masternodes/${ctx.proTx}`} data-testid="vote-mn-back" className="dh-link">
          ‹ Its votes on every proposal
        </Link>
        <Link to="." relative="path" className="muted dh-link" data-testid="vote-mn-clear">
          Vote with another masternode
        </Link>
      </p>
    </div>
  );
}

const WAYS: Array<{ id: Way; label: string; line: string }> = [
  { id: 'offline', label: 'Sign offline', line: 'No account, and the key never enters this page: you sign in Dash Core or with a hardware wallet.' },
  { id: 'paste', label: 'Paste key', line: 'No account. The key stays in this tab’s memory only and is forgotten after 15 minutes idle.' },
  { id: 'account', label: 'Account', line: 'Your keyring keeps voting keys encrypted on Dash Platform, and can spread votes out over time.' },
];

function WayPicker({ ways, way, setWay }: { ways: typeof WAYS; way: Way; setWay(w: Way): void }) {
  const current = ways.find((w) => w.id === way)!;
  return (
    <div className="pvote-ways">
      <p className="pvote-ways-label small muted" id="pvote-ways-label">
        How to sign it
      </p>
      <div className="dh-seg" role="group" aria-labelledby="pvote-ways-label" data-testid="vote-ways">
        {ways.map((w) => (
          <button key={w.id} type="button" aria-pressed={current.id === w.id} onClick={() => setWay(w.id)} data-way={w.id}>
            {w.label}
          </button>
        ))}
      </div>
      <p className="small muted" data-testid="vote-way-line">
        {current.line}
      </p>
    </div>
  );
}

function PasteKey({ ctx }: { ctx: MnContext | null }) {
  const guest = useGuestKeys();
  const [text, setText] = useState('');
  const find = async () => {
    await guest.add(text);
    setText('');
  };
  return (
    <div className="form pvote-paste" data-testid="vote-paste">
      <SecretField label="Voting private key, as Dash Core shows it" what="voting key" value={text} onChange={setText} testId="vote-paste-key" placeholder="One voting key per line (WIF or hex)" />
      <p className="kr-inline-warn small">Only the voting key. Never an owner, payout or collateral key: a voting key can only vote.</p>
      <div className="form-actions">
        <button type="button" className="btn dh-btn btn-primary dh-btn--primary" onClick={() => void find()} disabled={guest.status === 'looking' || !text.trim()} data-testid="vote-paste-find">
          {guest.status === 'looking' ? 'Finding its masternodes…' : ctx ? `Use it for ${shortHash(ctx.proTx, 6)}` : 'Find my masternodes'}
        </button>
      </div>
      {guest.error && (
        <p className="error small" role="alert">
          {guest.error}
        </p>
      )}
      {ctx && guest.status === 'ready' && !guest.owned.some((m) => m.proTxHash.toLowerCase() === ctx.proTx) && (
        <p className="vwarn small" role="status">
          That key votes for other masternodes, not {shortHash(ctx.proTx, 6)}. <Link to="." className="dh-link">Vote with those instead</Link>, or paste {shortHash(ctx.proTx, 6)}’s voting key.
        </p>
      )}
    </div>
  );
}

function AccountWay({ ctx }: { ctx: MnContext | null }) {
  const k = useKeyring();
  if (k.status === 'signed-out')
    return (
      <div className="pvote-account" data-testid="vote-account">
        <p className="small">
          An account here is a Dash Platform identity (about 0.005 DASH to create). It keeps your voting keys encrypted, so they are back when you sign in again,
          and signs the votes in your browser.
        </p>
        <button type="button" className="btn dh-btn" onClick={openSignIn} data-testid="vote-signin">
          Sign in or create an account
        </button>
      </div>
    );
  return (
    <div className="pvote-account" data-testid="vote-account">
      <p className="small">
        {k.status === 'checking'
          ? 'Looking for your keyring on Platform…'
          : k.status === 'absent'
            ? 'Your account has no voting keys yet. Add your masternodes once; Governance finds every masternode a voting key votes for.'
            : k.status === 'open'
              ? `Your keyring doesn’t hold ${ctx ? `masternode ${shortHash(ctx.proTx, 6)}` : 'a masternode that can vote'}. Add its voting key, or sign offline.`
              : 'Your keyring is locked. Unlock it with your recovery phrase or a passkey to vote from it.'}
      </p>
      {k.status !== 'checking' && (
        <Link className="btn dh-btn" to="/masternodes" data-testid="vote-keyring-link">
          {k.status === 'locked' || k.status === 'error' ? 'Unlock your keyring' : 'Add your masternodes'}
        </Link>
      )}
    </div>
  );
}

/**
 * Votes with the keys pasted for this tab. One send at a time: the bridge's vote set is read first, then (if the keys and network
 * are still the ones the visitor chose with) the keys are copied, every vote is signed at once, and the copies are wiped before
 * anything is sent. Each vote is timed after this masternode's latest known one (Core: one change an hour, the later one wins).
 */
function PastedKeyVote({ proposal, outcome, setOutcome, only }: { proposal: Proposal; outcome: Outcome | 0; setOutcome(o: Outcome | 0): void; only: string | null }) {
  const k = useKeyring();
  const guest = useGuestKeys();
  const { registry } = useApp();
  const labels = useLabels();
  const network = k.coreNetwork;
  const govHash = proposal.govHash;
  const usable = useMemo(() => guest.owned.filter((m) => m.valid), [guest.owned]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(usable.filter((m) => !only || m.proTxHash.toLowerCase() === only).map((m) => m.proTxHash)));
  const chosen = usable.filter((m) => selected.has(m.proTxHash));
  const [votes, setVotes] = useState<{ list: BridgeVote[] | null; error: string | null; loading: boolean }>({ list: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  const [notes, setNotes] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  // what the latest render sees: a send that waited on the bridge checks nothing changed meanwhile, and times against our newest votes
  const latest = useRef({ guest, watched: k.watched, network });
  latest.current = { guest, watched: k.watched, network };
  // Forget unmounts this view: a send waiting on the bridge then signs nothing, whatever was pasted meanwhile
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setVotes((v) => ({ ...v, loading: true }));
    bridgeVotesFor(registry, govHash).then(
      (list) => live && setVotes({ list, error: null, loading: false }),
      (e: unknown) => live && setVotes({ list: null, error: errText(e), loading: false }),
    );
    return () => {
      live = false;
    };
  }, [registry, govHash, nonce]);
  const now = Math.floor(Date.now() / 1000);
  const keyHash = (m: OwnedMasternode) => guest.keyInfos[m.keyIndex]?.pubKeyHash;
  /** Its vote as the bridge's vote set has it (signature checked here); ours on their way are not counted yet. */
  const counted = (m: OwnedMasternode, list: readonly BridgeVote[] | null, at: number) => {
    const h = keyHash(m);
    return h ? latestKnownVote(m, govHash, list, h, [], network, at) : undefined;
  };
  const latestKnown = (m: OwnedMasternode, list: readonly BridgeVote[] | null, watched: readonly WatchedVote[], at: number) => {
    const h = keyHash(m);
    return h ? latestKnownVote(m, govHash, list, h, watched, network, at) : undefined;
  };
  const onItsWay = (m: OwnedMasternode, watched: readonly WatchedVote[]) => watched.filter((w) => isOpen(w) && w.govHash === govHash && mnId(w) === mnId(m)).sort((a, b) => b.time - a.time)[0];
  const held = chosen.filter((m) => offlineVoteTime(now, latestKnown(m, votes.list, k.watched, now)).hourRule);

  const go = async () => {
    if (!outcome || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setNotes([]);
    const out: string[] = [];
    const start = latest.current;
    try {
      let list: BridgeVote[] | null;
      try {
        list = await bridgeVotesFor(registry, govHash);
      } catch (e) {
        out.push(`Your current votes could not be read from the governance data service (${errText(e)}), so nothing was signed.`);
        return;
      }
      const cur = latest.current;
      if (gone.current || cur.guest.status !== 'ready' || cur.guest.keyInfos !== start.guest.keyInfos || cur.network !== start.network) {
        out.push('The pasted keys or the network changed meanwhile, so nothing was signed.');
        return;
      }
      const at = Math.floor(Date.now() / 1000);
      const plan: Array<{ m: OwnedMasternode; prev: CurrentVote | undefined }> = [];
      for (const m of chosen) {
        const mine = onItsWay(m, cur.watched);
        if (mine?.outcome === outcome) out.push(`${mnName(m, labels)}: the ${OUTCOME_LABEL[outcome]} vote you sent is still on its way, so nothing more was sent.`);
        else if (!mine && counted(m, list, at)?.outcome === outcome) out.push(`${mnName(m, labels)} already voted ${OUTCOME_LABEL[outcome]}; nothing was sent for it.`);
        else plan.push({ m, prev: latestKnown(m, list, cur.watched, at) });
      }
      if (!plan.length) return;
      const copies = cur.guest.copyKeys();
      if (!copies) return;
      let signed: Array<Parameters<typeof k.submitSigned>[0]> = [];
      try {
        for (const { m, prev } of plan) {
          const key = copies.keyOf(m);
          if (!key) continue;
          // the key this masternode was matched to when the visitor chose: never another one that took its place
          if (votingKeyId(key.privateKey, key.compressed) !== start.guest.keyInfos[m.keyIndex]?.keyId) throw new Error('the pasted keys changed while the vote was being prepared');
          const t = offlineVoteTime(at, prev);
          const v = signPlanned({ mn: m, govHash, outcome, time: t.time, releaseAt: t.releaseAt, notes: [] }, key.privateKey, key.compressed, cur.network);
          signed.push({ ...v, network: cur.network, weight: m.type === 'evo' ? 4 : 1, prev: prev ?? null, ...(t.hourRule ? { hourRule: true } : {}) });
        }
      } catch (e) {
        signed = [];
        out.push(`Nothing was sent: ${errText(e)}.`);
      } finally {
        copies.wipe();
      }
      for (const v of signed) await k.submitSigned(v).catch(() => {});
    } finally {
      sendingRef.current = false;
      setSending(false);
      setNotes(out);
      setNonce((n) => n + 1);
    }
  };
  const toggle = (m: OwnedMasternode, on: boolean) => {
    const s = new Set(selected);
    if (on) s.add(m.proTxHash);
    else s.delete(m.proTxHash);
    setSelected(s);
  };
  const relays = relaySummary(k.relays, k.relayHealth);
  const blocked = sending || !!k.busy || !k.relays.length || !outcome || !chosen.length;
  return (
    <div className="vcomp" data-testid="vote-pasted">
      <OutcomePicker label="Your vote" value={outcome} onChange={setOutcome} testId="vote-choice" disabled={sending} />
      <div className="pvote-keys small">
        <p>
          With {usable.length === 1 ? 'the masternode' : `${chosen.length} of the ${usable.length} masternodes`} your pasted key votes for. The key is in this tab’s memory only.{' '}
          <button type="button" className="linkish dh-btn dh-btn--link" onClick={guest.forget} data-testid="vote-paste-forget">
            Forget it now
          </button>
        </p>
        <ul className="vmn-list">
          {usable.map((m) => {
            const cur = counted(m, votes.list, now);
            const mine = onItsWay(m, k.watched);
            const v = mine ? describeVote(mine, now, fmtTime) : null;
            return (
              <li key={m.proTxHash} className={`vmn${selected.has(m.proTxHash) ? ' vmn-on' : ''}`} data-testid="vote-mn-row" data-protx={m.proTxHash}>
                <label className="vmn-pick dh-field__label">
                  {usable.length > 1 && <input type="checkbox" checked={selected.has(m.proTxHash)} onChange={(e) => toggle(m, e.target.checked)} disabled={sending} aria-label={`Vote with ${mnName(m, labels)}`} />}
                  <span className="vmn-name">{mnName(m, labels)}</span>
                  {m.type === 'evo' && <span className="chip vmn-evo">Evonode ×4</span>}
                </label>
                <div className="vmn-state">
                  <span className="vmn-cur" data-testid="current-vote">
                    <span className="vmn-k">Now</span> {votes.loading ? <span className="muted">…</span> : votes.error ? <span className="muted">couldn’t read</span> : <OutcomeChip outcome={cur?.outcome} />}
                  </span>
                  {mine && v && (
                    <span className="vmn-pend" data-testid="pending-vote">
                      <span className="vmn-k">Sent</span> <OutcomeChip outcome={mine.outcome} muted /> <Badge tone={v.tone}>{v.badge}</Badge>
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="vgo">
        {network === 'mainnet' && <p className="small muted">Mainnet · real DASH</p>}
        <button type="button" className="btn dh-btn btn-primary dh-btn--primary vgo-btn" disabled={blocked} aria-busy={sending || undefined} onClick={() => void go()} data-testid="vote-send">
          {sending ? 'Signing and sending…' : !chosen.length ? 'Select a masternode' : voteButtonText(outcome, chosen.length, false)}
        </button>
        {outcome !== 0 && held.length > 0 && (
          <p className="small vwarn" data-testid="vote-hour-rule">
            {held.length === 1 ? `${mnName(held[0]!, labels)} voted on this proposal` : `${held.length} of these masternodes voted on it`} less than an hour ago. Core accepts one change an
            hour, so the relay holds the new vote until then.
          </p>
        )}
        {((outcome !== 0 && chosen.length > 0) || !k.relays.length) && <p className={`vgo-sum small ${relays.warn ? 'vwarn' : 'muted'}`}>{relays.text}</p>}
        {notes.map((s) => (
          <p key={s} className="small muted">
            {s}
          </p>
        ))}
      </div>
    </div>
  );
}

/** Votes on this proposal signed in this view (offline or with pasted keys), followed until the network has them. */
function SentHere({ proposal }: { proposal: Proposal }) {
  const k = useKeyring();
  const labels = useLabels();
  const [since] = useState(() => Math.floor(Date.now() / 1000));
  // the keyring's composer shows its own
  if (k.status === 'open') return null;
  const mine = k.watched.filter((w) => w.govHash === proposal.govHash && (w.signedAt ?? 0) >= since && w.status !== 'dropped' && w.status !== 'cancelled');
  if (!mine.length) return null;
  return (
    <section className="vtracks" aria-label="Your votes on their way" data-testid="vote-tracks">
      {mine
        .sort((a, b) => (b.signedAt ?? 0) - (a.signedAt ?? 0))
        .slice(0, 8)
        .map((w) => (
          <VoteTracker key={w.voteHash} vote={w} name={mnName(w, labels)} />
        ))}
    </section>
  );
}
