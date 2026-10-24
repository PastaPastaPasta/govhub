// The "can't lie" panel: the collateral check and the chain facts run automatically in the worker; vote verification and the
// funding order run on demand (they download every signed vote and the MN list from a bridge).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import type { Cycle, Proposal } from '../data/types.ts';
import { formatDash, formatInt, formatRelative, shortHash } from '../lib/format.ts';
import type { ChainReport } from '../verify/chain.ts';
import { runVerification } from '../verify/client.ts';
import type { StepBasis, StepStatus } from '../verify/collateral.ts';
import { budgetFact } from '../verify/facts.ts';
import type { RankingDone, VotesDone } from '../verify/protocol.ts';
import { voteVerdict, type VoteLevel } from '../verify/verdict.ts';
import type { VoteRun, VoteTarget } from '../verify/votes.ts';
import type { ChainCheck, CollateralCheck } from './hooks.ts';
import { ProvGlyph } from './Provenance.tsx';

/** One checked fact: the collateral steps and the chain facts share this shape. */
interface Row {
  id: string;
  status: StepStatus;
  label: string;
  detail: string;
  basis?: StepBasis;
  /** Technical detail, shown under "How this was checked". */
  more?: string;
}

/** A step that passed because a node said so is drawn as "reported", not "verified". */
function stepGlyph(s: Row): 'verified' | 'mismatch' | 'reported' | 'fixture' {
  if (s.status === 'ok') return s.basis === 'reported' ? 'reported' : 'verified';
  return { fail: 'mismatch', warn: 'reported', skip: 'fixture' }[s.status] as 'mismatch' | 'reported' | 'fixture';
}

function Steps({ steps }: { steps: Row[] }) {
  const more = steps.filter((s) => s.more);
  return (
    <>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.id} className={`step step-${s.status}`} data-step={s.id} data-status={s.status} data-basis={s.basis ?? (s.status === 'ok' ? 'verified' : 'reported')}>
            <ProvGlyph kind={stepGlyph(s)} />
            <span className="step-label">{s.label}</span>
            <span className="step-detail">{s.detail}</span>
          </li>
        ))}
      </ol>
      {more.length > 0 && <How rows={more.map((s) => [s.label, s.more!])} />}
    </>
  );
}

function How({ rows }: { rows: Array<[string, string]> }) {
  return (
    <details className="how">
      <summary>How this was checked</summary>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

const n = formatInt;

/** The chain facts as rows: each says exactly what was proven and what is an estimate. */
function chainRows(r: ChainReport, cycle: Cycle | null, nowS: number): Row[] {
  const a = r.anchor, s = r.schedule, t = r.threshold, budget = budgetFact(r, cycle);
  const rows: Row[] = [
    {
      id: 'chain', status: 'ok', label: 'Chain',
      detail: `${a.weak ? 'checked' : 'verified'} from the pinned checkpoint to block ${n(a.tip)}`,
      more: `${n(a.tip - a.lo + 1)} block hashes from ${n(a.lo)}: hash links down to the checkpoint at ${n(a.checkpoint)}, and above it every header's proof of work, difficulty (Dark Gravity Wave) and timestamp checked like Core does; ${n(a.headers.cached)} came from this browser's cache, ${n(a.headers.fetched)} were downloaded (${(a.ms.total! / 1000).toFixed(1)} s)`,
    },
    {
      id: 'chainlock', status: 'ok', label: 'ChainLock',
      detail: `block ${n(a.chainLock.height)} and everything below it are final`,
      more: `BLS signature of quorum ${shortHash(a.chainLock.quorumHash, 8)} from the proven masternode list${a.chainLock.exact ? ', the quorum Core selects' : " (Core's exact choice could not be reproduced)"}`,
    },
    {
      id: 'mnlist', status: 'ok', label: 'Masternode list',
      detail: `${n(a.sml.entries)} masternodes and ${n(a.sml.quorums)} quorums ${a.weak ? 'match' : 'proven by'} block ${n(a.sml.height)}`,
      more: `every entry and quorum commitment re-serialized and hashed; both merkle roots equal the ones in block ${n(a.sml.height)}'s coinbase, which the block's merkle root covers`,
    },
    {
      id: 'threshold', status: 'ok', basis: t.status === 'verified' ? 'verified' : 'reported', label: 'Funding threshold',
      detail: `${n(t.value)} net yes votes (${n(t.validWeighted)} weighted valid masternodes / 10)${t.status === 'verified' ? '' : `; ${t.reason}`}`,
      more: `${t.legacy.valid ? `${n(t.legacy.valid)} older (version 1) entries do not commit their type in the list's hash; ${n(t.legacy.proven)} were proven regular or evonode by their registration transactions (cached in this browser). ` : ''}Core: max(nGovernanceMinQuorum, valid weighted count / 10)`,
    },
    {
      id: 'schedule', status: 'ok', label: 'Next superblock',
      detail: `block ${n(s.next)}, ${formatRelative(s.nextEstTime, nowS)} (estimate); voting deadline block ${n(s.votingDeadline)}${s.inMaturityWindow ? ' (passed)' : ''}`,
      more: `heights follow from the superblock cycle and maturity window at verified block ${n(s.tip)}; times assume 2.62 minutes per block, as Core's own estimate does`,
    },
    {
      id: 'budget', status: budget.ok === false ? 'warn' : 'ok', label: 'Budget',
      detail: budget.text,
      more: "Core's superblock payments limit at that height: the treasury share of the block subsidy (fixed since V20, cut 1/14 per 210,240 blocks) times the cycle",
    },
  ];
  const p = r.payments;
  // a chain proof of work does not protect (testnet) gives consistent facts, not secure ones
  const done = (rs: Row[]) =>
    a.weak ? rs.map((x) => (x.basis === 'reported' ? x : { ...x, basis: 'reported' as const, more: `${x.more ? `${x.more}; ` : ''}not secure: ${a.weak}` })) : rs;
  if (p) {
    rows.push({
      id: 'payments', status: p.unread.length || p.ambiguous.length ? 'warn' : 'ok', basis: p.unread.length || p.ambiguous.length || p.othersComplete === false ? 'reported' : 'verified', label: 'Payments made',
      detail: `${n(p.paid.length)}${p.unread.length || p.ambiguous.length ? ' or more' : ''}${p.paid.length ? ` (superblock${p.paid.length > 1 ? 's' : ''} ${p.paid.map((x) => n(x.height)).join(', ')})` : ''}; ${n(p.remainingEstimate)} more possible (estimate)`,
      more: `${n(p.checked.length)} superblocks in the payment window from the collateral's block to the verified tip read from their coinbases, each block proven to be the verified one${p.unread.length ? `; not read: ${p.unread.map((u) => `${n(u.height)} (${u.error})`).join(', ')}` : ''}${p.ambiguous.length ? `; payments another proposal with the same address and amount could account for: ${p.ambiguous.map((x) => n(x.height)).join(', ')}` : ''}${p.othersComplete === false ? '; not every listed proposal could be read to rule out another with the same address and amount' : '; no other proposal listed on Platform pays the same address the same amount in that window'}. "More possible" counts later superblocks whose estimated time falls in the payment window`,
    });
  }
  return done(rows);
}

function ChainBlock({ chain, cycle, nowS }: { chain: ChainCheck; cycle: Cycle | null; nowS: number }) {
  const { report, progress, error, unavailable } = chain;
  return (
    <div className="verify-block" aria-live="polite" data-testid="chain-check">
      <h3>Chain facts</h3>
      {report ? (
        <>
          <p className={`verdict ${report.anchor.weak ? 'verdict-partial' : 'verdict-ok'}`} data-chain={report.anchor.weak ? 'weak' : 'verified'} data-ms={JSON.stringify(report.anchor.ms)} data-headers={JSON.stringify(report.anchor.headers)}>
            <ProvGlyph kind={report.anchor.weak ? 'reported' : 'verified'} />
            {report.anchor.weak
              ? `Chain checked to block ${n(report.anchor.tip)}, ChainLocked ${formatRelative(report.anchor.chainLock.time, nowS)}, but not secure: ${report.anchor.weak}`
              : `Chain verified to block ${n(report.anchor.tip)}, ChainLocked ${formatRelative(report.anchor.chainLock.time, nowS)}`}
          </p>
          <Steps steps={chainRows(report, cycle, nowS)} />
        </>
      ) : error ? (
        <p className="verdict verdict-partial" data-chain="error">
          <ProvGlyph kind="reported" /> Chain facts could not be verified: {error}. Threshold, schedule and payments are as the bridge reports them.
        </p>
      ) : unavailable ? (
        <p className="muted small" data-chain="unavailable">
          Chain facts are not verified here: {unavailable}. Threshold, schedule and payments are as the bridge reports them.
        </p>
      ) : (
        <p className="verdict verdict-pending" aria-busy="true">
          <span className="spinner" aria-hidden="true" /> {progress || 'Verifying the chain'}…
        </p>
      )}
    </div>
  );
}

function RankingBlock({ done, govHash }: { done: RankingDone; govHash: string }) {
  const r = done.result;
  return (
    <div data-ranking={r.verified ? 'verified' : 'reported'}>
      <p className={`verdict ${r.verified ? 'verdict-ok' : 'verdict-partial'}`}>
        <ProvGlyph kind={r.verified ? 'verified' : 'reported'} />
        {r.verified ? `Funding order verified for the ${r.entries.length} listed proposals` : `Funding order computed from ${r.entries.length} recounts, not verified`}
      </p>
      {!r.verified && (
        <ul className="problems">
          {r.reasons.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      <table className="compare">
        <thead>
          <tr>
            <th scope="col">Rank</th>
            <th scope="col">Proposal</th>
            <th scope="col" className="r">
              Net yes
            </th>
            <th scope="col" className="r">
              Amount
            </th>
            <th scope="col">Next superblock</th>
          </tr>
        </thead>
        <tbody>
          {r.entries.map((e) => (
            <tr key={e.govHash} className={e.govHash === govHash ? 'this' : undefined}>
              <td>{e.rank ?? '–'}</td>
              <th scope="row">{e.name}</th>
              <td className="r">
                {n(e.absYes)} <ProvGlyph kind={e.proven ? 'verified' : 'reported'} />
              </td>
              <td className="r">{formatDash(e.amount)}</td>
              <td>{e.funded ? (e.timeSensitive ? 'in it (depends on timing)' : 'in it') : e.rank ? 'not in it' : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Threshold {n(r.threshold.value)}, budget {formatDash(Number(r.budget.limit))} for superblock {n(r.budget.height)}, {formatDash(r.allocated)} allocated. Ranked by net yes votes, then hash, filled greedily within the budget and each proposal's payment window, as Core builds the superblock. Each recount uses the votes the bridge served and must reproduce its published tally; a vote or proposal the bridge withholds would not show.
      </p>
    </div>
  );
}

const VERDICT_STYLE: Record<VoteLevel, { className: string; glyph: 'verified' | 'mismatch' | 'reported' }> = {
  verified: { className: 'verdict-ok', glyph: 'verified' },
  'keys-reported': { className: 'verdict-partial', glyph: 'reported' },
  'different-height': { className: 'verdict-partial', glyph: 'reported' },
  mismatch: { className: 'verdict-fail', glyph: 'mismatch' },
  'no-tally': { className: 'verdict-pending', glyph: 'reported' },
};

function verdictText(level: VoteLevel, verified: number, total: number, matched: string | undefined, origin: VotesDone['origin'], fixtures: boolean, smlUnconfirmed: number, weak: string | null): string {
  const sigs = `${formatInt(verified)} of ${formatInt(total)} signatures check out`;
  switch (level) {
    case 'verified':
      return `Tally verified: ${sigs} and the recount matches the ${matched}`;
    case 'keys-reported':
      if (fixtures) return `Recount matches the ${matched}: ${sigs}. Voting keys come from the fixture bridge (${origin === 'recorded' ? 'recorded mainnet votes and masternodes' : 'synthetic voters'})`;
      if (weak && smlUnconfirmed === 0) return `Recount matches the ${matched}: ${sigs}, keys checked against the masternode list, but not secure: ${weak}`;
      if (smlUnconfirmed > 0) return `Recount matches the ${matched}: ${sigs}, but ${formatInt(smlUnconfirmed)} voters are not confirmed by the proven masternode list and their registrations (a masternode may have left or changed its key since the tally, or the bridge reports it wrongly)`;
      return `Recount matches the ${matched}: ${sigs}, but the voting keys are only as the bridge reports them. Check them against the proven masternode list for a verified result`;
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
        {sml && `, voting keys checked against the masternode list ${sml.weak ? 'checked (not secure on this network)' : 'proven'} by block ${formatInt(sml.height)} (${formatInt(r.smlChecked)} checked), collateral and type of ${formatInt(r.collateralProven)} voters proven by their registration transactions`}
        {r.rejectedTime > 0 && `, ${r.rejectedTime} dropped for a time Core would reject`}
        {r.otherSignal > 0 && `, ${r.otherSignal} votes on other signals skipped`}. Superseded votes are counted once, latest wins.
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
        {verdictText(vv.level, lead.result.verified, lead.result.total, vv.matched?.name, done.origin, fixtures, lead.result.smlUnconfirmed, done.sml?.weak ?? null)}
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
  chain,
  cycle,
  targets,
  onVotes,
  onRanking,
}: {
  proposal: Proposal;
  collateral: CollateralCheck;
  chain: ChainCheck;
  cycle: Cycle | null;
  /** Published tallies to compare the recount with. */
  targets: VoteTarget[];
  onVotes(r: VotesDone | null): void;
  onRanking(r: RankingDone | null): void;
}) {
  const { source, mode, gov, checks } = useApp();
  const bridge = source.bridgeDescriptor();
  const [sml, setSml] = useState(true);
  const [votes, setVotes] = useState<{ running: boolean; progress?: string; result?: VotesDone; error?: string }>({ running: false });
  const [ranking, setRanking] = useState<{ running: boolean; progress?: string; result?: RankingDone; error?: string }>({ running: false });
  const { verdict, progress, error } = collateral;
  // Proposals that failed verification (hash or collateral) are not governance objects Core holds: they cannot be ranked.
  const active = (gov.active.data ?? []).map((x) => x.value).filter((p) => checks.state(p).status !== 'failed');

  const verifyRanking = () => {
    if (!bridge) return;
    setRanking({ running: true, progress: 'Starting' });
    onRanking(null);
    runVerification({ kind: 'ranking', proposals: active, bridge, dapi: source.dapiDescriptor(), network: source.coreNetwork, now: source.now() }, (m) => setRanking((v) => ({ ...v, progress: m }))).then(
      (result) => {
        setRanking({ running: false, result });
        onRanking(result);
      },
      (e: Error) => setRanking({ running: false, error: e.message }),
    );
  };

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

      <ChainBlock chain={chain} cycle={cycle} nowS={source.now()} />

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
                  <input type="checkbox" checked={sml} onChange={(e) => setSml(e.target.checked)} /> Check voting keys against the proven masternode list and each voter's registration (needed for a verified result)
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

      {bridge && mode === 'live' && (
        <div className="verify-block" aria-live="polite" data-testid="ranking-check">
          <h3>Funding order</h3>
          <p className="muted small">Recounts the live votes of every active proposal ({active.length}) and ranks them the way Core builds the next superblock, against the proven threshold and budget.</p>
          <div className="verify-actions">
            <button type="button" className="btn" onClick={verifyRanking} disabled={ranking.running || active.length === 0}>
              {ranking.running ? 'Recounting…' : ranking.result ? 'Recount again' : 'Verify funding order'}
            </button>
          </div>
          {ranking.running && (
            <p className="verdict verdict-pending" aria-busy="true">
              <span className="spinner" aria-hidden="true" /> {ranking.progress}…
            </p>
          )}
          {ranking.error && <p className="error">Funding order failed: {ranking.error}</p>}
          {ranking.result && <RankingBlock done={ranking.result} govHash={proposal.govHash} />}
        </div>
      )}
    </section>
  );
}
