// Masternode voting UI (PLAN §5.1-5.2). One proposal (the proposal page's panel) or many (/votes): pick Yes / No / Abstain for the
// selected masternodes, sign in the browser, send through the relays now or each masternode at its own random time before the
// deadline, then follow every vote until the network counts it. Also offline signing (the exact text for `signmessage`).
import { bytesEqual, decodeAddress, governanceVoteHash, recoverVoteSigner, verifyVoteSignature, VOTE_MAX_FUTURE_S, type Network } from '@govhub/verify';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { errorText } from '../auth/runtime.ts';
import { enabledBridges } from '../config/registry.ts';
import { BridgeError, HttpBridge, type BridgeMasternode } from '../data/bridge.ts';
import type { Proposal } from '../data/types.ts';
import { shortHash } from '../lib/format.ts';
import { votingDeadlineTime } from '../lib/governance.ts';
import { useKeyring } from '../voting/KeyringContext.tsx';
import type { OwnedMasternode } from '../voting/masternodes.ts';
import { isOpen, type WatchedVote } from '../voting/pending.ts';
import { currentKey, deferredWindow, mnId, offlineSigningRequest, offlineVoteTime, OUTCOME_NAME, voterawCommand, type CurrentVote, type Intent, type Outcome } from '../voting/plan.ts';
import { deferredUnavailable, describeVote, relaySummary, VOTE_NOW_DELAY_TEXT, voteButtonText } from '../voting/status.ts';
import { Badge, fmtTime, mnName, OUTCOME_LABEL, OutcomeChip, useLabels } from './vote/common.tsx';
import { VoteSuccess } from './vote/VoteSuccess.tsx';
import { VoteTracker } from './vote/VoteTracker.tsx';
import '../voting/voting.css';

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

export function VoteComposer({ proposals, onVerify }: { proposals: Proposal[]; onVerify?: () => void }) {
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
  const relays = relaySummary(k.relays, k.relayHealth);
  const latestRelease = mode === 'deferred' && window ? Math.min(window.latest, withinH ? now + Number(withinH) * 3600 : Infinity) : null;
  const buttonText = k.busy?.startsWith('Signing')
    ? `${k.busy}…`
    : !chosen.length
      ? 'Select at least one masternode'
      : multi
        ? `${mode === 'deferred' ? 'Schedule' : 'Sign and send'} ${toSend.length} vote${toSend.length === 1 ? '' : 's'}`
        : voteButtonText(single, new Set(toSend.map((r) => r.intent.mn.proTxHash)).size || chosen.length, mode === 'deferred');
  // The button already says what the hint would (e.g. "Select at least one masternode"), so the hint is then left out.
  const hint = disabledHint && disabledHint.replace(/\.$/, '') !== buttonText ? disabledHint : null;

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

  // what the chosen masternodes have on the network now, in one line
  const nowLine = (govHash: string) => {
    const tally = { Yes: 0, No: 0, Abstain: 0, 'not voted': 0 };
    for (const m of chosen) {
      const o = current.get(currentKey(m, govHash))?.outcome;
      tally[o === 1 ? 'Yes' : o === 2 ? 'No' : o === 3 ? 'Abstain' : 'not voted']++;
    }
    return Object.entries(tally)
      .filter(([, n]) => n)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
  };
  const mnsSummary = chosen.length === usable.length ? `With ${usable.length === 1 ? 'your masternode' : `all ${usable.length} of your masternodes`}` : `With ${chosen.length} of ${usable.length} masternodes`;

  return (
    <div className="vcomp" data-testid="vote-composer">
      {multi ? (
        <ul className="vprops">
          {proposals.map((p) => (
            <li key={p.govHash} className="vprop" data-testid="vote-proposal-row">
              <div className="vprop-name">
                <Link to={`/p/h/${p.govHash}`}>{p.name}</Link>
                <span className="small muted">{loading ? 'reading current votes…' : `Now: ${nowLine(p.govHash) || 'no masternodes selected'}`}</span>
              </div>
              <OutcomePicker size="s" clearable label={`Vote on ${p.name}`} value={choice[p.govHash] ?? 0} onChange={(o) => setChoice({ ...choice, [p.govHash]: o })} testId="vote-choice" />
            </li>
          ))}
        </ul>
      ) : (
        <OutcomePicker label="Your vote" value={single} onChange={(o) => setChoice({ [proposals[0]!.govHash]: o })} testId="vote-choice" />
      )}

      <details className="vcomp-mns" data-testid="vote-mns">
        <summary>
          <span>{mnsSummary}</span>
          {!multi && <span className="small muted">{loading ? 'reading their votes…' : `now ${nowLine(proposals[0]!.govHash) || 'none selected'}`}</span>}
          <span className="vcomp-change">Change</span>
        </summary>
        {usable.length > 1 && (
          <label className="check vcomp-all">
            <input type="checkbox" checked={chosen.length === usable.length} onChange={(e) => setSelected(e.target.checked ? null : new Set())} /> All masternodes
          </label>
        )}
        <ul className="vmn-list">
          {usable.map((m) => {
            const g = proposals[0]!.govHash;
            const cur = current.get(currentKey(m, g));
            const pend = !multi ? pendingFor(k.watched, m, g) : undefined;
            const v = pend ? describeVote(pend, now, fmtTime) : null;
            return (
              <li key={m.proTxHash} className={`vmn${sel(m) ? ' vmn-on' : ''}`} data-testid="vote-mn-row" data-protx={m.proTxHash}>
                <label className="vmn-pick">
                  <input type="checkbox" checked={sel(m)} onChange={(e) => toggle(m, e.target.checked)} aria-label={`Vote with ${mnName(m, labels)}`} />
                  <span className="vmn-name">{mnName(m, labels)}</span>
                  {m.type === 'evo' && <span className="chip vmn-evo">Evonode ×4</span>}
                </label>
                {!multi && (
                  <div className="vmn-state">
                    <span className="vmn-cur" data-testid="current-vote">
                      <span className="vmn-k">Now</span> {loading ? <span className="muted">…</span> : <OutcomeChip outcome={cur?.outcome} />}
                    </span>
                    {pend && v && (
                      <span className="vmn-pend" data-testid="pending-vote">
                        <span className="vmn-k">Sent</span> <OutcomeChip outcome={pend.outcome} muted /> <Badge tone={v.tone}>{v.badge}</Badge>
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </details>

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

      <details className="vwhen">
        <summary>
          <span>{mode === 'deferred' ? 'Spread out over time' : 'Send now'}</span>
          <span className="vcomp-change">Options</span>
        </summary>
        <fieldset className="vwhen-opts">
          <legend className="visually-hidden">When to send</legend>
          <label className={`vwhen-opt${mode === 'now' ? ' on' : ''}`}>
            <input type="radio" name="vote-when" checked={mode === 'now'} onChange={() => setMode('now')} />
            <span>
              <b>Now</b>
              <span className="small muted">{VOTE_NOW_DELAY_TEXT}</span>
            </span>
          </label>
          <label className={`vwhen-opt${mode === 'deferred' ? ' on' : ''}${unavailable ? ' off' : ''}`}>
            <input type="radio" name="vote-when" checked={mode === 'deferred'} onChange={() => setMode('deferred')} disabled={!!unavailable} data-testid="vote-deferred" aria-describedby="vote-deferred-why" />
            <span>
              <b>Spread out (more private)</b>
              <span className="small muted" id="vote-deferred-why" data-testid="vote-deferred-why">
                {unavailable ?? 'Each masternode at its own random time before the deadline, so they are not seen voting together.'}
              </span>
            </span>
          </label>
        </fieldset>
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
      </details>

      <div className="vgo">
        <button type="button" className="btn btn-primary btn-l vgo-btn" disabled={blocked || !toSend.length} onClick={go} data-testid="vote-send" aria-describedby={hint ? 'vote-send-hint' : undefined}>
          {buttonText}
        </button>
        {toSend.length > 0 && !blocked && (
          <p className={`vgo-sum small ${relays.warn && mode !== 'deferred' && !k.demo ? 'vwarn' : 'muted'}`} data-testid="vote-summary">
            {mode === 'deferred' && latestRelease ? `Signed here, released at random times before ${fmtTime(latestRelease)}.` : k.demo ? 'Signed in your browser. In demo mode nothing is sent.' : relays.text}
          </p>
        )}
        {hint && (
          <p className={`small ${currentError ? 'error' : 'muted'}`} id="vote-send-hint" data-testid="vote-send-hint">
            {currentError ? `Your current votes could not be read from the bridge (${currentError}); voting waits until they can.` : hint}
          </p>
        )}
        {skipped.map((s) => (
          <p key={s} className="small muted">
            {s}
          </p>
        ))}
      </div>

      {wins.map((w) => (
        <VoteSuccess key={w.voteHash} vote={w} name={mnName(w, labels)} proposalName={byHash.get(w.govHash)?.name ?? shortHash(w.govHash, 6)} {...(onVerify ? { onRecount: onVerify } : {})} />
      ))}
      {tracked.length > 0 && (
        <section className="vtracks" aria-label="Your votes on their way" data-testid="vote-tracks">
          {tracked.slice(0, 8).map((w) => (
            <VoteTracker key={w.voteHash} vote={w} name={`${mnName(w, labels)}${multi ? `, ${byHash.get(w.govHash)?.name ?? ''}` : ''}`} />
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * Offline signing: what to sign elsewhere, timed when the user asks (and shown), after the masternode's current vote by Core's
 * one-change-per-hour rule. Mainnet: the exact text for `signmessage`. Testnet: the vote hash (Core checks a signature over the binary
 * hash, which `signmessage` cannot make) and the `voteraw` command, for custom tooling. Either way a signature can be pasted back and
 * is checked here before it is sent. No key enters the page.
 */
export function OfflineSign({ proposal }: { proposal: Proposal }) {
  const k = useKeyring();
  const { registry } = useApp();
  const network: Network = k.coreNetwork;
  const [address, setAddress] = useState('');
  const [outcome, setOutcome] = useState<Outcome>(1);
  const [mns, setMns] = useState<Array<BridgeMasternode & { time: number; releaseAt: number; hourRule: boolean }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sigs, setSigs] = useState<Record<string, string>>({});
  const find = async () => {
    setErr(null);
    setMns(null);
    setSigs({});
    const d = decodeAddress(address.trim(), network);
    if (!d || d.type !== 'p2pkh') return setErr(`Enter a ${network} voting address.`);
    const b = enabledBridges(registry)[0];
    if (!b) return setErr('No bridge configured.');
    try {
      const bridge = new HttpBridge(b.name, b.httpBase);
      const list = (await bridge.mnlist()).masternodes.filter((m) => m.votingAddress === address.trim() && m.valid);
      // the masternodes' current votes on this proposal (the bridge's set; 404 = none yet): Core's one-change-per-hour rule
      const votes = list.length ? await bridge.votes(proposal.govHash).catch((e) => (e instanceof BridgeError && e.status === 404 ? null : Promise.reject(e))) : null;
      const now = Math.floor(Date.now() / 1000);
      setMns(
        list.map((m) => {
          // the latest of: the bridge's votes this address signed (checked here), and ours that went out or may have
          const fromBridge = (votes?.votes ?? []).filter((v) => v.signal === 1 && mnId(v) === mnId(m) && v.time <= now + VOTE_MAX_FUTURE_S && verifyVoteSignature(v.sig, { collateralTxid: v.collateralTxid, collateralIndex: v.collateralIndex, govHashDisplay: proposal.govHash, signal: 1, outcome: v.outcome, time: v.time }, d.hash160, network));
          const ours = k.watched.filter((w) => w.govHash === proposal.govHash && mnId(w) === mnId(m) && (w.status === 'broadcast' || w.status === 'held' || w.status === 'confirmed' || (w.status === 'queued' && !!w.maybeAt?.length)));
          const cur = [...fromBridge, ...ours].sort((a, b) => b.time - a.time)[0];
          return { ...m, ...offlineVoteTime(now, cur) };
        }),
      );
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const submit = async (m: BridgeMasternode & { time: number; releaseAt: number }) => {
    const sig = (sigs[m.proTxHash] ?? '').trim();
    const fields = { collateralTxid: m.collateralTxid.toLowerCase(), collateralIndex: m.collateralIndex, govHashDisplay: proposal.govHash, signal: 1, outcome, time: m.time };
    const signer = recoverVoteSigner(sig, fields, network);
    const d = decodeAddress(address.trim(), network);
    if (!signer || !d || !bytesEqual(signer.keyId, d.hash160)) return setErr(`That signature is not by this voting address over this ${network === 'testnet' ? 'vote hash' : 'text'}.`);
    setErr(null);
    await k.submitSigned({ proTxHash: m.proTxHash, collateralTxid: fields.collateralTxid, collateralIndex: m.collateralIndex, govHash: proposal.govHash, outcome, time: m.time, releaseAt: m.releaseAt, sig, voteHash: governanceVoteHash(fields), network }).catch(() => {});
  };
  return (
    <details className="vote-offline">
      <summary>Sign offline instead (Dash Core, hardware wallet)</summary>
      {network === 'testnet' ? (
        <p className="notice-box small" data-testid="offline-testnet">
          On testnet, Core checks a signature over the binary vote hash, which <code>signmessage</code> (Dash Core, DMT, hardware wallets) cannot make. Sign the hash below with your own tooling and paste the signature back, or broadcast it yourself with the <code>voteraw</code> command shown.
        </p>
      ) : (
        <p className="small muted">Paste your voting address, sign each line below with <code>signmessage &lt;address&gt; "&lt;text&gt;"</code>, and paste the signature back. The key never enters this page.</p>
      )}
      <div className="form-actions">
        <input value={address} onChange={(e) => (setAddress(e.target.value), setMns(null))} placeholder="voting address" aria-label="Voting address" className="mono-ish vinput" />
        <select value={outcome} onChange={(e) => (setOutcome(Number(e.target.value) as Outcome), setMns(null))} aria-label="Vote" className="vinput">
          <option value={1}>Yes</option>
          <option value={2}>No</option>
          <option value={3}>Abstain</option>
        </select>
        <button type="button" className="btn" onClick={find}>
          {mns ? 'Time it again' : 'Show what to sign'}
        </button>
      </div>
      {err && <p className="error small">{err}</p>}
      {mns && (k.status !== 'open' || k.memoryOnly) && <p className="muted small">Your saved keyring is not open: unless it was opened earlier in this session, this browser follows a vote sent from here only until the tab closes (the relay still holds and sends it).</p>}
      {mns && !mns.length && <p className="muted small">No valid masternode votes with that address.</p>}
      {mns?.map((m) => {
        const vote = { mn: m, govHash: proposal.govHash, outcome, time: m.time };
        const req = offlineSigningRequest(vote, network);
        const held = k.watched.filter((w) => isOpen(w) && w.status !== 'broadcast' && !w.restored && w.govHash === proposal.govHash && mnId(w) === mnId(m));
        return (
          <div key={m.proTxHash} className="vote-offline-row" data-testid="offline-row">
            <div className="small">Masternode {shortHash(m.proTxHash, 6)}</div>
            <p className="small muted" data-testid="offline-time">
              Vote time (nTime) {m.time} ({fmtTime(m.time)}), set when you asked{m.hourRule ? ': Core allows one change per hour after this masternode’s current vote, so the relay holds it until then' : ''}. Sign and send it soon; if it has been a while, time it again.
            </p>
            {held.length > 0 && (
              <div className="vwarn small" data-testid="offline-held">
                <p>A vote of this masternode on this proposal that you signed here is still on its way. It could be released after this one and replace it: cancel it first.</p>
                {held.map((w) => (
                  <button key={w.voteHash} type="button" className="btn btn-s" onClick={() => void k.cancel(w.voteHash).catch(() => {})} disabled={!!k.busy}>
                    Cancel the {OUTCOME_NAME[w.outcome]} vote
                  </button>
                ))}
              </div>
            )}
            {req.message ? <pre className="code">{req.message}</pre> : <pre className="code" data-testid="offline-hash">vote signature hash (internal byte order): {req.hashHex}</pre>}
            {network === 'testnet' && (
              <pre className="code small" data-testid="offline-voteraw">
                {voterawCommand(vote)}
              </pre>
            )}
            <div className="form-actions">
              <input value={sigs[m.proTxHash] ?? ''} onChange={(e) => setSigs({ ...sigs, [m.proTxHash]: e.target.value })} placeholder="signature (base64)" aria-label="Signature" className="mono-ish vinput" data-testid="offline-sig" />
              <button type="button" className="btn" onClick={() => void submit(m)} disabled={!k.relays.length || held.length > 0}>
                Send
              </button>
            </div>
          </div>
        );
      })}
    </details>
  );
}

export function ProposalVotePanel({ proposal, onVerify }: { proposal: Proposal; onVerify?: () => void }) {
  const k = useKeyring();
  return (
    <section id="vote" aria-labelledby="mnvote-title" className="panel mnvote" data-testid="mn-vote-panel">
      <header className="mnvote-head">
        <h2 id="mnvote-title">Your vote</h2>
        {k.demo && k.status === 'open' && <span className="tag tag-demo">Demo: votes aren't sent</span>}
      </header>
      {k.error && k.status === 'open' && (
        <p className="error small" role="alert">
          {k.error}
        </p>
      )}
      <VoteComposer proposals={[proposal]} {...(onVerify ? { onVerify } : {})} />
      <OfflineSign proposal={proposal} />
    </section>
  );
}
