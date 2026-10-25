// The moment a vote reaches the network: a check that draws itself, a short burst in Dash blues, the tally ticking to its new
// count, and ways to check it without trusting this page. prefers-reduced-motion gets the same card, still.
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorText } from '../../auth/runtime.ts';
import { useKeyring, type VoteProof } from '../../voting/KeyringContext.tsx';
import type { WatchedVote } from '../../voting/pending.ts';
import { OUTCOME_NAME } from '../../voting/plan.ts';
import { CopyButton, OUTCOME_LABEL } from './common.tsx';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Counts from `from` to `to` in ~900 ms (at once with reduced motion). */
function useTicker(from: number, to: number): number {
  const [v, setV] = useState(reducedMotion() ? to : from);
  useEffect(() => {
    if (reducedMotion() || from === to) return setV(to);
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 900);
      setV(Math.round(from + (to - from) * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [from, to]);
  return v;
}

function TallyCell({ label, before, after, mine }: { label: string; before: number; after: number; mine: boolean }) {
  const v = useTicker(before, after);
  const diff = after - before;
  return (
    <div className={`vtally-cell${mine ? ' vtally-mine' : ''}`} data-testid={`tally-${label.toLowerCase()}`} data-value={after}>
      <span className="vtally-label">{label}</span>
      <span className="vtally-num num">{v}</span>
      {diff !== 0 && <span className="vtally-diff small">{diff > 0 ? `+${diff}` : diff}</span>}
    </div>
  );
}

/** Pieces of the burst: fixed positions so the card looks the same every time (and in screenshots). */
const BURST = Array.from({ length: 18 }, (_, i) => {
  const a = (i / 18) * Math.PI * 2;
  const r = 46 + (i % 3) * 14;
  return { x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r), d: (i % 5) * 40, s: i % 4 === 0 ? 'b' : i % 3 === 0 ? 'c' : 'a' };
});

/** The check that draws itself, with its burst (also the MN badge's success card). */
export function WinMark() {
  return (
    <div className="vwin-mark" aria-hidden="true">
      <span className="vwin-ring" />
      {BURST.map((b, i) => (
        <span key={i} className={`vwin-bit vwin-bit-${b.s}`} style={{ ['--x' as string]: `${b.x}px`, ['--y' as string]: `${b.y}px`, ['--d' as string]: `${b.d}ms` }} />
      ))}
      <svg viewBox="0 0 52 52" className="vwin-check">
        <circle cx="26" cy="26" r="24" className="vwin-circle" />
        <path d="M15 27l7.5 7.5L38 19" className="vwin-tick" />
      </svg>
    </div>
  );
}

export function VoteSuccess({ vote, name, proposalName, onRecount }: { vote: WatchedVote; name: string; proposalName: string; onRecount?: () => void }) {
  const k = useKeyring();
  const [proof, setProof] = useState<VoteProof | null>(null);
  const [checking, setChecking] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  // take focus only from the voting controls (or nothing): never out of a field the user is typing in elsewhere
  useEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('[data-testid="vote-composer"]')) ref.current?.focus({ preventScroll: true });
  }, []);
  const outcomeName = OUTCOME_NAME[vote.outcome];
  const word = outcomeName.toUpperCase();
  const signed = useMemo(
    () =>
      JSON.stringify({ collateralTxid: vote.collateralTxid, collateralIndex: vote.collateralIndex, govHash: vote.govHash, signal: 'funding', outcome: outcomeName, time: vote.time, sig: vote.sig }, null, 2) +
      `\n\n# Dash Core: submit it yourself\nvoteraw ${vote.collateralTxid} ${vote.collateralIndex} ${vote.govHash} funding ${outcomeName} ${vote.time} ${vote.sig}\n`,
    [vote, outcomeName],
  );
  const coreCmd = `gobject getcurrentvotes ${vote.govHash} ${vote.collateralTxid} ${vote.collateralIndex}`;
  const check = async () => {
    setChecking(true);
    setProofError(null);
    try {
      setProof(await k.verifyVote(vote.voteHash));
    } catch (e) {
      setProofError(errorText(e));
    } finally {
      setChecking(false);
    }
  };
  return (
    <section ref={ref} tabIndex={-1} className="vwin" role="status" data-testid="vote-success" aria-labelledby={`win-${vote.voteHash}`}>
      <WinMark />
      <div className="vwin-body">
        <h3 id={`win-${vote.voteHash}`}>Your vote is on the network</h3>
        <p className="vwin-sub">
          <b>{name}</b> voted <b className={`vwin-word vwin-word-${vote.outcome}`}>{word}</b> on {proposalName}.
        </p>
        {vote.tally ? (
          <div className="vtally" aria-label="Weighted tally with your vote">
            {(['yes', 'no', 'abstain'] as const).map((o, i) => (
              <TallyCell key={o} label={OUTCOME_LABEL[i + 1]!} before={vote.tally!.before[o]} after={vote.tally!.after[o]} mine={vote.outcome === i + 1 || vote.prev?.outcome === i + 1} />
            ))}
          </div>
        ) : (
          <p className="small muted" data-testid="vote-success-recount">
            <span className="spinner" aria-hidden="true" /> Recounting the tally with your vote…
          </p>
        )}
        <details className="vwin-yourself" data-testid="vote-yourself">
          <summary>Check it yourself</summary>
          <div className="vwin-actions">
            <button type="button" className="btn btn-s btn-primary" onClick={() => void check()} disabled={checking} data-testid="vote-verify">
              {checking ? 'Checking…' : proof ? 'Check again' : 'Verify this vote'}
            </button>
            <span className="vwin-copy">
              Signed vote <CopyButton text={signed} label="Copy the signed vote and its voteraw command" />
            </span>
            <span className="vwin-copy">
              Core command <CopyButton text={coreCmd} label="Copy the gobject getcurrentvotes command" />
            </span>
            {k.bridgeBase && (
              <a className="small" href={`${k.bridgeBase}/v1/proposals/${vote.govHash}/votes`} target="_blank" rel="noopener noreferrer">
                Open in the bridge API
              </a>
            )}
            {onRecount && (
              <button type="button" className="btn btn-s btn-quiet" onClick={onRecount}>
                See the full recount
              </button>
            )}
          </div>
          {proofError && <p className="error small">{proofError}</p>}
          {proof && (
            <div className="vproof" data-testid="vote-proof">
              <dl className="vproof-vote">
                <div>
                  <dt>Masternode collateral</dt>
                  <dd className="mono-ish break">
                    {vote.collateralTxid}:{vote.collateralIndex}
                  </dd>
                </div>
                <div>
                  <dt>Vote</dt>
                  <dd>
                    {word}, signed for {new Date(vote.time * 1000).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt>Signature</dt>
                  <dd className="mono-ish break">{vote.sig}</dd>
                </div>
              </dl>
              <ul className="vproof-checks">
                {proof.checks.map((c) => (
                  <li key={c.label} className={c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'unknown'}>
                    <span aria-hidden="true">{c.ok === true ? '✓' : c.ok === false ? '✗' : '?'}</span>
                    <span>
                      <b>{c.label}</b> <span className="muted">{c.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="small muted">
                Anyone running Dash Core can confirm it with <code>{coreCmd.slice(0, 40)}…</code> (copy the full command above).
              </p>
            </div>
          )}
        </details>
      </div>
      <button type="button" className="vwin-close" aria-label="Dismiss" onClick={() => k.dismissCelebration(vote.voteHash)}>
        ×
      </button>
    </section>
  );
}
