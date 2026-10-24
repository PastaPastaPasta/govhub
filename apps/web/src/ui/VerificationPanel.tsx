// The "can't lie" panel: collateral check runs automatically in the worker; vote verification
// runs on demand (it downloads every signed vote and the MN list from a bridge).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import type { Proposal } from '../data/types.ts';
import { formatInt, shortHash } from '../lib/format.ts';
import { runVerification } from '../verify/client.ts';
import type { Step } from '../verify/collateral.ts';
import type { VotesDone } from '../verify/protocol.ts';
import { voteVerdict, type VoteLevel } from '../verify/verdict.ts';
import type { VoteRun, VoteTarget } from '../verify/votes.ts';
import type { CollateralCheck } from './hooks.ts';
import { ProvGlyph } from './Provenance.tsx';

/** A step that passed because a node said so is drawn as "reported", not "verified". */
function stepGlyph(s: Step): 'verified' | 'mismatch' | 'reported' | 'fixture' {
  if (s.status === 'ok') return s.basis === 'reported' ? 'reported' : 'verified';
  return { fail: 'mismatch', warn: 'reported', skip: 'fixture' }[s.status] as 'mismatch' | 'reported' | 'fixture';
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.id} className={`step step-${s.status}`} data-step={s.id} data-status={s.status} data-basis={s.basis ?? 'verified'}>
          <ProvGlyph kind={stepGlyph(s)} />
          <span className="step-label">{s.label}</span>
          <span className="step-detail">{s.detail}</span>
        </li>
      ))}
    </ol>
  );
}

const VERDICT_STYLE: Record<VoteLevel, { className: string; glyph: 'verified' | 'mismatch' | 'reported' }> = {
  verified: { className: 'verdict-ok', glyph: 'verified' },
  'keys-reported': { className: 'verdict-partial', glyph: 'reported' },
  'different-height': { className: 'verdict-partial', glyph: 'reported' },
  mismatch: { className: 'verdict-fail', glyph: 'mismatch' },
  'no-tally': { className: 'verdict-pending', glyph: 'reported' },
};

function verdictText(level: VoteLevel, verified: number, total: number, matched: string | undefined, origin: VotesDone['origin'], fixtures: boolean, smlUnconfirmed: number): string {
  const sigs = `${formatInt(verified)} of ${formatInt(total)} signatures check out`;
  switch (level) {
    case 'verified':
      return `Tally verified: ${sigs} and the recount matches the ${matched}`;
    case 'keys-reported':
      return fixtures
        ? `Recount matches the ${matched}: ${sigs}. Voting keys come from the fixture bridge (${origin === 'recorded' ? 'recorded mainnet votes and masternodes' : 'synthetic voters'})`
        : smlUnconfirmed > 0
          ? `Recount matches the ${matched}: ${sigs}, but ${formatInt(smlUnconfirmed)} voting keys are not confirmed by the current DAPI masternode list (a masternode may have left or changed its key since the tally, or the bridge reports it wrongly)`
          : `Recount matches the ${matched}: ${sigs}, but the voting keys are only as the bridge reports them. Confirm them with the DAPI masternode list for a verified result`;
    case 'different-height':
      return `Recount differs from the published tallies, which are older than the votes (${sigs}). Expected between tally updates`;
    case 'mismatch':
      return `Tally mismatch: the recount from ${formatInt(verified)} valid votes differs from a tally at the same height`;
    case 'no-tally':
      return `${sigs}; there is no published tally to compare with`;
  }
}

/** One recount: what it read, what it dropped, and the field-by-field comparison with the tallies of its height. */
function RunResult({ run, bridge, sml }: { run: VoteRun; bridge: string; sml: VotesDone['sml'] }) {
  const r = run.result;
  const problems = Object.entries(r.problems).filter(([, n]) => n > 0);
  return (
    <div className="vote-run" data-run-height={run.votesAsOf}>
      <p className="muted small">
        {formatInt(r.total)} votes from {bridge} (as of block {formatInt(run.votesAsOf)}), masternode list at block {formatInt(run.mnlistHeight)}
        {sml && `, voting keys confirmed against the masternode list that DAPI nodes ${sml.nodes.join(' and ')} agree on (${formatInt(r.smlChecked)} checked; ${formatInt(sml.validWeighted)} weighted valid MNs)`}
        {r.rejectedTime > 0 && `, ${r.rejectedTime} dropped for a time Core would reject`}
        {r.otherSignal > 0 && `, ${r.otherSignal} votes on other signals skipped`}. Superseded votes are counted once, latest wins.
        {r.keysFrom === 'sml' && r.internalCollateral < r.verified && ` Which collateral belongs to which masternode is as the bridge reports it for ${formatInt(r.verified - r.internalCollateral)} votes (ProRegTx check not done yet).`}
        {run.listMatches === false && ' The masternode list served for this height is not the one the bridge built its tally from; a mismatch may come from that.'}
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
  );
}

/** The recounts, what they concluded about each published tally, and what they could not check. */
function VotesResult({ done, fixtures }: { done: VotesDone; fixtures: boolean }) {
  const vv = voteVerdict(done.runs);
  const style = VERDICT_STYLE[vv.level];
  // The run that decided the headline: the one holding the matching tally, else the first.
  const lead =
    done.runs.find((run) => run.result.targets.some((t) => t === vv.matched)) ??
    done.runs.find((run) => run.result.targets.some((t) => !t.matches && t.asOfHeight === run.votesAsOf)) ??
    done.runs[0]!;
  return (
    <div className="votes-result" data-votes={vv.level}>
      <p className={`verdict ${style.className}`}>
        <ProvGlyph kind={style.glyph} />
        {verdictText(vv.level, lead.result.verified, lead.result.total, vv.matched?.name, done.origin, fixtures, lead.result.smlUnconfirmed)}
      </p>
      {done.runs.map((run, i) => (
        <RunResult key={i} run={run} bridge={done.bridge} sml={done.sml} />
      ))}
    </div>
  );
}

export function VerificationPanel({
  proposal,
  collateral,
  targets,
  onVotes,
}: {
  proposal: Proposal;
  collateral: CollateralCheck;
  /** Published tallies to compare the recount with. */
  targets: VoteTarget[];
  onVotes(r: VotesDone | null): void;
}) {
  const { source, mode } = useApp();
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
        network: source.coreNetwork,
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
              Downloads every signed vote from {bridge.kind === 'fixture' ? 'the fixture bridge' : bridge.name}, checks each signature against the masternode voting key, recounts the weighted tally and compares it with the Platform tally document. The vote set is requested at the block that tally is as of, so the two are comparable exactly.
            </p>
            <div className="verify-actions">
              <button type="button" className="btn btn-primary" onClick={verifyVotes} disabled={votes.running}>
                {votes.running ? 'Verifying…' : votes.result ? 'Verify again' : 'Verify votes'}
              </button>
              {mode === 'live' && (
                <label className="check">
                  <input type="checkbox" checked={sml} onChange={(e) => setSml(e.target.checked)} /> Confirm voting keys with the DAPI masternode list that at least two of three nodes agree on (about 1.4 MB each; needed for a verified result)
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
        {votes.result && <VotesResult done={votes.result} fixtures={mode === 'fixtures'} />}
      </div>
    </section>
  );
}
