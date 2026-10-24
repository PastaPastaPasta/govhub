// The "can't lie" panel: collateral check runs automatically in the worker; vote verification
// runs on demand (it downloads every signed vote and the MN list from a bridge).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import type { Proposal } from '../data/types.ts';
import { formatInt, shortHash } from '../lib/format.ts';
import type { CollateralVerdict, Step } from '../verify/collateral.ts';
import { runVerification } from '../verify/client.ts';
import type { WorkerResponse } from '../verify/protocol.ts';
import { ProvGlyph } from './Provenance.tsx';
import { voteVerdict, type VoteLevel } from '../verify/verdict.ts';
import type { VoteTarget } from '../verify/votes.ts';

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

const VERDICT_CLASS: Record<VoteLevel, string> = {
  verified: 'verdict-ok',
  'keys-reported': 'verdict-partial',
  'different-height': 'verdict-partial',
  mismatch: 'verdict-fail',
  'no-tally': 'verdict-pending',
};
const VERDICT_GLYPH: Record<VoteLevel, 'verified' | 'mismatch' | 'reported'> = {
  verified: 'verified',
  'keys-reported': 'reported',
  'different-height': 'reported',
  mismatch: 'mismatch',
  'no-tally': 'reported',
};

function verdictText(level: VoteLevel, verified: number, total: number, matched: string | undefined, fixtures: boolean): string {
  const sigs = `${formatInt(verified)} of ${formatInt(total)} signatures check out`;
  switch (level) {
    case 'verified':
      return `Tally verified: ${sigs} and the recount matches the ${matched}`;
    case 'keys-reported':
      return fixtures
        ? `Recount matches the ${matched}: ${sigs}. Voting keys come from the fixture bridge (synthetic voters)`
        : `Recount matches the ${matched}: ${sigs}, but the voting keys are only as the bridge reports them. Confirm them with the DAPI masternode list for a verified result`;
    case 'different-height':
      return `Recount differs from the published tallies, which are older than the votes (${sigs}). Expected between tally updates`;
    case 'mismatch':
      return `Tally mismatch: the recount from ${formatInt(verified)} valid votes differs from a tally at the same height`;
    default:
      return `${sigs}; there is no published tally to compare with`;
  }
}

export function VerificationPanel({
  proposal,
  collateral,
  targets,
  onVotes,
}: {
  proposal: Proposal;
  collateral: ReturnType<typeof useCollateralCheck>;
  /** Published tallies to compare the recount with. */
  targets: VoteTarget[];
  onVotes(r: VotesDone | null): void;
}) {
  const { source, registry, mode } = useApp();
  const bridge = source.bridgeDescriptor();
  const [sml, setSml] = useState(true);
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
        targets,
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
  const vv = r && votes.result ? voteVerdict(r, votes.result.votesAsOf) : null;
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
                  <input type="checkbox" checked={sml} onChange={(e) => setSml(e.target.checked)} /> Confirm voting keys with the DAPI masternode list from two nodes (about 3 MB; needed for a verified result)
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
          <div className="votes-result" data-votes={vv!.level}>
            <p className={`verdict ${VERDICT_CLASS[vv!.level]}`}>
              <ProvGlyph kind={VERDICT_GLYPH[vv!.level]} />
              {verdictText(vv!.level, r.verified, r.total, vv!.matched?.name, mode === 'fixtures')}
            </p>
            <p className="muted small">
              {formatInt(r.total)} votes from {votes.result.bridge} (as of block {formatInt(votes.result.votesAsOf)}), masternode list at block {formatInt(votes.result.mnlistHeight)}
              {votes.result.sml && `, voting keys confirmed against the DAPI masternode list from ${votes.result.sml.nodes.join(' and ')} (${formatInt(r.smlChecked)} checked; ${formatInt(votes.result.sml.validWeighted)} weighted valid MNs)`}
              {r.rejectedTime > 0 && `, ${r.rejectedTime} dropped for a time Core would reject`}
              {r.otherSignal > 0 && `, ${r.otherSignal} votes on other signals skipped`}. Superseded votes are counted once, latest wins.
              {r.keysFrom === 'sml' && r.internalCollateral < r.verified && ` Which collateral belongs to which masternode is as the bridge reports it for ${formatInt(r.verified - r.internalCollateral)} votes (ProRegTx check not done yet).`}
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
            {r.targets.length > 0 && (
              <table className="compare">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col" className="r">
                      Recounted
                    </th>
                    {r.targets.map((t) => (
                      <th scope="col" className="r" key={t.name}>
                        {t.name}
                        <br />
                        <span className="muted">block {formatInt(t.asOfHeight)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.targets[0]!.compare.map((c, i) => (
                    <tr key={c.field}>
                      <th scope="row">{c.field}</th>
                      <td className="r">{typeof c.computed === 'number' ? formatInt(c.computed) : shortHash(c.computed, 6)}</td>
                      {r.targets.map((t) => {
                        const tc = t.compare[i]!;
                        return (
                          <td key={t.name} className={`r${tc.ok ? '' : ' bad'}`}>
                            {typeof tc.expected === 'number' ? formatInt(tc.expected) : shortHash(tc.expected || '(none)', 6)} <ProvGlyph kind={tc.ok ? 'verified' : 'mismatch'} />
                            <span className="visually-hidden">{tc.ok ? 'matches' : 'differs'}</span>
                          </td>
                        );
                      })}
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
