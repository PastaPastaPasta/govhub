// Masternode voting UI (PLAN §5.1-5.2): choose yes / no / abstain per proposal for all or selected masternodes of the keyring,
// sign in the browser with the network's scheme, send through the relays (now, or each masternode at its own random time before
// the deadline), and watch every vote until the bridge shows it. Also offline signing (the exact text for `signmessage`).
import { bytesEqual, decodeAddress, governanceVoteHash, recoverVoteSigner, type Network } from '@govhub/verify';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { errorText } from '../auth/runtime.ts';
import { enabledBridges } from '../config/registry.ts';
import { HttpBridge, type BridgeMasternode } from '../data/bridge.ts';
import type { Proposal } from '../data/types.ts';
import { formatDateTime, shortHash } from '../lib/format.ts';
import { votingDeadlineTime } from '../lib/governance.ts';
import { useKeyring } from '../voting/KeyringContext.tsx';
import { isOpen } from '../voting/pending.ts';
import { currentKey, deferredWindow, mnId, OUTCOME_NAME, offlineSigningRequest, type CurrentVote, type Intent, type Outcome, type PlanResult } from '../voting/plan.ts';
import '../voting/voting.css';

const OUTCOME_LABEL: Record<number, string> = { 0: '—', 1: 'Yes', 2: 'No', 3: 'Abstain' };

/** The voting deadline of the next superblock (maturity window start), from the cycle in the snapshot. */
export function useDeadline(): number | null {
  const { gov, params } = useApp();
  const c = gov.cycle.data?.value;
  return c ? votingDeadlineTime(c, params) : null;
}

export function useCurrentVotes(govHashes: string[], nonce = 0): { votes: Map<string, CurrentVote>; loading: boolean } {
  const k = useKeyring();
  const [votes, setVotes] = useState(new Map<string, CurrentVote>());
  const [loading, setLoading] = useState(false);
  const key = govHashes.join(',');
  useEffect(() => {
    if (!govHashes.length || k.status !== 'open') return;
    let live = true;
    setLoading(true);
    k.currentVotes(govHashes).then(
      (v) => live && (setVotes(v), setLoading(false)),
      () => live && setLoading(false),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, k.status, k.currentVotes, nonce]);
  return { votes, loading };
}

export function VoteComposer({ proposals, compact = false }: { proposals: Proposal[]; compact?: boolean }) {
  const k = useKeyring();
  const deadline = useDeadline();
  const [nonce, setNonce] = useState(0);
  const { votes: current, loading } = useCurrentVotes(
    proposals.map((p) => p.govHash),
    nonce + k.watched.length,
  );
  const usable = k.mns.owned.filter((m) => m.valid);
  const [selected, setSelected] = useState<Set<string> | null>(null); // null = all
  const [choice, setChoice] = useState<Record<string, Outcome | 0>>({});
  const [mode, setMode] = useState<'now' | 'deferred'>('now');
  const [withinH, setWithinH] = useState('');
  const [backup, setBackup] = useState(false);
  const [result, setResult] = useState<PlanResult | null>(null);
  const labels = useMemo(() => new Map(k.keyring?.content.labels.map((l) => [l.proTxHash, l.label]) ?? []), [k.keyring, k.keyring?.content.labels]);
  const sel = (m: { proTxHash: string }) => (selected ? selected.has(m.proTxHash) : true);
  const now = Math.floor(Date.now() / 1000);
  const window = deadline ? deferredWindow(now, deadline, k.coreNetwork) : null;
  const intents: Intent[] = [];
  for (const p of proposals) {
    const o = choice[p.govHash];
    if (!o) continue;
    for (const m of usable.filter(sel)) intents.push({ mn: m, govHash: p.govHash, outcome: o });
  }
  if (k.status !== 'open') {
    return (
      <div className="notice-box vote-cta" data-testid="vote-cta">
        <p>{k.status === 'signed-out' ? 'Masternode owners: sign in and add your voting keys to vote here.' : 'Unlock your masternode keyring to vote here.'}</p>
        <Link className="btn" to="/masternodes">
          My masternodes
        </Link>
      </div>
    );
  }
  if (!usable.length) {
    return (
      <p className="muted small" data-testid="vote-none">
        {k.mns.loading ? 'Finding your masternodes…' : 'None of your keyring’s masternodes can vote (no keys, or all PoSe-banned).'} <Link to="/masternodes">My masternodes</Link>
      </p>
    );
  }
  const go = async () => {
    setResult(null);
    try {
      const latest = mode === 'deferred' && withinH ? now + Number(withinH) * 3600 : undefined;
      const r = await k.cast(intents, { mode, ...(latest ? { latest } : {}), backupOnPlatform: backup }, deadline, current);
      setResult(r);
      setChoice({});
      setNonce((n) => n + 1);
    } catch {
      /* shown by the provider */
    }
  };
  return (
    <div className="vote-composer" data-testid="vote-composer">
      <table className="vote-table">
        <thead>
          <tr>
            <th>
              <input type="checkbox" aria-label="All masternodes" checked={!selected || selected.size === usable.length} onChange={(e) => setSelected(e.target.checked ? null : new Set())} />
            </th>
            <th>Masternode</th>
            {proposals.map((p) => (
              <th key={p.govHash} title={p.govHash}>
                {compact ? 'Current vote' : p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {usable.map((m) => (
            <tr key={m.proTxHash} data-testid="vote-mn-row">
              <td>
                <input
                  type="checkbox"
                  aria-label={`Vote with ${labels.get(m.proTxHash) ?? shortHash(m.proTxHash)}`}
                  checked={sel(m)}
                  onChange={(e) => {
                    const s = new Set(selected ?? usable.map((x) => x.proTxHash));
                    if (e.target.checked) s.add(m.proTxHash);
                    else s.delete(m.proTxHash);
                    setSelected(s);
                  }}
                />
              </td>
              <td>
                {labels.get(m.proTxHash) ? <b>{labels.get(m.proTxHash)}</b> : <span className="mono-ish">{shortHash(m.proTxHash, 6)}</span>} <span className="muted small">{m.type === 'evo' ? 'evo ×4' : ''}</span>
              </td>
              {proposals.map((p) => {
                const c = current.get(currentKey(m, p.govHash));
                const pending = k.watched.find((w) => isOpen(w) && w.govHash === p.govHash && mnId(w) === mnId(m));
                return (
                  <td key={p.govHash} data-testid="current-vote">
                    {loading ? '…' : OUTCOME_LABEL[c?.outcome ?? 0]}
                    {pending && (
                      <span className="chip" title={`signed ${OUTCOME_NAME[pending.outcome]} for ${formatDateTime(pending.releaseAt)}`}>
                        {pending.status === 'held' ? `${OUTCOME_NAME[pending.outcome]} held` : `${OUTCOME_NAME[pending.outcome]} sent`}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <td>
              <b>New vote</b>
            </td>
            {proposals.map((p) => (
              <td key={p.govHash}>
                <select aria-label={`Vote on ${p.name}`} value={choice[p.govHash] ?? 0} onChange={(e) => setChoice({ ...choice, [p.govHash]: Number(e.target.value) as Outcome | 0 })} data-testid="vote-choice">
                  <option value={0}>no change</option>
                  <option value={1}>Yes</option>
                  <option value={2}>No</option>
                  <option value={3}>Abstain</option>
                </select>
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
      <p className="small muted">
        Current votes come from the bridge's live vote set; each is shown only if its signature checks out against your masternode's voting key here, so a bridge cannot invent or alter them (it could still withhold a newer one). The verification panel on each proposal page recounts the whole set against the proven masternode list.
      </p>
      <fieldset className="vote-timing">
        <legend>When</legend>
        <label className="check">
          <input type="radio" name="vote-when" checked={mode === 'now'} onChange={() => setMode('now')} /> Now
        </label>
        <label className="check">
          <input type="radio" name="vote-when" checked={mode === 'deferred'} onChange={() => setMode('deferred')} disabled={!window} data-testid="vote-deferred" /> Each masternode at its own random time before the deadline
          {!window && <span className="muted small"> (not enough time left)</span>}
        </label>
        {mode === 'deferred' && window && (
          <div className="vote-deferred">
            <label>
              Release within the next{' '}
              <input type="number" min={0.1} step={0.1} value={withinH} onChange={(e) => setWithinH(e.target.value)} placeholder={String(Math.floor((window.latest - now) / 360) / 10)} className="vote-hours" data-testid="vote-within" /> hours
            </label>
            <span className="small muted">latest: {formatDateTime(window.latest)}</span>
            <label className="check">
              <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} disabled={k.memoryOnly} /> Also back up the held votes in my encrypted keyring (a Platform write, about 0.0015 DASH the first time)
            </label>
            <p className="small muted">
              Every masternode gets an independent time, and each vote is a separate request after a random delay, so the network does not see your masternodes vote together. The relay you use still sees which votes came from you, and when.
            </p>
          </div>
        )}
      </fieldset>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={!intents.length || !!k.busy || !k.relays.length || loading} onClick={go} data-testid="vote-send">
          {k.busy?.startsWith('Signing') ? `${k.busy}…` : `Sign and ${mode === 'now' ? 'send' : 'schedule'} ${intents.length} vote${intents.length === 1 ? '' : 's'}`}
        </button>
        {!k.relays.length && <span className="error small">No relay configured (Settings).</span>}
      </div>
      {result && (
        <div className="small" role="status" data-testid="vote-result">
          {result.ok.length} vote{result.ok.length === 1 ? '' : 's'} signed and handed to a relay.
          {result.skipped.map((s, i) => (
            <div key={i} className="muted">
              {shortHash(s.intent.mn.proTxHash, 6)}: {s.reason}
            </div>
          ))}
          {[...new Set(result.ok.flatMap((p) => p.notes))].map((n) => (
            <div key={n} className="muted">
              {n}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WatchedList() {
  const k = useKeyring();
  const list = [...k.watched].sort((a, b) => b.releaseAt - a.releaseAt);
  if (!list.length) return null;
  return (
    <section aria-labelledby="watched-title">
      <h2 id="watched-title">Signed votes</h2>
      <p className="small muted">
        Kept in this browser until the bridge shows them; votes sent from here are re-sent through another relay if they do not show up. Cancelling relies on the relay: a relay that ignored a cancel could still broadcast the held vote at its time, so to change your mind, also cast the new vote (it is timed later and wins).
      </p>
      <div className="vote-table-wrap">
        <table className="vote-table" data-testid="watched">
          <thead>
            <tr>
              <th>Proposal</th>
              <th>Masternode</th>
              <th>Vote</th>
              <th>Release</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((v) => (
              <tr key={v.voteHash} data-testid="watched-row" data-status={v.status}>
                <td className="mono-ish">
                  <Link to={`/p/h/${v.govHash}`}>{shortHash(v.govHash, 6)}</Link>
                </td>
                <td className="mono-ish">{v.proTxHash ? shortHash(v.proTxHash, 6) : `${shortHash(v.collateralTxid, 4)}-${v.collateralIndex}`}</td>
                <td>{OUTCOME_LABEL[v.outcome]}</td>
                <td className="small">{formatDateTime(v.releaseAt)}</td>
                <td>
                  {v.status}
                  {v.rebroadcasts > 0 && <span className="muted small"> (re-sent {v.rebroadcasts}×)</span>}
                </td>
                <td>
                  {v.status === 'held' && (
                    <button type="button" className="btn btn-s" onClick={() => void k.cancel(v.voteHash).catch(() => {})} disabled={!!k.busy} data-testid="vote-cancel">
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="voting address" aria-label="Voting address" className="mono-ish" />
        <select value={outcome} onChange={(e) => setOutcome(Number(e.target.value) as Outcome)} aria-label="Vote">
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
                <input value={sigs[m.proTxHash] ?? ''} onChange={(e) => setSigs({ ...sigs, [m.proTxHash]: e.target.value })} placeholder="signature (base64)" aria-label="Signature" className="mono-ish" />
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
      <h2 id="mnvote-title">Vote with your masternodes</h2>
      {k.error && k.status === 'open' && <p className="error small">{k.error}</p>}
      <VoteComposer proposals={[proposal]} compact />
      <OfflineSign proposal={proposal} />
    </section>
  );
}
