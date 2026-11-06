// Masternode voting UI (PLAN §5.1-5.2). One proposal (the proposal page's panel) or many (/votes): pick Yes / No / Abstain for the
// selected masternodes, sign in the browser, send through the relays now or each masternode at its own random time before the
// deadline, then follow every vote until the network counts it. Also offline signing (the exact text for `signmessage`).
import { bytesEqual, decodeAddress, governanceVoteHash, recoverVoteSigner, verifyVoteSignature, VOTE_MAX_FUTURE_S, type Network } from '@govhub/verify';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Link } from './Link.tsx';
import { useApp } from '../app/context.tsx';
import { errorText } from '../auth/runtime.ts';
import { enabledBridges } from '../config/registry.ts';
import { BridgeError, HttpBridge, type BridgeMasternode, type BridgeVote } from '../data/bridge.ts';
import type { Proposal } from '../data/types.ts';
import { shortHash } from '../lib/format.ts';
import { votingDeadlineTime } from '../lib/governance.ts';
import { useKeyring } from '../voting/KeyringContext.tsx';
import type { OwnedMasternode } from '../voting/masternodes.ts';
import { isOpen, type WatchedVote } from '../voting/pending.ts';
import { currentKey, deferredWindow, mnId, offlineSigningRequest, offlineVoteTime, OUTCOME_NAME, voterawCommand, type CurrentVote, type Intent, type Outcome } from '../voting/plan.ts';
import { deferredUnavailable, describeVote, relaySummary, VOTE_NOW_DELAY_TEXT, voteButtonText } from '../voting/status.ts';
import { Badge, CopyButton, fmtTime, mnName, OUTCOME_LABEL, OutcomeChip, useLabels } from './vote/common.tsx';
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
export function OutcomePicker({ value, onChange, label, size = 'l', clearable = false, testId, disabled = false }: { value: Outcome | 0; onChange(o: Outcome | 0): void; label: string; size?: 'l' | 's'; clearable?: boolean; testId?: string; disabled?: boolean }) {
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
          disabled={disabled}
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

/** `onlyMn`: start with just this masternode selected (when the keyring has it), e.g. from a masternode's own page. */
export function VoteComposer({ proposals, onVerify, onlyMn }: { proposals: Proposal[]; onVerify?: () => void; onlyMn?: string }) {
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
  const [selected, setSelected] = useState<Set<string> | null>(() => (onlyMn && k.mns.owned.some((m) => m.valid && m.proTxHash.toLowerCase() === onlyMn) ? new Set(k.mns.owned.filter((m) => m.proTxHash.toLowerCase() === onlyMn).map((m) => m.proTxHash)) : null)); // null = all
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
      <div className="vempty dh-empty" data-testid="vote-cta">
        <p>{k.status === 'signed-out' ? 'Masternode owners: voting from this browser needs an account here and your voting keys. Each proposal page can also sign offline, with no account.' : 'Unlock your masternode keyring to vote here.'}</p>
        <Link className="btn dh-btn" to="/masternodes">
          {k.status === 'signed-out' ? 'Ways to vote' : 'My masternodes'}
        </Link>
      </div>
    );
  }
  if (!usable.length) {
    const finding = k.mns.phase === 'loading' || k.mns.phase === 'idle';
    return (
      <div className="vempty dh-empty" data-testid="vote-none">
        {finding ? (
          <p>
            <span className="spinner" aria-hidden="true" /> Finding your masternodes…
          </p>
        ) : k.mns.phase === 'error' ? (
          <p className="error">Your masternodes could not be looked up: {k.mns.error}</p>
        ) : (
          <p>None of your keyring’s masternodes can vote ({k.keyring?.content.keys.length ? 'none found for your keys, or all PoSe-banned' : 'no voting keys yet'}).</p>
        )}
        <Link className="btn dh-btn btn-s dh-btn--sm" to="/masternodes">
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
                <Link to={`/p/h/${p.govHash}`} className="dh-link">{p.name}</Link>
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
          <label className="check vcomp-all dh-field__label">
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
                <label className="vmn-pick dh-field__label">
                  <input type="checkbox" checked={sel(m)} onChange={(e) => toggle(m, e.target.checked)} aria-label={`Vote with ${mnName(m, labels)}`} />
                  <span className="vmn-name">{mnName(m, labels)}</span>
                  {m.type === 'evo' && <span className="chip vmn-evo">Evonode ×4</span>}
                </label>
                <a className="small dh-link" href={globalThis.window.dashhq?.href('radar', '/mn/' + m.proTxHash, { network: k.coreNetwork })}>View in Radar</a>
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
          <label className="check dh-check">
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
          <label className={[`vwhen-opt${mode === 'now' ? ' on' : ''}`, "dh-field__label"].join(" ")}>
            <input type="radio" name="vote-when" checked={mode === 'now'} onChange={() => setMode('now')} />
            <span>
              <b>Now</b>
              <span className="small muted">{VOTE_NOW_DELAY_TEXT}</span>
            </span>
          </label>
          <label className={[`vwhen-opt${mode === 'deferred' ? ' on' : ''}${unavailable ? ' off' : ''}`, "dh-field__label"].join(" ")}>
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
            <label className="dh-field__label">
              Release within the next{' '}
              <input type="number" min={0.1} step={0.1} value={withinH} onChange={(e) => setWithinH(e.target.value)} placeholder={String(Math.floor((window.latest - now) / 360) / 10)} className="vote-hours dh-input" data-testid="vote-within" /> hours
            </label>
            <label className="check dh-check">
              <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} disabled={k.memoryOnly} /> Back up the held votes in my encrypted keyring (a Platform write, about 0.0015 DASH the first time)
            </label>
            <p className="small muted">The relay you use still sees which votes came from you, and when.</p>
          </div>
        )}
      </details>

      <div className="vgo">
        {k.coreNetwork === 'mainnet' && <p className="small muted">Mainnet · real DASH</p>}
        <button type="button" className="btn dh-btn btn-primary dh-btn--primary vgo-btn" disabled={blocked || !toSend.length} onClick={go} data-testid="vote-send" aria-describedby={hint ? 'vote-send-hint' : undefined}>
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
 * A masternode's latest funding vote on this proposal that we know of: the bridge's votes signed by this voting key (checked here),
 * and ours that went out or may have. Core's one-change-per-hour rule and "later wins" time the next vote after it.
 */
export function latestKnownVote(m: Pick<BridgeMasternode, 'collateralTxid' | 'collateralIndex'>, govHash: string, bridgeVotes: readonly BridgeVote[] | null, keyHash: Uint8Array, watched: readonly WatchedVote[], network: Network, now: number): CurrentVote | undefined {
  const fromBridge = (bridgeVotes ?? []).filter(
    (v) => v.signal === 1 && mnId(v) === mnId(m) && v.time <= now + VOTE_MAX_FUTURE_S && verifyVoteSignature(v.sig, { collateralTxid: v.collateralTxid, collateralIndex: v.collateralIndex, govHashDisplay: govHash, signal: 1, outcome: v.outcome, time: v.time }, keyHash, network),
  );
  const ours = watched.filter((w) => w.govHash === govHash && mnId(w) === mnId(m) && (w.status === 'broadcast' || w.status === 'held' || w.status === 'confirmed' || (w.status === 'queued' && !!w.maybeAt?.length)));
  return [...fromBridge, ...ours].sort((a, b) => b.time - a.time)[0];
}

/** A proposal's published vote set from the first bridge (null: none published yet). */
export async function bridgeVotesFor(registry: Parameters<typeof enabledBridges>[0], govHash: string): Promise<BridgeVote[] | null> {
  const b = enabledBridges(registry)[0];
  if (!b) throw new Error('No bridge configured.');
  const r = await new HttpBridge(b.name, b.httpBase).votes(govHash).catch((e) => (e instanceof BridgeError && e.status === 404 ? null : Promise.reject(e)));
  return r?.votes ?? null;
}

type OfflineMn = BridgeMasternode & { time: number; releaseAt: number; hourRule: boolean };

/**
 * Offline signing: what to sign elsewhere, timed when the user asks (and shown), after the masternode's current vote by Core's
 * one-change-per-hour rule. Mainnet: the whole Dash Core `signmessage` command. Testnet: the vote hash (Core checks a signature over
 * the binary hash, which `signmessage` cannot make) and the `voteraw` command, for custom tooling. Either way a signature can be pasted
 * back and is checked here before it is sent. No key enters the page.
 */
export function OfflineSignBody({ proposal, address: initialAddress = '', outcome }: { proposal: Proposal; address?: string; outcome: Outcome }) {
  const k = useKeyring();
  const { registry } = useApp();
  const network: Network = k.coreNetwork;
  const [address, setAddress] = useState(initialAddress);
  const [mns, setMns] = useState<OfflineMn[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sigs, setSigs] = useState<Record<string, string>>({});
  const [finding, setFinding] = useState(false);
  // the text to sign includes the vote and its time: another choice is timed and shown again
  useEffect(() => setMns(null), [outcome]);
  useEffect(() => setAddress(initialAddress), [initialAddress]);
  const find = async () => {
    setErr(null);
    setMns(null);
    setSigs({});
    const d = decodeAddress(address.trim(), network);
    if (!d || d.type !== 'p2pkh') return setErr(`Enter a ${network === 'testnet' ? 'Testnet' : 'Mainnet'} voting address.`);
    const b = enabledBridges(registry)[0];
    if (!b) return setErr('No bridge configured.');
    setFinding(true);
    try {
      const list = (await new HttpBridge(b.name, b.httpBase).mnlist()).masternodes.filter((m) => m.votingAddress === address.trim() && m.valid);
      const votes = list.length ? await bridgeVotesFor(registry, proposal.govHash) : null;
      const now = Math.floor(Date.now() / 1000);
      setMns(list.map((m) => ({ ...m, ...offlineVoteTime(now, latestKnownVote(m, proposal.govHash, votes, d.hash160, k.watched, network, now)) })));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setFinding(false);
    }
  };
  const submit = async (m: OfflineMn) => {
    const sig = (sigs[m.proTxHash] ?? '').trim();
    const fields = { collateralTxid: m.collateralTxid.toLowerCase(), collateralIndex: m.collateralIndex, govHashDisplay: proposal.govHash, signal: 1, outcome, time: m.time };
    const signer = recoverVoteSigner(sig, fields, network);
    const d = decodeAddress(address.trim(), network);
    if (!signer || !d || !bytesEqual(signer.keyId, d.hash160)) return setErr(`That signature is not by this voting address over this ${network === 'testnet' ? 'vote hash' : 'text'}.`);
    setErr(null);
    await k.submitSigned({ proTxHash: m.proTxHash, collateralTxid: fields.collateralTxid, collateralIndex: m.collateralIndex, govHash: proposal.govHash, outcome, time: m.time, releaseAt: m.releaseAt, sig, voteHash: governanceVoteHash(fields), network, weight: m.type === 'evo' ? 4 : 1 }).catch(() => {});
  };
  return (
    <div className="vote-offline-body" data-testid="offline-body">
      {network === 'testnet' ? (
        <p className="notice-box dh-notice dh-notice--info small" data-testid="offline-testnet">
          On Testnet, Core checks a signature over the binary vote hash, which <code>signmessage</code> (Dash Core, DMT, hardware wallets) cannot make. Sign the hash below with your own tooling and paste the signature back, or broadcast it yourself with the <code>voteraw</code> command shown.
        </p>
      ) : (
        <p className="small muted">
          Enter the masternode’s voting address for the Dash Core command that signs your {OUTCOME_NAME[outcome].toUpperCase()} vote on <span className="mono-ish">{proposal.name}</span>. Run it in Dash Core’s console (or sign its text with a hardware wallet) and paste the signature back.
        </p>
      )}
      <div className="form-actions">
        <input value={address} onChange={(e) => (setAddress(e.target.value), setMns(null))} placeholder="Voting address" aria-label="Voting address" className="mono-ish vinput dh-input" data-testid="offline-address" />
        <button type="button" className="btn dh-btn" onClick={() => void find()} disabled={finding || !address.trim()} data-testid="offline-find">
          {finding ? 'Finding its masternodes…' : mns ? 'Time it again' : network === 'testnet' ? 'Show what to sign' : 'Show the command'}
        </button>
      </div>
      {err && !mns?.length && <p className="error small" role="alert">{err}</p>}
      {mns && !mns.length && <p className="muted small">No masternode that can vote uses this voting address.</p>}
      {mns?.map((m) => {
        const vote = { mn: m, govHash: proposal.govHash, outcome, time: m.time };
        const req = offlineSigningRequest(vote, network);
        const command = req.message ? `signmessage ${address.trim()} "${req.message}"` : null;
        const held = k.watched.filter((w) => isOpen(w) && w.status !== 'broadcast' && !w.restored && w.govHash === proposal.govHash && mnId(w) === mnId(m));
        return (
          <div key={m.proTxHash} className="vote-offline-row" data-testid="offline-row">
            <div className="small">
              <b>{OUTCOME_LABEL[outcome]}</b> on <span className="mono-ish">{proposal.name}</span>, with masternode {shortHash(m.proTxHash, 6)}
              {m.type === 'evo' ? ' (evonode, counts 4 times)' : ''}
            </div>
            {held.length > 0 && (
              <div className="vwarn small" data-testid="offline-held">
                <p>A vote of this masternode on this proposal that you signed here is still on its way. It could be released after this one and replace it: cancel it first.</p>
                {held.map((w) => (
                  <button key={w.voteHash} type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={() => void k.cancel(w.voteHash).catch(() => {})} disabled={!!k.busy}>
                    Cancel the {OUTCOME_NAME[w.outcome]} vote
                  </button>
                ))}
              </div>
            )}
            {command ? (
              <div className="vcmd">
                <pre className="code" data-testid="offline-command">{command}</pre>
                <CopyButton text={command} label="Copy the command" />
              </div>
            ) : (
              <pre className="code" data-testid="offline-hash">vote signature hash (internal byte order): {req.hashHex}</pre>
            )}
            {network === 'testnet' && (
              <pre className="code small" data-testid="offline-voteraw">
                {voterawCommand(vote)}
              </pre>
            )}
            <p className="small muted" data-testid="offline-time">
              Timed {fmtTime(m.time)} (nTime {m.time}){m.hourRule ? ': Core allows one change an hour after this masternode’s current vote, so the relay holds it until then' : ''}. Sign and send it soon; if it has been a while, time it again.
            </p>
            <div className="form-actions">
              <input value={sigs[m.proTxHash] ?? ''} onChange={(e) => setSigs({ ...sigs, [m.proTxHash]: e.target.value })} placeholder="Signature (base64)" aria-label="Signature" className="mono-ish vinput dh-input" data-testid="offline-sig" />
              <button type="button" className="btn dh-btn" onClick={() => void submit(m)} disabled={!k.relays.length || held.length > 0 || !(sigs[m.proTxHash] ?? '').trim() || !!k.busy} data-testid="offline-send">
                Send the vote
              </button>
            </div>
          </div>
        );
      })}
      {err && !!mns?.length && <p className="error small" role="alert">{err}</p>}
      {mns && mns.length > 0 && (k.status !== 'open' || k.memoryOnly) && <p className="muted small">Without an open keyring, this tab follows a vote sent from here until it closes; the relay still holds and sends it.</p>}
    </div>
  );
}

/** Offline signing behind a disclosure, with its own Yes / No / Abstain. `address` fills in the voting address; `open` unfolds it. */
export function OfflineSign({ proposal, address = '', open }: { proposal: Proposal; address?: string; open?: boolean }) {
  const [outcome, setOutcome] = useState<Outcome>(1);
  return (
    <details className="vote-offline" open={open}>
      <summary>Sign offline instead (Dash Core, hardware wallet)</summary>
      <OutcomePicker size="s" label="Vote to sign" value={outcome} onChange={(o) => o && setOutcome(o)} testId="offline-choice" />
      <OfflineSignBody proposal={proposal} address={address} outcome={outcome} />
    </details>
  );
}

export function ProposalVotePanel({ proposal, onVerify }: { proposal: Proposal; onVerify?: () => void }) {
  const k = useKeyring();
  return (
    <section id="vote" aria-labelledby="mnvote-title" className="panel dh-card mnvote" data-testid="mn-vote-panel">
      <header className="mnvote-head">
        <h2 id="mnvote-title">Your vote</h2>
        {k.demo && k.status === 'open' && <span className="tag dh-badge tag-demo">Demo: votes aren't sent</span>}
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
