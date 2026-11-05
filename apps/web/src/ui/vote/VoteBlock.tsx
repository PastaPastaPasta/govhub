// "Vote on this proposal": the proposal page's vote, near the top. Yes / No / Abstain, then the way to sign that fits what the visitor
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
import { formatDuration, shortHash } from '../../lib/format.ts';
import { useKeyring } from '../../voting/KeyringContext.tsx';
import type { OwnedMasternode } from '../../voting/masternodes.ts';
import { offlineVoteTime, signPlanned, type CurrentVote, type Outcome } from '../../voting/plan.ts';
import { relaySummary, voteButtonText } from '../../voting/status.ts';
import { Link } from '../Link.tsx';
import { openSignIn } from '../SignIn.tsx';
import { bridgeVotesFor, latestKnownVote, OfflineSign, OfflineSignBody, OutcomePicker, VoteComposer } from '../VotePanel.tsx';
import { mnName, OutcomeChip, OUTCOME_LABEL, useLabels } from './common.tsx';
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

export function ProposalVoteBlock({ proposal, mn, closesIn, onVerify }: { proposal: Proposal; mn: string | null; closesIn: number | null; onVerify(): void }) {
  return mn ? <WithMasternode proposal={proposal} proTx={mn} closesIn={closesIn} onVerify={onVerify} /> : <VoteBlock proposal={proposal} ctx={null} closesIn={closesIn} onVerify={onVerify} />;
}

function WithMasternode({ proposal, proTx, closesIn, onVerify }: { proposal: Proposal; proTx: string; closesIn: number | null; onVerify(): void }) {
  const one = useMemo(() => [proposal], [proposal]);
  const v = useMasternodeVotes(proTx, one);
  return <VoteBlock proposal={proposal} ctx={{ proTx, lookup: v.lookup, cell: v.cells.get(proposal.govHash) }} closesIn={closesIn} onVerify={onVerify} />;
}

type Way = 'offline' | 'paste' | 'account';

function VoteBlock({ proposal, ctx, closesIn, onVerify }: { proposal: Proposal; ctx: MnContext | null; closesIn: number | null; onVerify(): void }) {
  const k = useKeyring();
  const guest = useGuestKeys();
  const signedIn = !!useForum().session;
  const [outcome, setOutcome] = useState<Outcome | 0>(0);
  const [way, setWay] = useState<Way>(signedIn ? 'account' : 'offline');
  const is = (m: { proTxHash: string; valid: boolean }) => m.valid && (!ctx || m.proTxHash.toLowerCase() === ctx.proTx);
  const keyring = k.status === 'open' && (!ctx || k.mns.owned.some(is) || k.mns.phase === 'loading');
  const pasted = !keyring && guest.status === 'ready' && guest.owned.some(is);
  const found = ctx?.lookup.kind === 'found' ? ctx.lookup.mn : null;
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
      {ctx && <MasternodeLine ctx={ctx} />}
      {k.error && (keyring || pasted || way !== 'account') && (
        <p className="error small" role="alert">
          {k.error}
        </p>
      )}
      {keyring ? (
        <>
          <VoteComposer proposals={[proposal]} onVerify={onVerify} {...(ctx ? { onlyMn: ctx.proTx } : {})} />
          <OfflineSign proposal={proposal} address={found?.votingAddress ?? ''} />
        </>
      ) : pasted ? (
        <PastedKeyVote proposal={proposal} outcome={outcome} setOutcome={setOutcome} only={ctx?.proTx ?? null} />
      ) : (
        <>
          <OutcomePicker label="Your vote" value={outcome} onChange={setOutcome} testId="vote-choice" />
          <WayPicker way={way} setWay={setWay} signedIn={signedIn} />
          {way === 'offline' ? (
            outcome ? <OfflineSignBody proposal={proposal} address={found?.votingAddress ?? ''} outcome={outcome} /> : null
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

/** "As masternode d353cd…7eff · evonode, counts 4 times · Now: Yes", and the way back to its votes. */
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
        {mn && <span className="muted small"> · {mn.type === 'evo' ? 'evonode, its vote counts 4 times' : 'regular masternode'}</span>}
        {mn && !mn.valid && <span className="tag dh-badge tag-fail dh-badge--bad">PoSe-banned: its votes are not counted</span>}
        {mn && (
          <span className="pvote-now small">
            <span className="muted">Now</span>{' '}
            {!cell || cell.kind === 'waiting' ? <span className="muted">reading…</span> : cell.kind === 'unread' ? <span className="muted">couldn’t read</span> : <OutcomeChip outcome={cell.kind === 'voted' ? cell.outcome : undefined} />}
          </span>
        )}
      </p>
      {ctx.lookup.kind === 'absent' && <p className="small muted">It isn’t in the {network} masternode list the governance bridge reports, so it can’t vote here.</p>}
      {ctx.lookup.kind === 'error' && <p className="small muted">Its details couldn’t be read just now ({ctx.lookup.message}); you can still vote below.</p>}
      <p className="small pvote-mn-links">
        <Link to={`/masternodes/${ctx.proTx}`} data-testid="vote-mn-back">
          ‹ Its votes on every proposal
        </Link>
        <Link to="." relative="path" className="muted" data-testid="vote-mn-clear">
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

function WayPicker({ way, setWay, signedIn }: { way: Way; setWay(w: Way): void; signedIn: boolean }) {
  // pasted keys are for visitors without an account (signing in wipes them: the keyring takes over)
  const ways = WAYS.filter((w) => !(signedIn && w.id === 'paste'));
  const current = ways.find((w) => w.id === way) ?? ways[0]!;
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
          That key votes for other masternodes, not {shortHash(ctx.proTx, 6)}. <Link to=".">Vote with those instead</Link>, or paste {shortHash(ctx.proTx, 6)}’s voting key.
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

/** Votes with the keys pasted for this tab: each masternode's vote timed after its latest one we know of, signed here, sent to the relay. */
function PastedKeyVote({ proposal, outcome, setOutcome, only }: { proposal: Proposal; outcome: Outcome | 0; setOutcome(o: Outcome | 0): void; only: string | null }) {
  const k = useKeyring();
  const guest = useGuestKeys();
  const { registry } = useApp();
  const labels = useLabels();
  const network = k.coreNetwork;
  const usable = useMemo(() => guest.owned.filter((m) => m.valid), [guest.owned]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(usable.filter((m) => !only || m.proTxHash.toLowerCase() === only).map((m) => m.proTxHash)));
  const chosen = usable.filter((m) => selected.has(m.proTxHash));
  const [votes, setVotes] = useState<{ list: BridgeVote[] | null; error: string | null; loading: boolean }>({ list: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  const [skipped, setSkipped] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setVotes((v) => ({ ...v, loading: true }));
    bridgeVotesFor(registry, proposal.govHash).then(
      (list) => live && setVotes({ list, error: null, loading: false }),
      (e: unknown) => live && setVotes({ list: null, error: e instanceof Error ? e.message : String(e), loading: false }),
    );
    return () => {
      live = false;
    };
  }, [registry, proposal.govHash, nonce]);
  const now = Math.floor(Date.now() / 1000);
  const keyHash = (m: OwnedMasternode) => guest.keyInfos[m.keyIndex]?.pubKeyHash;
  const current = (m: OwnedMasternode, list: readonly BridgeVote[] | null, at: number): CurrentVote | undefined => {
    const h = keyHash(m);
    return h ? latestKnownVote(m, proposal.govHash, list, h, k.watched, network, at) : undefined;
  };
  const go = async () => {
    if (!outcome) return;
    setSkipped([]);
    const copies = guest.copyKeys();
    if (!copies) return;
    const signed: Array<{ v: ReturnType<typeof signPlanned>; weight: number; prev: CurrentVote | null }> = [];
    const skip: string[] = [];
    try {
      // the vote set as it is now: each vote is timed after this masternode's latest one (Core: one change an hour, the later wins)
      const list = await bridgeVotesFor(registry, proposal.govHash);
      const at = Math.floor(Date.now() / 1000);
      for (const m of chosen) {
        const cur = current(m, list, at);
        if (cur?.outcome === outcome) {
          skip.push(`${mnName(m, labels)} already voted ${OUTCOME_LABEL[outcome]}; nothing was sent for it.`);
          continue;
        }
        const key = copies.keyOf(m);
        if (!key) continue;
        const t = offlineVoteTime(at, cur);
        signed.push({ v: signPlanned({ mn: m, govHash: proposal.govHash, outcome, time: t.time, releaseAt: t.releaseAt, notes: [] }, key.privateKey, key.compressed, network), weight: m.type === 'evo' ? 4 : 1, prev: cur ?? null });
      }
    } catch (e) {
      skip.push(`Your current votes could not be read from the bridge (${e instanceof Error ? e.message : String(e)}), so nothing was signed.`);
    } finally {
      copies.wipe();
    }
    setSkipped(skip);
    for (const s of signed) await k.submitSigned({ ...s.v, network, weight: s.weight, prev: s.prev }).catch(() => {});
    setNonce((n) => n + 1);
  };
  const toggle = (m: OwnedMasternode, on: boolean) => {
    const s = new Set(selected);
    if (on) s.add(m.proTxHash);
    else s.delete(m.proTxHash);
    setSelected(s);
  };
  const relays = relaySummary(k.relays, k.relayHealth);
  const blocked = !!k.busy || !k.relays.length || !outcome || !chosen.length;
  return (
    <div className="vcomp" data-testid="vote-pasted">
      <OutcomePicker label="Your vote" value={outcome} onChange={setOutcome} testId="vote-choice" />
      <div className="pvote-keys small">
        <p>
          With {usable.length === 1 ? 'the masternode' : `${chosen.length} of the ${usable.length} masternodes`} your pasted key votes for. The key is in this tab’s memory only.{' '}
          <button type="button" className="linkish dh-btn dh-btn--link" onClick={guest.forget} data-testid="vote-paste-forget">
            Forget it now
          </button>
        </p>
        <ul className="vmn-list">
          {usable.map((m) => {
            const cur = current(m, votes.list, now);
            return (
              <li key={m.proTxHash} className={`vmn${selected.has(m.proTxHash) ? ' vmn-on' : ''}`} data-testid="vote-mn-row" data-protx={m.proTxHash}>
                <label className="vmn-pick dh-field__label">
                  {usable.length > 1 && <input type="checkbox" checked={selected.has(m.proTxHash)} onChange={(e) => toggle(m, e.target.checked)} aria-label={`Vote with ${mnName(m, labels)}`} />}
                  <span className="vmn-name">{mnName(m, labels)}</span>
                  {m.type === 'evo' && <span className="chip vmn-evo">Evonode ×4</span>}
                </label>
                <span className="vmn-cur" data-testid="current-vote">
                  <span className="vmn-k">Now</span> {votes.loading ? <span className="muted">…</span> : votes.error ? <span className="muted">couldn’t read</span> : <OutcomeChip outcome={cur?.outcome} />}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="vgo">
        {network === 'mainnet' && <p className="small muted">Mainnet · real DASH</p>}
        <button type="button" className="btn dh-btn btn-primary dh-btn--primary btn-l dh-btn--lg vgo-btn" disabled={blocked} onClick={() => void go()} data-testid="vote-send">
          {k.busy?.startsWith('Sending') ? 'Sending…' : !chosen.length ? 'Select a masternode' : voteButtonText(outcome, chosen.length, false)}
        </button>
        {outcome !== 0 && chosen.length > 0 && <p className={`vgo-sum small ${relays.warn ? 'vwarn' : 'muted'}`}>{relays.text}</p>}
        {skipped.map((s) => (
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
