// "How do we know?": every check behind a proposal's trust badge, each with its plain result and, one click further, the per-step
// detail (basis, trust root, timings); "Check the votes yourself" (the recount tables, voteSetHash, Dash Core commands); the
// proposal's raw data and hashes; and what no check here can detect. Everything runs automatically (ui/trust/useProposalTrust.ts).
import { parseProposalData } from '@govhub/verify';
import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../app/context.tsx';
import type { Cycle, Proposal, Sourced } from '../../data/types.ts';
import { formatDash, formatDateTime, formatInt, formatRelative, shortHash } from '../../lib/format.ts';
import { CHECK_LABEL, LEVEL_LABEL, VERIFIED_LINE, type CheckId, type Component, type ComponentState } from '../../verify/aggregate.ts';
import { isLowerBound, type ChainReport } from '../../verify/chain.ts';
import { checkContent, verdictFailure, type CollateralVerdict, type StepBasis, type StepStatus } from '../../verify/collateral.ts';
import { budgetFact } from '../../verify/facts.ts';
import type { RankingDone, VotesDone } from '../../verify/protocol.ts';
import { comparable, PLATFORM_TARGET, voteVerdict, type VoteLevel } from '../../verify/verdict.ts';
import type { VoteRun } from '../../verify/votes.ts';
import { Drawer } from '../Drawer.tsx';
import type { ChainCheck, CollateralCheck } from '../hooks.ts';
import { ProvGlyph } from '../Provenance.tsx';
import { CopyButton } from '../vote/common.tsx';
import { ShieldIcon } from './TrustBadge.tsx';
import type { ProposalTrust } from './useProposalTrust.ts';

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

type Glyph = 'verified' | 'mismatch' | 'reported' | 'fixture';

/**
 * A step that passed because a node said so is drawn as "reported", not "verified"; one that failed on a node's word (an unreachable
 * network, bytes that do not hash to the txid) as "reported" too, not as a mismatch of the proposal. Demo data is never "verified".
 */
function stepGlyph(s: Row, demo: boolean): Glyph {
  switch (s.status) {
    case 'ok':
      if (s.basis === 'reported') return 'reported';
      return demo ? 'fixture' : 'verified';
    case 'fail':
      return s.basis === 'reported' ? 'reported' : 'mismatch';
    case 'warn':
      return 'reported';
    case 'skip':
      return 'fixture';
  }
}

function Steps({ steps, demo }: { steps: Row[]; demo: boolean }) {
  const more = steps.filter((s) => s.more);
  return (
    <>
      <ol className="steps">
        {steps.map((s) => {
          const glyph = stepGlyph(s, demo);
          return (
          <li key={s.id} className={`step step-${s.status}`} data-step={s.id} data-status={s.status} data-basis={s.basis ?? (glyph === 'verified' ? 'verified' : 'reported')}>
            <ProvGlyph kind={glyph} />
            <span className="step-label">{s.label}</span>
            <span className="step-detail">{s.detail}</span>
          </li>
          );
        })}
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

type Anchor = ChainReport['anchor'];

/** What the chain rests on: a quorum proof's ChainLock quorums, or the header checkpoint and proof of work. */
function trustRow(a: Anchor): Row {
  const tr = a.trust;
  if (tr.kind === 'proof-of-work') {
    return {
      id: 'trust', status: 'ok', label: 'Trust root',
      detail: `the pinned header checkpoint at block ${n(tr.checkpoint.height)}, plus proof of work${a.weak ? ' (not secure on this network)' : ''}`,
      more: `no ChainLock proof was used${tr.fallback ? `: ${tr.fallback}` : ''}`,
    };
  }
  const start = tr.from.height === tr.checkpoint.height ? 'from that checkpoint' : `from block ${n(tr.from.height)}, which this browser proved from that checkpoint earlier`;
  return {
    id: 'trust', status: 'ok', label: 'Trust root',
    detail: `the ChainLock quorums of the pinned checkpoint at block ${n(tr.checkpoint.height)}, plus BLS`,
    more: tr.proofBytes === 0
      ? `the ChainLock on block ${n(tr.from.height)}, which this browser proved from that checkpoint earlier with a Dash Core v24 quorum proof (DIP 175); ${tr.newerUnavailable ? `no newer proof could be fetched (${tr.newerUnavailable})` : 'no newer one was available yet'}. No proof of work involved`
      : `a Dash Core v24 quorum proof (DIP 175) from ${tr.source} (untrusted: the proof authenticates itself) ${start}: ${n(tr.links)} ChainLock quorum handoffs, each a BLS signature by a quorum already trusted on the block that mined the next one, ${(tr.proofBytes / 1024).toFixed(1)} KB, verified in WebAssembly by Dash Core's own rules. No proof of work involved`,
  };
}

function chainRow(a: Anchor): Row {
  const hashes = `${n(a.tip - a.lo + 1)} block hashes from ${n(a.lo)}`;
  const fetched = `${n(a.headers.cached)} came from this browser's cache, ${n(a.headers.fetched)} were downloaded (${(a.ms.total! / 1000).toFixed(1)} s)`;
  if (a.trust.kind === 'quorum-proof') {
    return {
      id: 'chain', status: 'ok', label: 'Chain',
      detail: `verified to the ChainLocked block ${n(a.tip)}`,
      more: `${hashes}, each header's X11 hash linked to the next one's up to the proven ChainLocked block (a ChainLock is final, so no proof of work or difficulty check is needed); ${fetched}`,
    };
  }
  return {
    id: 'chain', status: 'ok', label: 'Chain',
    detail: `${a.weak ? 'checked' : 'verified'} from the pinned checkpoint to block ${n(a.tip)}`,
    more: `${hashes}: hash links down to the checkpoint at ${n(a.checkpoint)}, and above it every header's proof of work, difficulty (Dark Gravity Wave) and timestamp checked like Core does; ${fetched}`,
  };
}

/** The chain facts as rows: each says exactly what was proven and what is an estimate. */
function chainRows(r: ChainReport, cycle: Cycle | null, nowS: number): Row[] {
  const a = r.anchor, s = r.schedule, t = r.threshold, budget = budgetFact(r, cycle);
  const selected = `quorum ${shortHash(a.chainLock.quorumHash, 8)} from the proven masternode list${a.chainLock.exact ? ', the quorum Core selects' : " (Core's exact choice could not be reproduced)"}`;
  const rows: Row[] = [
    trustRow(a),
    chainRow(a),
    {
      id: 'chainlock', status: 'ok', label: 'ChainLock',
      detail: a.weak ? `block ${n(a.chainLock.height)} is ChainLocked, on a chain proof of work does not secure here` : `block ${n(a.chainLock.height)} and everything below it are final`,
      more: a.trust.kind === 'quorum-proof'
        ? `BLS signature verified by the quorum proof from the checkpoint; consistent with Core's quorum selection: ${selected}`
        : `BLS signature of ${selected}`,
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
      more: `heights follow from the superblock cycle and maturity window at ${a.weak ? 'checked' : 'verified'} block ${n(s.tip)}; times assume 2.62 minutes per block, as Core's own estimate does`,
    },
    {
      id: 'budget', status: budget.ok === false ? 'warn' : 'ok', label: 'Budget',
      detail: budget.text,
      more: "Core's superblock payments limit at that height: the treasury share of the block subsidy (fixed since V20, cut 1/14 per 210,240 blocks) times the cycle",
    },
  ];
  const p = r.payments;
  // a chain proof of work does not protect (testnet) gives consistent facts, not secure ones
  const weaken = (x: Row, weak: string | null | undefined): Row => (!weak || x.basis === 'reported' ? x : { ...x, basis: 'reported', more: `${x.more ? `${x.more}; ` : ''}not secure: ${weak}` });
  // the payments run anchors on its own: its own chain decides its row too
  const done = (rs: Row[]) => rs.map((x) => weaken(weaken(x, a.weak), x.id === 'payments' ? p?.anchor?.weak : null));
  if (p) {
    const partial = isLowerBound(p);
    rows.push({
      id: 'payments', status: partial ? 'warn' : 'ok', basis: partial || p.othersComplete === false ? 'reported' : 'verified', label: 'Payments made',
      detail: `${n(p.paid.length)}${partial ? ' or more' : ''}${p.paid.length ? ` (superblock${p.paid.length > 1 ? 's' : ''} ${p.paid.map((x) => n(x.height)).join(', ')})` : ''}; ${n(p.remainingEstimate)} more possible (estimate)${p.skipped ? `; ${n(p.skipped)} superblocks of the window not read yet (the next visit continues)` : ''}`,
      more: `${n(p.checked.length)} superblocks in the payment window from the collateral's block to the ${p.anchor?.weak || a.weak ? 'checked' : 'verified'} tip read from their coinbases, each block proven to be the ${p.anchor?.weak || a.weak ? 'checked' : 'verified'} one (read once, then cached in this browser)${p.unread.length ? `; not read: ${p.unread.map((u) => `${n(u.height)} (${u.error})`).join(', ')}` : ''}${p.ambiguous.length ? `; payments another proposal with the same address and amount could account for: ${p.ambiguous.map((x) => n(x.height)).join(', ')}` : ''}${p.othersComplete === false ? '; not every listed proposal could be read to rule out another with the same address and amount' : '; no other proposal listed on Platform pays the same address the same amount in that window'}. "More possible" counts later superblocks whose estimated time falls in the payment window`,
    });
  }
  return done(rows);
}

function ChainBlock({ chain, cycle, nowS, demo }: { chain: ChainCheck; cycle: Cycle | null; nowS: number; demo: boolean }) {
  const { report, progress, error, unavailable } = chain;
  return (
    <div className="verify-block" aria-live="polite" data-testid="chain-check">
      {report ? (
        <>
          <p className={`verdict ${report.anchor.weak ? 'verdict-partial' : 'verdict-ok'}`} data-chain={report.anchor.weak ? 'weak' : 'verified'} data-ms={JSON.stringify(report.anchor.ms)} data-headers={JSON.stringify(report.anchor.headers)}>
            <ProvGlyph kind={report.anchor.weak ? 'reported' : 'verified'} />
            {report.anchor.weak
              ? `Chain checked to block ${n(report.anchor.tip)}, ChainLocked ${formatRelative(report.anchor.chainLock.time, nowS)}, but not secure: ${report.anchor.weak}`
              : `Chain verified to block ${n(report.anchor.tip)}, ChainLocked ${formatRelative(report.anchor.chainLock.time, nowS)}`}
          </p>
          <Steps steps={chainRows(report, cycle, nowS)} demo={demo} />
          {chain.payments.pending && <Pending text={chain.payments.progress || "Reading this proposal's superblock payments"} />}
          {chain.payments.error && <p className="small muted">The proposal's payments couldn't be read: {chain.payments.error}</p>}
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
        <Pending text={progress || 'Verifying the chain'} />
      )}
    </div>
  );
}

const COLLATERAL_STYLE = {
  ok: { className: 'verdict-ok', glyph: 'verified', text: 'Content matches the on-chain collateral' },
  reported: { className: 'verdict-partial', glyph: 'reported', text: "Content matches the collateral transaction, but not every fact about it is proven (see below)" },
  demo: { className: 'verdict-partial', glyph: 'fixture', text: 'Content matches the recorded collateral transaction (demo data, not checked against the chain)' },
  inconclusive: { className: 'verdict-partial', glyph: 'reported', text: "Couldn't fetch the collateral from the network" },
  unconfirmed: { className: 'verdict-partial', glyph: 'reported', text: "Nodes' answers about the collateral couldn't be confirmed" },
  height: { className: 'verdict-fail', glyph: 'mismatch', text: 'The published collateral height contradicts the verified chain' },
  fail: { className: 'verdict-fail', glyph: 'mismatch', text: 'Content does not match the on-chain collateral' },
} as const;

/** The headline follows what the collateral check may claim (its trust component), never `verdict.ok` alone. */
function collateralKind(v: CollateralVerdict, state: ComponentState, demo: boolean): keyof typeof COLLATERAL_STYLE {
  if (v.steps.some((s) => s.id === 'height' && s.status === 'fail' && s.basis === 'verified')) return 'height';
  if (verdictFailure(v)) return 'fail';
  // an inconclusive lookup (DAPI down) or a node whose answer did not check out says nothing about the proposal
  if (v.inconclusive) return 'inconclusive';
  if (!v.ok) return 'unconfirmed';
  if (demo) return 'demo';
  return state.status === 'proven' ? 'ok' : 'reported';
}

function CollateralBlock({ check, state, demo }: { check: CollateralCheck; state: ComponentState; demo: boolean }) {
  const { verdict, progress, error } = check;
  const kind = verdict && collateralKind(verdict, state, demo);
  return (
    <div className="verify-block" data-testid="collateral-check">
      {kind ? (
        <p className={`verdict ${COLLATERAL_STYLE[kind].className}`} data-verdict={kind}>
          <ProvGlyph kind={COLLATERAL_STYLE[kind].glyph} />
          {COLLATERAL_STYLE[kind].text}
        </p>
      ) : error ? (
        <p className="verdict verdict-partial" data-verdict="error">
          <ProvGlyph kind="reported" /> Collateral check could not run: {error}
        </p>
      ) : (
        <Pending text={progress || 'Checking the collateral'} />
      )}
      {verdict && <Steps steps={verdict.steps} demo={demo} />}
      {verdict?.anchorError && <p className="small muted">The chain could not be anchored: {verdict.anchorError}</p>}
    </div>
  );
}

/** A check that has not answered yet. */
function Pending({ text }: { text: string }) {
  return (
    <p className="verdict verdict-pending" aria-busy="true">
      <span className="spinner" aria-hidden="true" /> {text}…
    </p>
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
      return `Not compared: the votes the bridge served are for another block than the published tallies (${sigs}), so this recount neither confirms nor contradicts them. Re-check later`;
    case 'mismatch':
      return `Tally mismatch: the recount from ${formatInt(verified)} valid votes differs from a tally at the same height`;
    case 'no-tally':
      return `${sigs}; there is no published tally to compare with`;
  }
}

/** One recount: what it read, what it dropped, and the field-by-field comparison with the tallies of its height. */
function RunResult({ run, bridge, sml, proven, demo }: { run: VoteRun; bridge: string; sml: VotesDone['sml']; proven: boolean; demo: boolean }) {
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
                  // a matching field is "verified" only for the tally the vote check proved; elsewhere it is a match on someone's word
                  const match: Glyph = demo ? 'fixture' : proven && t.name === PLATFORM_TARGET && r.keysFrom === 'sml' ? 'verified' : 'reported';
                  return (
                    <td key={t.name} className={`r${tc.ok ? '' : ' bad'}`}>
                      {typeof tc.expected === 'number' ? formatInt(tc.expected) : shortHash(tc.expected || '(none)', 6)} <ProvGlyph kind={tc.ok ? match : 'mismatch'} />
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
function VotesResult({ done, fixtures, proven }: { done: VotesDone; fixtures: boolean; proven: boolean }) {
  const found = voteVerdict(done.runs);
  // The headline never says "verified" where the badge's vote check does not (another tally than the shown one, a weak list, a stale tally).
  const downgraded = found.level === 'verified' && !proven;
  const vv = downgraded ? { ...found, level: 'keys-reported' as const } : found;
  const style = VERDICT_STYLE[vv.level];
  // The run that decided the headline: the one holding the matching tally, else the first.
  const lead =
    done.runs.find((run) => run.result.targets.some((t) => t === vv.matched)) ??
    done.runs.find((run) => run.result.targets.some((t) => !t.matches && comparable(run, t))) ??
    done.runs[0]!;
  return (
    <div className="votes-result" data-votes={vv.level}>
      <p className={`verdict ${style.className}`}>
        <ProvGlyph kind={style.glyph} />
        {downgraded
          ? `Recount matches the ${vv.matched?.name}: ${formatInt(lead.result.verified)} of ${formatInt(lead.result.total)} signatures check out, keys proven; the vote check above says why that doesn't make the shown tally verified`
          : verdictText(vv.level, lead.result.verified, lead.result.total, vv.matched?.name, done.origin, fixtures, lead.result.smlUnconfirmed, done.sml?.weak ?? null)}
      </p>
      {done.runs.map((run, i) => (
        <RunResult key={i} run={run} bridge={done.bridge} sml={done.sml} proven={proven} demo={fixtures} />
      ))}
    </div>
  );
}

/** Sources that contradict each other show as a mismatch; demo data never shows as proven. */
function stateGlyph(s: ComponentState, demo: boolean): Glyph {
  switch (s.status) {
    case 'proven':
      return demo ? 'fixture' : 'verified';
    case 'error':
      return s.mismatch ? 'mismatch' : 'reported';
    case 'reported':
      return 'reported';
    case 'failed':
      return 'mismatch';
    case 'pending':
      return 'fixture';
  }
}

function checkLine(s: Component['state']): string {
  switch (s.status) {
    case 'proven':
      return s.summary;
    case 'pending':
      return `${s.note ?? 'Checking'}…`;
    default:
      return s.reason;
  }
}

function CheckRow({ c, demo, children }: { c: Component; demo: boolean; children?: ReactNode }) {
  const s = c.state;
  const line = checkLine(s);
  return (
    <li className={`check-row check-${s.status}`} data-check={c.id} data-state={s.status} data-mismatch={s.status === 'error' && s.mismatch ? '' : undefined}>
      <div className="check-line">
        {s.status === 'pending' ? <span className="spinner" aria-hidden="true" /> : <ProvGlyph kind={stateGlyph(s, demo)} />}
        <div>
          <p className="check-label">{CHECK_LABEL[c.id]}</p>
          <p className="check-text">{line}</p>
        </div>
      </div>
      {children && (
        <details className="check-more">
          <summary>Details</summary>
          {children}
        </details>
      )}
    </li>
  );
}

/** Copyable commands and links for checking the tally without this page. */
function YourselfCommands({ govHash, bridgeBase }: { govHash: string; bridgeBase: string | null }) {
  const cmds: Array<[string, string]> = [
    ['Every current vote, with signatures', `dash-cli gobject getcurrentvotes ${govHash}`],
    ['The tally Core computes (FundingResult)', `dash-cli gobject get ${govHash}`],
  ];
  return (
    <div className="yourself">
      <p className="small muted">With your own Dash Core node:</p>
      <ul className="cmds">
        {cmds.map(([what, cmd]) => (
          <li key={cmd}>
            <span className="small">{what}</span>
            <span className="cmd">
              <code className="break">{cmd}</code>
              <CopyButton text={cmd} label={`Copy: ${what}`} />
            </span>
          </li>
        ))}
      </ul>
      {bridgeBase && (
        <p className="small">
          The signed votes this recount used, as JSON:{' '}
          <a href={`${bridgeBase}/v1/proposals/${govHash}/votes`} target="_blank" rel="noopener noreferrer">
            {bridgeBase.replace(/^https?:\/\//, '')}/v1/proposals/…/votes
          </a>
        </p>
      )}
    </div>
  );
}

function RawData({ p, sp }: { p: Proposal; sp: Sourced<Proposal> }) {
  const parsed = useMemo(() => parseProposalData(p.dataHex), [p.dataHex]);
  const json = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(parsed.text), null, 2);
    } catch {
      return parsed.text; // Core's parser is more lenient than JSON.parse; show the bytes as they are
    }
  }, [parsed.text]);
  const rows: Array<[string, string]> = [
    ['Governance hash', p.govHash],
    ['Collateral', `${p.collateralTxid} at block ${formatInt(p.collateralHeight)}`],
    ['Submitted', formatDateTime(p.time)],
    ['Payment address', p.paymentAddress],
    ...(p.docId ? [['Platform document', `${p.docId} (${sp.prov.source})`] as [string, string]] : []),
  ];
  return (
    <div data-testid="raw-data">
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="mono-ish break">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="small muted">Exactly what the governance hash commits to ({formatInt(parsed.dataBytes)} bytes). The URL is the owner's own page; govhub doesn't host or check its content.</p>
      <pre className="code">{json}</pre>
      <details>
        <summary>dataHex</summary>
        <pre className="code break">{p.dataHex}</pre>
      </details>
    </div>
  );
}

/** What the funding row says while there is no ranking to show: its progress, why it failed, or why it may not run at all. */
function rankingNote(ranking: ProposalTrust['ranking']): string {
  if (ranking?.running) return `${ranking.progress || 'Ranking every active proposal'}…`;
  if (ranking?.error) return `The funding order couldn't be recounted: ${ranking.error}`;
  return "A proposal that is not passing on the recounted votes and the proven threshold is not funded; one that is passing is ranked against every active proposal, by Core's rules. The ranking leaves out proposals that failed verification, as Core does, and can't include a proposal the bridge never published.";
}

const byId = (cs: readonly Component[], id: CheckId) => cs.find((c) => c.id === id)!;

export function VerificationDrawer({ sp, trust, cycle, open, onClose }: { sp: Sourced<Proposal>; trust: ProposalTrust; cycle: Cycle | null; open: boolean; onClose(): void }) {
  const { source, mode } = useApp();
  const p = sp.value;
  const a = trust.aggregate;
  const bridge = source.bridgeDescriptor();
  const bridgeBase = bridge?.kind === 'http' ? bridge.base : null;
  const contentSteps = useMemo(() => checkContent(p).steps, [p]);
  const demo = mode === 'fixtures';
  return (
    <Drawer open={open} onClose={onClose} title="How do we know?" testId="verify-drawer">
      <section className={`drawer-verdict trust-${a.level}`} aria-live="polite" data-testid="drawer-verdict" data-trust={a.level}>
        <ShieldIcon level={a.level} size={32} />
        <div>
          <p className="drawer-verdict-title">{LEVEL_LABEL[a.level]}</p>
          <p className="drawer-verdict-line">{a.level === 'verified' ? VERIFIED_LINE : a.reason}</p>
        </div>
        <button type="button" className="btn btn-s" onClick={trust.recheck} data-testid="recheck">
          Re-check
        </button>
      </section>
      <p className="small muted">
        Your browser ran these checks itself, against the Dash chain. A tick means nothing rests on a server's word.
      </p>

      <ol className="checks" data-testid="checks">
        <CheckRow c={byId(a.components, 'content')} demo={demo}>
          <Steps steps={contentSteps} demo={demo} />
        </CheckRow>
        <CheckRow c={byId(a.components, 'collateral')} demo={demo}>
          <CollateralBlock check={trust.collateral} state={byId(a.components, 'collateral').state} demo={demo} />
        </CheckRow>
        <CheckRow c={byId(a.components, 'chain')} demo={demo}>
          <ChainBlock chain={trust.chain} cycle={cycle} nowS={source.now()} demo={demo} />
        </CheckRow>
        <CheckRow c={byId(a.components, 'votes')} demo={demo} />
        <CheckRow c={byId(a.components, 'funding')} demo={demo}>
          {trust.ranking?.result ? (
            <div data-testid="ranking-check">
              <RankingBlock done={trust.ranking.result} govHash={p.govHash} />
            </div>
          ) : (
            <>
              <p className="small muted">{rankingNote(trust.ranking)}</p>
              {trust.rankNow && (
                <button type="button" className="btn btn-s" onClick={trust.rankNow} data-testid="rank-now">
                  Rank every active proposal
                </button>
              )}
            </>
          )}
        </CheckRow>
      </ol>

      <details className="drawer-section" data-testid="votes-check" open={a.level === 'failed' && byId(a.components, 'votes').state.status === 'failed'}>
        <summary>Check the votes yourself</summary>
        {!bridge ? (
          <p className="muted small">
            Signed votes come from a bridge, because DAPI has no governance calls. <Link to="/settings">Add a bridge in Settings</Link> to recount them.
          </p>
        ) : trust.votes.result ? (
          <VotesResult done={trust.votes.result} fixtures={demo} proven={!demo && byId(a.components, 'votes').state.status === 'proven'} />
        ) : trust.votes.error ? (
          <p className="error small">The votes couldn't be recounted: {trust.votes.error}</p>
        ) : (
          <Pending text={trust.votes.progress || 'Waiting for the collateral check'} />
        )}
        <YourselfCommands govHash={p.govHash} bridgeBase={bridgeBase} />
      </details>

      <details className="drawer-section">
        <summary>Proposal data and hashes</summary>
        <RawData p={p} sp={sp} />
      </details>

      <section className="drawer-note" aria-labelledby="cant-title">
        <h3 id="cant-title">What this can't detect</h3>
        <p className="small">
          A bridge can withhold. The recount proves the votes it was given, so votes the bridge didn't serve can't be detected, and neither can a proposal it never
          published. Switch to another bridge in Settings, or compare with your own Dash Core node using the commands above.
        </p>
      </section>
      <p className="small">
        <Link to="/about/verification" onClick={onClose}>
          About verification: what each state means
        </Link>
        {' · '}
        <Link to="/about/trust" onClick={onClose} data-testid="trust-page-link">
          What we can and can't lie about
        </Link>
      </p>
    </Drawer>
  );
}
