// The "can't lie" panel: collateral check runs automatically in the worker; vote verification
// runs on demand (it downloads every signed vote and the MN list from a bridge).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import type { Proposal, Sourced, Tally } from '../data/types.ts';
import { formatInt, shortHash } from '../lib/format.ts';
import type { CollateralVerdict, Step } from '../verify/collateral.ts';
import { runVerification } from '../verify/client.ts';
import type { WorkerResponse } from '../verify/protocol.ts';
import { ProvGlyph } from './Provenance.tsx';

type VotesDone = Extract<WorkerResponse, { kind: 'votes' }>;

const STEP_GLYPH: Record<Step['status'], 'verified' | 'mismatch' | 'reported' | 'fixture'> = { ok: 'verified', fail: 'mismatch', warn: 'reported', skip: 'fixture' };

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.id} className={`step step-${s.status}`} data-step={s.id} data-status={s.status}>
          <ProvGlyph kind={STEP_GLYPH[s.status]} />
          <span className="step-label">{s.label}</span>
          <span className="step-detail">{s.detail}</span>
        </li>
      ))}
    </ol>
  );
}

export function useCollateralCheck(p: Proposal | undefined) {
  const { source } = useApp();
  const [verdict, setVerdict] = useState<CollateralVerdict | null>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!p) return;
    let live = true;
    setVerdict(null);
    setError(null);
    runVerification({ kind: 'collateral', proposal: p, dapi: source.dapiDescriptor() }, (m) => live && setProgress(m)).then(
      (r) => live && setVerdict(r.verdict),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [p, source]);
  return { verdict, progress, error };
}

export function VerificationPanel({
  proposal,
  collateral,
  expectedTally,
  onVotes,
}: {
  proposal: Proposal;
  collateral: ReturnType<typeof useCollateralCheck>;
  expectedTally: Sourced<Tally> | null;
  onVotes(r: VotesDone | null): void;
}) {
  const { source, registry, mode } = useApp();
  const bridge = source.bridgeDescriptor();
  const [sml, setSml] = useState(false);
  const [votes, setVotes] = useState<{ running: boolean; progress?: string; result?: VotesDone; error?: string }>({ running: false });
  const { verdict, progress, error } = collateral;

  const verifyVotes = () => {
    if (!bridge) return;
    setVotes({ running: true, progress: 'Starting' });
    onVotes(null);
    runVerification(
      {
        kind: 'votes',
        govHash: proposal.govHash,
        expected: expectedTally?.value ?? null,
        bridge,
        dapi: source.dapiDescriptor(),
        network: registry.coreNetwork,
        now: source.now(),
        crossCheckSml: sml && mode === 'live',
      },
      (m) => setVotes((v) => ({ ...v, progress: m })),
    ).then(
      (result) => {
        setVotes({ running: false, result });
        onVotes(result);
      },
      (e: Error) => setVotes({ running: false, error: e.message }),
    );
  };

  const r = votes.result?.result;
  const problems = r ? Object.entries(r.problems).filter(([, n]) => n > 0) : [];

  return (
    <section className="verify" aria-labelledby="verify-title">
      <h2 id="verify-title">Verification</h2>
      <p className="muted small">These checks run in your browser, in a background worker, against Core data fetched from DAPI evonodes.</p>

      <div className="verify-block" aria-live="polite" data-testid="collateral-check">
        {verdict ? (
          <p className={`verdict ${verdict.ok ? 'verdict-ok' : 'verdict-fail'}`} data-verdict={verdict.ok ? 'ok' : 'fail'}>
            <ProvGlyph kind={verdict.ok ? 'verified' : 'mismatch'} />
            {verdict.ok ? 'Content matches the on-chain collateral' : 'Content does not match the on-chain collateral'}
          </p>
        ) : error ? (
          <p className="verdict verdict-fail">
            <ProvGlyph kind="mismatch" /> Collateral check could not run: {error}
          </p>
        ) : (
          <p className="verdict verdict-pending" aria-busy="true">
            <span className="spinner" aria-hidden="true" /> {progress || 'Checking the collateral'}…
          </p>
        )}
        {verdict && <Steps steps={verdict.steps} />}
      </div>

      <div className="verify-block" aria-live="polite" data-testid="votes-check">
        <h3>Votes</h3>
        {!bridge ? (
          <p className="muted">
            Signed votes come from a bridge, because DAPI has no governance calls. <Link to="/settings">Add a bridge in Settings</Link> to verify this tally.
          </p>
        ) : (
          <>
            <p className="muted small">
              Downloads every signed vote from {bridge.kind === 'fixture' ? 'the fixture bridge' : bridge.name}, checks each signature against the masternode voting key, recounts the weighted tally and compares it with the Platform tally document.
            </p>
            <div className="verify-actions">
              <button type="button" className="btn btn-primary" onClick={verifyVotes} disabled={votes.running}>
                {votes.running ? 'Verifying…' : r ? 'Verify again' : 'Verify votes'}
              </button>
              {mode === 'live' && (
                <label className="check">
                  <input type="checkbox" checked={sml} onChange={(e) => setSml(e.target.checked)} /> Also cross-check voting keys with the DAPI masternode list (about 1.4 MB)
                </label>
              )}
            </div>
          </>
        )}
        {votes.running && (
          <p className="verdict verdict-pending" aria-busy="true">
            <span className="spinner" aria-hidden="true" /> {votes.progress}…
          </p>
        )}
        {votes.error && <p className="error">Vote verification failed: {votes.error}</p>}
        {r && votes.result && (
          <div className="votes-result" data-votes={r.matches === null ? 'no-tally' : r.matches ? 'match' : 'mismatch'}>
            <p className={`verdict ${r.matches === false ? 'verdict-fail' : r.matches ? 'verdict-ok' : 'verdict-pending'}`}>
              <ProvGlyph kind={r.matches === false ? 'mismatch' : r.matches ? 'verified' : 'reported'} />
              {r.matches === null
                ? `${formatInt(r.verified)} of ${formatInt(r.total)} votes verified; there is no Platform tally to compare with`
                : r.matches
                  ? `Tally verified: ${formatInt(r.verified)} of ${formatInt(r.total)} signatures check out and the recount matches the Platform tally`
                  : `Tally mismatch: the recount from ${formatInt(r.verified)} valid votes differs from the Platform tally`}
            </p>
            <p className="muted small">
              {formatInt(r.total)} votes from {votes.result.bridge} (as of block {formatInt(votes.result.votesAsOf)}), masternode list at block {formatInt(votes.result.mnlistHeight)}
              {votes.result.sml && `, voting keys cross-checked against the DAPI list from ${votes.result.sml.node} (${formatInt(r.smlChecked)} checked)`}
              {r.rejectedTime > 0 && `, ${r.rejectedTime} dropped for a time Core would reject`}. Superseded votes are counted once, latest wins.
            </p>
            {problems.length > 0 && (
              <ul className="problems">
                {problems.map(([k, n]) => (
                  <li key={k}>
                    {formatInt(n)} {k.replace(/-/g, ' ')}
                  </li>
                ))}
              </ul>
            )}
            {r.compare.length > 0 && (
              <table className="compare">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col" className="r">
                      Platform tally
                    </th>
                    <th scope="col" className="r">
                      Recounted
                    </th>
                    <th scope="col">
                      <span className="visually-hidden">Result</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.compare.map((c) => (
                    <tr key={c.field} className={c.ok ? '' : 'bad'}>
                      <th scope="row">{c.field}</th>
                      <td className="r">{typeof c.expected === 'number' ? formatInt(c.expected) : shortHash(c.expected || '(none)', 6)}</td>
                      <td className="r">{typeof c.computed === 'number' ? formatInt(c.computed) : shortHash(c.computed, 6)}</td>
                      <td>
                        <ProvGlyph kind={c.ok ? 'verified' : 'mismatch'} />
                        <span className="visually-hidden">{c.ok ? 'matches' : 'differs'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {r.examples.length > 0 && (
              <details>
                <summary>Problem votes</summary>
                <ul className="small mono-ish">
                  {r.examples.map((x, i) => (
                    <li key={i}>
                      {shortHash(x.outpoint, 8)}: {x.problem}, {x.detail}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
