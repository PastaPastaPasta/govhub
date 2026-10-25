// One trust signal per proposal (DESIGN.md §2). Pure: every check's raw result is mapped to a component state, and the components
// to one level. "verified" is the last resort, reached only when every REQUIRED check is present exactly once and proven. Each
// mapping reads the per-step basis, never `verdict.ok` or a provenance kind alone: a node's word, the per-transaction ChainLock
// fallback, a height mismatch, testnet proof of work and fixture data can each only lower the level.
import type { Proposal, Tally } from '../data/types.ts';
import type { ChainReport } from './chain.ts';
import { verdictFailure, type CollateralVerdict, type Step } from './collateral.ts';
import type { RankingDone, VotesDone } from './protocol.ts';
import { comparable, PLATFORM_TARGET } from './verdict.ts';

export type CheckId = 'content' | 'collateral' | 'chain' | 'votes' | 'funding';
export const REQUIRED: readonly CheckId[] = ['content', 'collateral', 'chain', 'votes', 'funding'];

export const CHECK_LABEL: Record<CheckId, string> = {
  content: 'Proposal text',
  collateral: 'Submission fee',
  chain: 'Chain and masternode list',
  votes: 'Vote count',
  funding: 'Funding',
};

export type ComponentState =
  /** Still running (`note`: what it is doing). */
  | { status: 'pending'; note?: string }
  /** Proven in this browser. */
  | { status: 'proven'; summary: string }
  /** Completed, but some of it rests on someone's word (a node, the bridge, weak proof of work). */
  | { status: 'reported'; reason: string }
  /**
   * Could not complete (network, timeouts), or sources contradict each other (`mismatch`: e.g. the signed votes a bridge served and a
   * tally published for the same block). Says nothing about the proposal itself, so it is never "failed"; never "verified" either.
   */
  | { status: 'error'; reason: string; mismatch?: true }
  /** A check ran and contradicted the data. */
  | { status: 'failed'; reason: string };

export interface Component {
  id: CheckId;
  state: ComponentState;
}

export type TrustLevel = 'demo' | 'checking' | 'verified' | 'partial' | 'error' | 'failed';

export interface Aggregate {
  level: TrustLevel;
  /** One plain line: why it is not verified, or what is running. Null when verified. */
  reason: string | null;
  components: Component[];
}

export const LEVEL_LABEL: Record<TrustLevel, string> = {
  verified: 'Verified',
  checking: 'Checking…',
  partial: 'Partly verified',
  error: "Couldn't verify",
  failed: 'Failed verification',
  demo: 'Demo data',
};

export const VERIFIED_LINE = 'Content, collateral, votes and funding checked in your browser';
export const DEMO_LINE = 'Sample data recorded from mainnet. Nothing here is live';

const reasonOf = (s: ComponentState): string | null => ('reason' in s ? s.reason : null);
const first = (cs: readonly Component[], status: ComponentState['status']) => cs.find((c) => c.state.status === status);

/** Precedence: demo, failed, checking, couldn't verify, partly verified, verified. */
export function aggregate(components: readonly Component[], o: { demo?: boolean } = {}): Aggregate {
  const cs = [...components];
  if (o.demo) return { level: 'demo', reason: DEMO_LINE, components: cs };
  const failed = first(cs, 'failed');
  if (failed) return { level: 'failed', reason: reasonOf(failed.state), components: cs };
  // A missing or duplicated required check is "still to come", never a pass.
  const complete = REQUIRED.every((id) => cs.filter((c) => c.id === id).length === 1);
  const pending = first(cs, 'pending');
  if (pending || !complete) {
    const note = pending?.state.status === 'pending' ? pending.state.note : undefined;
    return { level: 'checking', reason: note ?? 'Checking in your browser', components: cs };
  }
  const error = first(cs, 'error');
  if (error) return { level: 'error', reason: reasonOf(error.state), components: cs };
  const reported = first(cs, 'reported');
  if (reported) return { level: 'partial', reason: reasonOf(reported.state), components: cs };
  // Belt and braces: only proven states get here, but say so explicitly.
  if (!cs.every((c) => c.state.status === 'proven')) return { level: 'partial', reason: 'Not every check is proven', components: cs };
  return { level: 'verified', reason: null, components: cs };
}

// ---- 1. content ---------------------------------------------------------------------------------------------------------------

/** `failure`: contentFailure(p), the synchronous hash + fields check (no network). */
export function contentComponent(failure: string | null): ComponentState {
  return failure
    ? { status: 'failed', reason: `The published proposal doesn't match what its hash commits to (${failure})` }
    : { status: 'proven', summary: 'Exactly what was submitted to the network: every field shown matches its governance hash' };
}

// ---- 2. collateral ------------------------------------------------------------------------------------------------------------

/** Every collateral step that must be present and `ok`; the chain ones also with basis `verified`. */
const COLLATERAL_STEPS: readonly Step['id'][] = ['hash', 'fields', 'tx', 'block', 'collateral', 'confirmations', 'chainlock', 'height'];
const CHAIN_STEPS: readonly Step['id'][] = ['block', 'confirmations', 'chainlock', 'height'];

export function collateralComponent(i: { verdict: CollateralVerdict | null; error: string | null; progress?: string; publishedHeight: number }): ComponentState {
  if (i.error) return { status: 'error', reason: `The collateral check couldn't run: ${i.error}` };
  const v = i.verdict;
  if (!v) return { status: 'pending', note: i.progress || 'Checking the collateral' };
  // A published height the verified chain contradicts is a fact about the published data; an unproven one is one node's word.
  const height = v.steps.find((s) => s.id === 'height' && s.status === 'fail' && s.basis === 'verified');
  if (height) return { status: 'failed', reason: `The published collateral height is wrong: ${height.detail}` };
  const definite = verdictFailure(v);
  if (definite) return { status: 'failed', reason: `The proposal doesn't match its on-chain collateral (${definite})` };
  if (v.inconclusive) return { status: 'error', reason: "The network couldn't be reached to fetch the collateral" };
  if (!v.ok) {
    const bad = v.steps.find((s) => s.status === 'fail');
    return { status: 'error', reason: `Nodes gave answers about the collateral that couldn't be confirmed${bad ? ` (${bad.label}: ${bad.detail})` : ''}` };
  }
  const c = v.chain;
  // Only the anchored path counts: the fallback (merkle proof + a ChainLock checked against a node-agreed list) is not proven here.
  if (!c?.anchored) return { status: 'reported', reason: "Not fully checked: the fee's block couldn't be traced to the chain your browser verified" };
  if (c.anchored.weak || c.weak) return { status: 'reported', reason: `Testnet: the chain is only protected by proof of work, which is too weak there` };
  if (v.steps.some((s) => s.id === 'crosscheck')) return { status: 'reported', reason: "The collateral's block rests on what nodes report" };
  for (const id of COLLATERAL_STEPS) {
    const s = v.steps.find((x) => x.id === id);
    if (!s) {
      return { status: 'reported', reason: id === 'height' ? 'The collateral height was not published, so it could not be compared' : `The collateral check did not cover: ${id}` };
    }
    if (s.status !== 'ok') {
      if (id === 'chainlock') return { status: 'reported', reason: 'The collateral is not final yet: no verified ChainLock covers its block' };
      if (id === 'height') return { status: 'reported', reason: `The published collateral height differs from the chain's (${s.detail})` };
      return { status: 'reported', reason: `${s.label}: ${s.detail}` };
    }
    if (CHAIN_STEPS.includes(id) && s.basis !== 'verified') return { status: 'reported', reason: `${s.label} only as a node reports it` };
  }
  if (!i.publishedHeight || c.height !== i.publishedHeight) {
    return { status: 'reported', reason: `The published collateral height (${i.publishedHeight || 'none'}) differs from the chain's (${c.height})` };
  }
  return { status: 'proven', summary: `The proposal's fee is in a final block of the verified chain (block ${c.height.toLocaleString('en-US')})` };
}

// ---- 3. chain -----------------------------------------------------------------------------------------------------------------

export function chainComponent(i: { report: ChainReport | null; error: string | null; unavailable: string | null; progress?: string }): ComponentState {
  if (i.error) return { status: 'error', reason: `The chain couldn't be verified: ${i.error}` };
  if (i.unavailable) return { status: 'reported', reason: `Not checked: ${i.unavailable}` };
  const r = i.report;
  if (!r) return { status: 'pending', note: i.progress || 'Verifying the chain' };
  if (r.anchor.weak) return { status: 'reported', reason: 'Testnet: the chain is only protected by proof of work, which is too weak there' };
  if (r.threshold.status !== 'verified') return { status: 'reported', reason: `The funding threshold isn't fully proven (${r.threshold.reason ?? 'reported'})` };
  return { status: 'proven', summary: `Verified to block ${r.anchor.tip.toLocaleString('en-US')}; the masternode list and the votes needed to pass are proven` };
}

// ---- 4. votes -----------------------------------------------------------------------------------------------------------------

export interface ShownTally {
  /** PLATFORM_TARGET or BRIDGE_TARGET: which published tally the page shows. */
  name: string;
  tally: Tally;
}

/** How old (in blocks behind the verified tip) the shown tally may be and still count: about a day on mainnet. */
export const STALE_TALLY_BLOCKS = 576;

const sameCounts = (a: Tally, b: Tally) =>
  a.yesWeighted === b.yesWeighted && a.noWeighted === b.noWeighted && a.abstainWeighted === b.abstainWeighted && a.voteSetHash.toLowerCase() === b.voteSetHash.toLowerCase();

export function votesComponent(i: {
  shown: ShownTally | null;
  /** The bridge's live tally, when there is one: a newer one with other counts means the shown tally is out of date. */
  live?: Tally | null;
  /** The verified tip, once the chain is anchored. */
  tip?: number | null;
  talliesLoading: boolean;
  bridge: boolean;
  result: VotesDone | null;
  error: string | null;
  progress?: string;
}): ComponentState {
  if (!i.shown) return i.talliesLoading ? { status: 'pending', note: 'Reading the vote tally' } : { status: 'reported', reason: 'No vote tally has been published for this proposal yet' };
  if (!i.bridge) return { status: 'reported', reason: 'Votes not recounted: no bridge is configured to fetch the signed votes' };
  if (i.error) return { status: 'error', reason: `The votes couldn't be recounted: ${i.error}` };
  const d = i.result;
  if (!d) return { status: 'pending', note: i.progress || 'Recounting the signed votes' };
  const pairs = d.runs.flatMap((run) => run.result.targets.map((t) => ({ run, t })));
  // A tally at the very block of the votes it was recounted from, and different: whoever published it, or served the votes, is wrong.
  const contradicted = pairs.find(({ run, t }) => comparable(run, t) && !t.matches);
  if (contradicted) {
    const fields = contradicted.t.compare.filter((c) => !c.ok).map((c) => c.field).join(', ');
    return {
      status: 'error', mismatch: true,
      reason: `Mismatch: the signed votes the bridge served contradict the ${contradicted.t.name} for block ${contradicted.t.asOfHeight.toLocaleString('en-US')}${fields ? ` (${fields})` : ''}. Either the tally or the bridge's vote archive is wrong, so the tally isn't verified`,
    };
  }
  // The Platform tally document is the proven record of the tally; the bridge's own live tally proves nothing about it.
  if (i.shown.name !== PLATFORM_TARGET) return { status: 'reported', reason: "The tally isn't on Platform yet, so the recount can't be checked against the proven record" };
  const hit = pairs.find(({ t }) => t.name === PLATFORM_TARGET && t.asOfHeight === i.shown!.tally.asOfHeight);
  if (!hit) return { status: 'reported', reason: 'The tally changed while the votes were recounted; re-check to recount it' };
  if (!hit.t.matches) return { status: 'reported', reason: "The bridge served the votes of another block than the Platform tally's, so the two can't be compared" };
  // A proven but old record: the votes have moved on (or the publisher stopped), so it says nothing about the funding status now.
  const shownAt = i.shown.tally.asOfHeight;
  if (i.live && i.live.asOfHeight > shownAt && !sameCounts(i.live, i.shown.tally)) {
    return { status: 'reported', reason: `The tally on Platform is ${(i.live.asOfHeight - shownAt).toLocaleString('en-US')} blocks old and the votes have changed since; re-check once it is republished` };
  }
  if (i.tip != null && i.tip - shownAt > STALE_TALLY_BLOCKS) return { status: 'reported', reason: `The tally on Platform is ${(i.tip - shownAt).toLocaleString('en-US')} blocks old` };
  const r = hit.run.result;
  if (d.sml?.weak) return { status: 'reported', reason: 'Testnet: voting keys were checked against a list only proof of work protects' };
  if (r.keysFrom !== 'sml') {
    if (r.smlUnconfirmed > 0) return { status: 'reported', reason: `Votes not fully recounted: ${r.smlUnconfirmed.toLocaleString('en-US')} voters couldn't be matched to the proven masternode list` };
    const dropped = Object.values(r.problems).reduce((a, b) => a + b, 0);
    if (dropped > 0) return { status: 'reported', reason: `Votes not fully recounted: ${dropped.toLocaleString('en-US')} votes in the bridge's set didn't check out` };
    return { status: 'reported', reason: "Not fully checked: the voters' keys are as the bridge lists them" };
  }
  return { status: 'proven', summary: `${r.verified.toLocaleString('en-US')} signed votes recounted; they match the published tally exactly` };
}

// ---- 5. funding ---------------------------------------------------------------------------------------------------------------

/** Recounted net yes (weighted yes - no) of the shown Platform tally, when the recount reproduced it on proven keys. */
export function provenNetYes(result: VotesDone | null, shown: ShownTally | null): number | null {
  if (!result || !shown || shown.name !== PLATFORM_TARGET) return null;
  for (const run of result.runs) {
    const t = run.result.targets.find((x) => x.name === PLATFORM_TARGET && x.asOfHeight === shown.tally.asOfHeight);
    if (t?.matches && run.result.keysFrom === 'sml') return run.result.weighted.yes - run.result.weighted.no;
  }
  return null;
}

/** Whether the funding order (a recount of every active proposal) is needed: active and passing on proven numbers. */
export function needsRanking(i: { active: boolean; netYes: number | null; report: ChainReport | null }): boolean {
  return i.active && i.netYes !== null && !!i.report && i.report.threshold.status === 'verified' && i.netYes >= i.report.threshold.value;
}

export function fundingComponent(i: {
  proposal: Pick<Proposal, 'govHash' | 'endEpoch'>;
  nowS: number;
  chain: ComponentState;
  votes: ComponentState;
  report: ChainReport | null;
  /** The payments scan (it follows the chain facts): still running, or why it could not. */
  payments?: { pending: boolean; error: string | null; progress?: string };
  netYes: number | null;
  ranking: { result: RankingDone | null; error: string | null; progress?: string } | null;
}): ComponentState {
  const up = [i.chain, i.votes];
  if (up.some((s) => s.status === 'pending')) return { status: 'pending', note: 'Waiting for the chain facts and the vote recount' };
  if (up.some((s) => s.status !== 'proven') || !i.report) return { status: 'reported', reason: 'Not fully checked: it depends on the checks above' };
  if (i.payments?.pending) return { status: 'pending', note: i.payments.progress || "Reading this proposal's superblock payments" };
  const p = i.report.payments;
  if (i.payments?.error) return { status: 'reported', reason: `The proposal's payments couldn't be read: ${i.payments.error}` };
  if (p?.anchor?.weak) return { status: 'reported', reason: "Testnet: the proposal's payments were read from a chain only proof of work protects" };
  if (p?.skipped) return { status: 'reported', reason: `The proposal's payment history isn't fully read yet: ${p.skipped.toLocaleString('en-US')} superblocks of its window are left for the next visit` };
  if (p && (p.unread.length || p.ambiguous.length || p.othersComplete === false)) return { status: 'reported', reason: "The proposal's payment history couldn't be fully proven" };
  const active = i.proposal.endEpoch > i.nowS;
  if (!active) {
    if (!p) return { status: 'reported', reason: "The proposal's payments were not checked" };
    return { status: 'proven', summary: `Ended; ${p.paid.length} payment${p.paid.length === 1 ? '' : 's'} found in proven superblocks` };
  }
  if (i.netYes === null) return { status: 'reported', reason: 'The net yes votes are not proven' };
  const threshold = i.report.threshold.value;
  if (i.netYes < threshold) return { status: 'proven', summary: `Not passing: ${(threshold - i.netYes).toLocaleString('en-US')} more net yes votes needed` };
  const rk = i.ranking;
  if (!rk) return { status: 'pending', note: 'Ranking every active proposal' };
  if (rk.error) return { status: 'error', reason: `The funding order couldn't be recounted: ${rk.error}` };
  if (!rk.result) return { status: 'pending', note: rk.progress || 'Ranking every active proposal' };
  const r = rk.result.result;
  const e = r.entries.find((x) => x.govHash === i.proposal.govHash);
  if (!e) return { status: 'reported', reason: 'This proposal was not part of the funding order recount' };
  if (e.timeSensitive) return { status: 'reported', reason: "Whether it is paid depends on Core's estimate of the superblock time" };
  if (!r.verified) return { status: 'reported', reason: `The funding order isn't fully proven (${r.reasons[0] ?? 'reported'})` };
  return { status: 'proven', summary: e.funded ? `Passing and in the next budget (rank ${e.rank})` : `Passing (rank ${e.rank ?? '–'}), but not in the next budget` };
}

/**
 * Whether the proposal is in the next budget, on proven data only: the funding order's answer, or "no" when the proven net yes is
 * below the proven threshold. Null when the funding status is not proven: the page then shows the source's flag, under a badge
 * that is not "Verified". Never reads a tally's `inNextBudget` or `rank`, which whoever publishes the tally sets.
 */
export function provenFunded(i: { funding: ComponentState; govHash: string; netYes: number | null; report: ChainReport | null; ranking: RankingDone | null }): boolean | null {
  if (i.funding.status !== 'proven' || i.netYes === null || !i.report) return null;
  if (i.netYes < i.report.threshold.value) return false;
  const e = i.ranking?.result.entries.find((x) => x.govHash === i.govHash);
  return e ? e.funded : null;
}
