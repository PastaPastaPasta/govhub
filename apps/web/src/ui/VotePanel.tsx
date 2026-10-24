// Masternode voting UI (PLAN §5.1-5.2). One proposal (the proposal page's panel) or many (/votes): pick Yes / No / Abstain for the
// selected masternodes, sign in the browser, send through the relays now or each masternode at its own random time before the
// deadline, then follow every vote until the network counts it. Also offline signing (the exact text for `signmessage`).
import { bytesEqual, decodeAddress, governanceVoteHash, recoverVoteSigner, type Network } from '@govhub/verify';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { errorText } from '../auth/runtime.ts';
import { enabledBridges } from '../config/registry.ts';
import { HttpBridge, type BridgeMasternode } from '../data/bridge.ts';
import type { Proposal } from '../data/types.ts';
import { shortHash } from '../lib/format.ts';
import { votingDeadlineTime } from '../lib/governance.ts';
import { useKeyring } from '../voting/KeyringContext.tsx';
import type { OwnedMasternode } from '../voting/masternodes.ts';
import { isOpen, type WatchedVote } from '../voting/pending.ts';
import { currentKey, deferredWindow, mnId, offlineSigningRequest, OUTCOME_NAME, type CurrentVote, type Intent, type Outcome } from '../voting/plan.ts';
import { relayHost } from '../voting/relay.ts';
import { deferredUnavailable, describeVote, voteButtonText } from '../voting/status.ts';
import { Badge, fmtTime, mnName, OUTCOME_LABEL, OutcomeChip } from './vote/common.tsx';
import { VoteSuccess } from './vote/VoteSuccess.tsx';
import { VoteTracker } from './vote/VoteTracker.tsx';
import { VotesList } from './vote/VotesList.tsx';
import '../voting/voting.css';

export { VotesList as WatchedList };

/** The voting deadline of the next superblock (maturity window start), from the cycle in the snapshot. */
export function useDeadline(): number | null {
  const { gov, params } = useApp();
  const c = gov.cycle.data?.value;
  return c ? votingDeadlineTime(c, params) : null;
}

export function useCurrentVotes(govHashes: string[], nonce = 0): { votes: Map<string, CurrentVote>; loading: boolean; error: string | null } {
  const k = useKeyring();
  const [votes, setVotes] = useState(new Map<string, CurrentVote>());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = govHashes.join(',');
  useEffect(() => {
    if (!govHashes.length || k.status !== 'open') return;
    let live = true;
    setLoading(true);
    setError(null);
    k.currentVotes(govHashes).then(
      (v) => live && (setVotes(v), setLoading(false)),
      (e) => live && (setError(errorText(e)), setLoading(false)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, k.status, k.currentVotes, nonce]);
  return { votes, loading, error };
}

/** Node labels of the open keyring, by proTxHash. */
export function useLabels(): Map<string, string> {
  const k = useKeyring();
  return useMemo(() => new Map(k.keyring?.content.labels.map((l) => [l.proTxHash.toLowerCase(), l.label]) ?? []), [k.keyring, k.keyring?.content.labels]);
}

const OUTCOMES: Outcome[] = [1, 2, 3];

/** Yes / No / Abstain as one radio group: arrow keys move, Space/Enter pick; clicking the picked one again clears it (when allowed). */
export function OutcomePicker({ value, onChange, label, size = 'l', clearable = false, testId }: { value: Outcome | 0; onChange(o: Outcome | 0): void; label: string; size?: 'l' | 's'; clearable?: boolean; testId?: string }) {
  const focusable = value || 1;
  const key = (e: KeyboardEvent<HTMLButtonElement>, o: Outcome) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = OUTCOMES[(OUTCOMES.indexOf(o) + d + 3) % 3]!;
    onChange(next);
    (e.currentTarget.parentElement?.querySelector(`[data-outcome="${next}"]`) as HTMLButtonElement | null)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={`vpick vpick-${size}`} data-testid={testId}>
      {OUTCOMES.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          tabIndex={focusable === o ? 0 : -1}
          data-outcome={o}
          className={`vpick-opt vpick-${o}`}
          onClick={() => onChange(clearable && value === o ? 0 : o)}
          onKeyDown={(e) => key(e, o)}
        >
          {OUTCOME_LABEL[o]}
        </button>
      ))}
    </div>
  );
}

/** Our newest vote for this masternode and proposal that is still on its way (queued, held, broadcast). */
const pendingFor = (watched: readonly WatchedVote[], m: OwnedMasternode, govHash: string) =>
  watched.filter((w) => isOpen(w) && w.govHash === govHash && mnId(w) === mnId(m)).sort((a, b) => b.time - a.time)[0];

/** Votes to show progress for: signed in this tab, or still moving, newest first. */
function trackedFor(watched: readonly WatchedVote[], govHashes: ReadonlySet<string>, since: number): WatchedVote[] {
  return watched
    .filter((w) => govHashes.has(w.govHash) && (isOpen(w) || (w.signedAt ?? 0) >= since || (w.status === 'confirmed' && !w.countedAt)))
    .filter((w) => w.status !== 'dropped' && w.status !== 'cancelled')
    .sort((a, b) => (b.signedAt ?? b.time) - (a.signedAt ?? a.time));
}

export function VoteComposer({ proposals, compact = false }: { proposals: Proposal[]; compact?: boolean }) {
  const k = useKeyring();
  const deadline = useDeadline();
  const labels = useLabels();
  const [since] = useState(() => Math.floor(Date.now() / 1000));
  const [nonce, setNonce] = useState(0);
  const confirmedCount = k.watched.filter((w) => w.status === 'confirmed').length;
  const { votes: current, loading, error: currentError } = useCurrentVotes(
    proposals.map((p) => p.govHash),
    nonce + confirmedCount,
  );
  const usable = k.mns.owned.filter((m) => m.valid);
  const [selected, setSelected] = useState<Set<string> | null>(null); // null = all
  const [choice, setChoice] = useState<Record<string, Outcome | 0>>({});
  const [mode, setMode] = useState<'now' | 'deferred'>('now');
  const [withinH, setWithinH] = useState('');
  const [backup, setBackup] = useState(false);
  const [resend, setResend] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const sel = (m: { proTxHash: string }) => (selected ? selected.has(m.proTxHash) : true);
  const chosen = usable.filter(sel);
  const now = Math.floor(Date.now() / 1000);
  const unavailable = deferredUnavailable(deadline, now, k.coreNetwork);
  const window = unavailable ? null : deferredWindow(now, deadline!, k.coreNetwork);
  useEffect(() => {
    if (unavailable && mode === 'deferred') setMode('now');
  }, [unavailable, mode]);
  const byHash = new Map(proposals.map((p) => [p.govHash, p]));
  const tracked = trackedFor(k.watched, new Set(byHash.keys()), since);
  const wins = k.celebrations.map((h) => k.watched.find((w) => w.voteHash === h)).filter((w): w is WatchedVote => !!w && byHash.has(w.govHash));

  if (k.status !== 'open') {
    return (
      <div className="vempty" data-testid="vote-cta">
        <p>{k.status === 'signed-out' ? 'Masternode owners: sign in and add your voting keys to vote here.' : 'Unlock your masternode keyring to vote here.'}</p>
        <Link className="btn" to="/masternodes">
          My masternodes
        </Link>
      </div>
    );
  }
  if (!usable.length) {
    const finding = k.mns.phase === 'loading' || k.mns.phase === 'idle';
    return (
      <div className="vempty" data-testid="vote-none">
        {finding ? (
          <p>
            <span className="spinner" aria-hidden="true" /> Finding your masternodes…
          </p>
        ) : k.mns.phase === 'error' ? (
          <p className="error">Your masternodes could not be looked up: {k.mns.error}</p>
        ) : (
          <p>None of your keyring’s masternodes can vote ({k.keyring?.content.keys.length ? 'none found for your keys, or all PoSe-banned' : 'no voting keys yet'}).</p>
        )}
        <Link className="btn btn-s" to="/masternodes">
          My masternodes
        </Link>
      </div>
    );
  }

  // what would be sent: per proposal with a choice, per chosen masternode whose current or pending vote differs (unless re-sending)
  type Row = { intent: Intent; same: 'current' | 'pending' | null };
  const rows: Row[] = [];
  for (const p of proposals) {
    const o = choice[p.govHash];
    if (!o) continue;
    for (const m of chosen) {
      const pend = pendingFor(k.watched, m, p.govHash);
      const cur = current.get(currentKey(m, p.govHash));
      const same = pend ? (pend.outcome === o ? 'pending' : null) : cur?.outcome === o ? 'current' : null;
      rows.push({ intent: { mn: m, govHash: p.govHash, outcome: o }, same });
    }
  }
  const differing = rows.filter((r) => !r.same);
  const repeats = rows.filter((r) => r.same);
  const toSend = resend ? rows : differing;
  const multi = proposals.length > 1;
  const single = !multi ? (choice[proposals[0]!.govHash] ?? 0) : 0;
  const blocked = !!k.busy || !k.relays.length || loading || !!currentError;
  const disabledHint = !rows.length
    ? multi
      ? 'Choose a vote for at least one proposal.'
      : chosen.length
        ? 'Choose Yes, No or Abstain.'
        : 'Select at least one masternode.'
    : !toSend.length
      ? 'Nothing would change. Tick “Send it again anyway” to repeat the vote.'
      : !k.relays.length
        ? 'No relay is configured (Settings).'
        : currentError
          ? 'Waiting for your current votes from the bridge.'
          : loading
            ? 'Reading your current votes…'
            : null;
  const latestRelease = mode === 'deferred' && window ? Math.min(window.latest, withinH ? now + Number(withinH) * 3600 : Infinity) : null;
  const buttonText = k.busy?.startsWith('Signing')
    ? `${k.busy}…`
    : !chosen.length
      ? 'Select at least one masternode'
      : multi
      ? `${mode === 'deferred' ? 'Schedule' : 'Sign and send'} ${toSend.length} vote${toSend.length === 1 ? '' : 's'}`
      : voteButtonText(single, new Set(toSend.map((r) => r.intent.mn.proTxHash)).size || chosen.length, mode === 'deferred');

  const go = async () => {
    setSkipped([]);
    try {
      const latest = mode === 'deferred' && withinH ? now + Number(withinH) * 3600 : undefined;
      const r = await k.cast(
        toSend.map((x) => x.intent),
        { mode, ...(latest ? { latest } : {}), backupOnPlatform: backup, resend },
        deadline,
        current,
      );
      setSkipped(r.skipped.map((s) => `${mnName(s.intent.mn, labels)}: ${s.reason}`));
      setChoice({});
      setResend(false);
      setNonce((n) => n + 1);
    } catch {
      /* shown by the provider */
    }
  };

  const toggle = (m: OwnedMasternode, on: boolean) => {
    const s = new Set(selected ?? usable.map((x) => x.proTxHash));
    if (on) s.add(m.proTxHash);
    else s.delete(m.proTxHash);
    setSelected(s);
  };

  return (
    <div className="vcomp" data-testid="vote-composer">
      <fieldset className="vcomp-mns">
        <legend className="vcomp-legend">
          Masternodes
          <span className="muted small">
            {' '}
            {chosen.length} of {usable.length} selected
          </span>
        </legend>
        {usable.length > 1 && (
          <label className="check vcomp-all">
            <input type="checkbox" checked={chosen.length === usable.length} onChange={(e) => setSelected(e.target.checked ? null : new Set())} /> All masternodes
          </label>
        )}
        <ul className="vmn-list">
          {usable.map((m) => (
            <li key={m.proTxHash} className={`vmn${sel(m) ? ' vmn-on' : ''}`} data-testid="vote-mn-row">
              <label className="vmn-pick">
                <input type="checkbox" checked={sel(m)} onChange={(e) => toggle(m, e.target.checked)} aria-label={`Vote with ${mnName(m, labels)}`} />
                <span className="vmn-name">{mnName(m, labels)}</span>
                {m.type === 'evo' && <span className="chip vmn-evo">Evonode ×4</span>}
              </label>
              {!multi &&
                (() => {
                  const g = proposals[0]!.govHash;
                  const cur = current.get(currentKey(m, g));
                  const pend = pendingFor(k.watched, m, g);
                  const v = pend ? describeVote(pend, now, fmtTime) : null;
                  return (
                    <div className="vmn-state">
                      <span className="vmn-cur" data-testid="current-vote">
                        <span className="vmn-k">On the network</span> {loading ? <span className="muted">…</span> : <OutcomeChip outcome={cur?.outcome} />}
                      </span>
                      {pend && v && (
                        <span className="vmn-pend" data-testid="pending-vote">
                          <span className="vmn-k">Your vote</span> <OutcomeChip outcome={pend.outcome} muted /> <Badge tone={v.tone}>{v.badge}</Badge>
                        </span>
                      )}
                    </div>
                  );
                })()}
            </li>
          ))}
        </ul>
      </fieldset>

      {multi ? (
        <ul className="vprops">
          {proposals.map((p) => {
            const tally = { yes: 0, no: 0, abstain: 0, none: 0 };
            for (const m of chosen) {
              const o = current.get(currentKey(m, p.govHash))?.outcome;
              if (o === 1) tally.yes++;
              else if (o === 2) tally.no++;
              else if (o === 3) tally.abstain++;
              else tally.none++;
            }
            const sum = [tally.yes && `${tally.yes} Yes`, tally.no && `${tally.no} No`, tally.abstain && `${tally.abstain} Abstain`, tally.none && `${tally.none} not voted`].filter(Boolean).join(', ');
            return (
              <li key={p.govHash} className="vprop" data-testid="vote-proposal-row">
                <div className="vprop-name">
                  <Link to={`/p/h/${p.govHash}`}>{p.name}</Link>
                  <span className="small muted">{loading ? 'reading current votes…' : `Now: ${sum || 'no masternodes selected'}`}</span>
                </div>
                <OutcomePicker size="s" clearable label={`Vote on ${p.name}`} value={choice[p.govHash] ?? 0} onChange={(o) => setChoice({ ...choice, [p.govHash]: o })} testId="vote-choice" />
              </li>
            );
          })}
        </ul>
      ) : (
        <OutcomePicker label="Your vote" value={single} onChange={(o) => setChoice({ [proposals[0]!.govHash]: o })} testId="vote-choice" />
      )}

      {repeats.length > 0 && (
        <div className="vwarn" role="note" data-testid="vote-same-warning">
          <p>
            {repeats.length === 1
              ? `${mnName(repeats[0]!.intent.mn, labels)} ${repeats[0]!.same === 'pending' ? 'already has this vote on its way' : `already voted ${OUTCOME_NAME[repeats[0]!.intent.outcome].toUpperCase()}`}`
              : `${repeats.length} of these votes are already the current or pending vote`}
            ; re-sending only updates the timestamp{repeats.some((r) => r.same === 'current') ? ' and restarts Core’s one-hour clock' : ''}.
            {differing.length > 0 && !resend && ' They are skipped.'}
          </p>
          <label className="check">
            <input type="checkbox" checked={resend} onChange={(e) => setResend(e.target.checked)} data-testid="vote-resend" /> Send {repeats.length === 1 ? 'it' : 'them'} again anyway
          </label>
        </div>
      )}

      <fieldset className="vwhen">
        <legend className="vcomp-legend">When</legend>
        <div className="vwhen-opts">
          <label className={`vwhen-opt${mode === 'now' ? ' on' : ''}`}>
            <input type="radio" name="vote-when" checked={mode === 'now'} onChange={() => setMode('now')} />
            <span>
              <b>Now</b>
              <span className="small muted">Sent at once; the network shows it within a minute or two.</span>
            </span>
          </label>
          <label className={`vwhen-opt${mode === 'deferred' ? ' on' : ''}${unavailable ? ' off' : ''}`}>
            <input type="radio" name="vote-when" checked={mode === 'deferred'} onChange={() => setMode('deferred')} disabled={!!unavailable} data-testid="vote-deferred" aria-describedby="vote-deferred-why" />
            <span>
              <b>Spread out</b>
              <span className="small muted" id="vote-deferred-why" data-testid="vote-deferred-why">
                {unavailable ?? 'Each masternode at its own random time before the deadline, so they are not seen voting together.'}
              </span>
            </span>
          </label>
        </div>
        {mode === 'deferred' && window && (
          <div className="vwhen-more">
            <label>
              Release within the next{' '}
              <input type="number" min={0.1} step={0.1} value={withinH} onChange={(e) => setWithinH(e.target.value)} placeholder={String(Math.floor((window.latest - now) / 360) / 10)} className="vote-hours" data-testid="vote-within" /> hours
            </label>
            <label className="check">
              <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} disabled={k.memoryOnly} /> Back up the held votes in my encrypted keyring (a Platform write, about 0.0015 DASH the first time)
            </label>
            <p className="small muted">The relay you use still sees which votes came from you, and when.</p>
          </div>
        )}
      </fieldset>

      <div className="vgo">
        {toSend.length > 0 && !blocked && (
          <p className="vgo-sum" data-testid="vote-summary">
            {mode === 'deferred' && latestRelease
              ? `Sign ${toSend.length} vote${toSend.length === 1 ? '' : 's'}, released at random times before ${fmtTime(latestRelease)}.`
              : `Sign ${toSend.length} vote${toSend.length === 1 ? '' : 's'} and send ${toSend.length === 1 ? 'it' : 'them'} through ${k.relays.length === 1 ? relayHost(k.relays[0]!) : `${k.relays.length} relays`} now.`}
          </p>
        )}
        <button type="button" className="btn btn-primary vgo-btn" disabled={blocked || !toSend.length} onClick={go} data-testid="vote-send" aria-describedby={disabledHint && disabledHint.replace(/\.$/, '') !== buttonText ? 'vote-send-hint' : undefined}>
          {buttonText}
        </button>
        {disabledHint && disabledHint.replace(/\.$/, '') !== buttonText && (
          <p className={`small ${currentError ? 'error' : 'muted'}`} id="vote-send-hint" data-testid="vote-send-hint">
            {currentError ? `Your current votes could not be read from the bridge (${currentError}); voting waits until they can.` : disabledHint}
          </p>
        )}
        {skipped.map((s) => (
          <p key={s} className="small muted">
            {s}
          </p>
        ))}
      </div>

      {wins.map((w) => (
        <VoteSuccess key={w.voteHash} vote={w} name={mnName(w, labels)} proposalName={byHash.get(w.govHash)?.name ?? shortHash(w.govHash, 6)} />
      ))}
      {tracked.length > 0 && (
        <section className="vtracks" aria-label="Your votes on their way" data-testid="vote-tracks">
          {tracked.slice(0, 8).map((w) => (
            <VoteTracker key={w.voteHash} vote={w} name={`${mnName(w, labels)}${multi ? ` · ${byHash.get(w.govHash)?.name ?? ''}` : ''}`} />
          ))}
        </section>
      )}

      <details className="vhow">
        <summary>How is this verified?</summary>
        <ul className="small">
          <li>“On the network” is each masternode’s current vote in the bridge’s live vote set, shown only when its signature checks out against your voting key here. A bridge cannot invent or alter it (it could still hold back a newer one).</li>
          <li>“Seen by the network” means the same: your exact signed vote is that current vote. “Counted” means a recount of the tally’s vote set includes it and matches the set the bridge published.</li>
          {!compact && <li>The verification panel on each proposal page recounts every vote against the proven masternode list.</li>}
          {compact && <li>The verification panel below recounts every vote against the proven masternode list.</li>}
        </ul>
      </details>
    </div>
  );
}

/** Offline signing: the exact text to sign elsewhere (mainnet), or why that is impossible (testnet). No key enters the page. */
export function OfflineSign({ proposal }: { proposal: Proposal }) {
  const k = useKeyring();
  const { registry } = useApp();
  const network: Network = k.coreNetwork;
  const [address, setAddress] = useState('');
  const [outcome, setOutcome] = useState<Outcome>(1);
  const [mns, setMns] = useState<BridgeMasternode[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sigs, setSigs] = useState<Record<string, string>>({});
  const [time] = useState(() => Math.floor(Date.now() / 1000));
  const find = async () => {
    setErr(null);
    setMns(null);
    const d = decodeAddress(address.trim(), network);
    if (!d || d.type !== 'p2pkh') return setErr(`Enter a ${network} voting address.`);
    const b = enabledBridges(registry)[0];
    if (!b) return setErr('No bridge configured.');
    try {
      const list = await new HttpBridge(b.name, b.httpBase).mnlist();
      setMns(list.masternodes.filter((m) => m.votingAddress === address.trim() && m.valid));
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const submit = async (m: BridgeMasternode) => {
    const sig = (sigs[m.proTxHash] ?? '').trim();
    const fields = { collateralTxid: m.collateralTxid, collateralIndex: m.collateralIndex, govHashDisplay: proposal.govHash, signal: 1, outcome, time };
    const signer = recoverVoteSigner(sig, fields, network);
    const d = decodeAddress(address.trim(), network)!;
    if (!signer || !bytesEqual(signer.keyId, d.hash160)) return setErr('That signature is not by this voting address over this text.');
    await k.submitSigned({ proTxHash: m.proTxHash, collateralTxid: m.collateralTxid, collateralIndex: m.collateralIndex, govHash: proposal.govHash, outcome, time, releaseAt: time, sig, voteHash: governanceVoteHash(fields) }).catch(() => {});
  };
  return (
    <details className="vote-offline">
      <summary>Sign offline (Dash Core, DMT, hardware wallet)</summary>
      {network === 'testnet' ? (
        <p className="notice-box small" data-testid="offline-testnet">
          Not possible on testnet: testnet Core checks votes against the binary vote hash, not a signed message, and <code>signmessage</code> (Dash Core, DMT, hardware wallets) can only sign messages. Use a voting key in the keyring instead; the hash to sign is shown for custom tooling.
        </p>
      ) : (
        <p className="small muted">Paste your voting address, sign each line below with <code>signmessage &lt;address&gt; "&lt;text&gt;"</code>, and paste the signature back. The key never enters this page.</p>
      )}
      <div className="form-actions">
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="voting address" aria-label="Voting address" className="mono-ish vinput" />
        <select value={outcome} onChange={(e) => setOutcome(Number(e.target.value) as Outcome)} aria-label="Vote" className="vinput">
          <option value={1}>Yes</option>
          <option value={2}>No</option>
          <option value={3}>Abstain</option>
        </select>
        <button type="button" className="btn" onClick={find}>
          Show what to sign
        </button>
      </div>
      {err && <p className="error small">{err}</p>}
      {mns && !mns.length && <p className="muted small">No valid masternode votes with that address.</p>}
      {mns?.map((m) => {
        const req = offlineSigningRequest({ mn: m, govHash: proposal.govHash, outcome, time }, network);
        return (
          <div key={m.proTxHash} className="vote-offline-row" data-testid="offline-row">
            <div className="small">Masternode {shortHash(m.proTxHash, 6)}</div>
            {req.message ? <pre className="code">{req.message}</pre> : <pre className="code">vote signature hash (internal byte order): {req.hashHex}</pre>}
            {req.message && (
              <div className="form-actions">
                <input value={sigs[m.proTxHash] ?? ''} onChange={(e) => setSigs({ ...sigs, [m.proTxHash]: e.target.value })} placeholder="signature (base64)" aria-label="Signature" className="mono-ish vinput" />
                <button type="button" className="btn" onClick={() => void submit(m)} disabled={!k.relays.length}>
                  Send
                </button>
              </div>
            )}
          </div>
        );
      })}
    </details>
  );
}

export function ProposalVotePanel({ proposal }: { proposal: Proposal }) {
  const k = useKeyring();
  return (
    <section aria-labelledby="mnvote-title" className="mnvote" data-testid="mn-vote-panel">
      <header className="mnvote-head">
        <h2 id="mnvote-title">Vote with your masternodes</h2>
        {k.demo && k.status === 'open' && <span className="chip chip-fixture">Demo: pretend relays</span>}
      </header>
      {k.error && k.status === 'open' && (
        <p className="error small" role="alert">
          {k.error}
        </p>
      )}
      <VoteComposer proposals={[proposal]} compact />
      <OfflineSign proposal={proposal} />
    </section>
  );
}
