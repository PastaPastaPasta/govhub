// One trust signal per proposal (DESIGN.md §2). Pure: every check's raw result is mapped to a component state, and the components
// to one level. "verified" is the last resort, reached only when every REQUIRED check is present exactly once and proven. Each
// mapping reads the per-step basis, never `verdict.ok` or a provenance kind alone: a node's word, the per-transaction ChainLock
// fallback, a height mismatch, testnet proof of work and fixture data can each only lower the level.
import type { Proposal, Tally } from '../data/types.ts';
import type { ChainReport } from './chain.ts';
import { verdictFailure, type CollateralVerdict, type Step } from './collateral.ts';
import type { RankingDone, VotesDone } from './protocol.ts';
import { voteVerdict } from './verdict.ts';

export type CheckId = 'content' | 'collateral' | 'chain' | 'votes' | 'funding';
export const REQUIRED: readonly CheckId[] = ['content', 'collateral', 'chain', 'votes', 'funding'];

export const CHECK_LABEL: Record<CheckId, string> = {
  content: 'Proposal content',
  collateral: 'Collateral',
  chain: 'Chain and masternode list',
  votes: 'Votes',
  funding: 'Funding status',
};

export type ComponentState =
  /** Still running (`note`: what it is doing). */
  | { status: 'pending'; note?: string }
  /** Proven in this browser. */
  | { status: 'proven'; summary: string }
  /** Completed, but some of it rests on someone's word (a node, the bridge, weak proof of work). */
  | { status: 'reported'; reason: string }
  /** Could not complete (network, timeouts). Says nothing about the proposal. */
  | { status: 'error'; reason: string }
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
    : { status: 'proven', summary: 'The governance hash recomputes from the published data, and every field shown is the hashed one' };
}

// ---- 2. collateral ------------------------------------------------------------------------------------------------------------

/** Every collateral step that must be present and `ok`; the chain ones also with basis `verified`. */
const COLLATERAL_STEPS: readonly Step['id'][] = ['hash', 'fields', 'tx', 'block', 'collateral', 'confirmations', 'chainlock', 'height'];
const CHAIN_STEPS: readonly Step['id'][] = ['block', 'confirmations', 'chainlock', 'height'];

export function collateralComponent(i: { verdict: CollateralVerdict | null; error: string | null; progress?: string; publishedHeight: number }): ComponentState {
  if (i.error) return { status: 'error', reason: `The collateral check couldn't run: ${i.error}` };
  const v = i.verdict;
  if (!v) return { status: 'pending', note: i.progress || 'Checking the collateral' };
  const definite = verdictFailure(v);
  if (definite) return { status: 'failed', reason: `The proposal doesn't match its on-chain collateral (${definite})` };
  if (v.inconclusive) return { status: 'error', reason: "The network couldn't be reached to fetch the collateral" };
  if (!v.ok) {
    const bad = v.steps.find((s) => s.status === 'fail');
    return { status: 'error', reason: `Nodes gave answers about the collateral that couldn't be confirmed${bad ? ` (${bad.label}: ${bad.detail})` : ''}` };
  }
  const c = v.chain;
  // Only the anchored path counts: the fallback (merkle proof + a ChainLock checked against a node-agreed list) is not proven here.
  if (!c?.anchored) return { status: 'reported', reason: "The collateral's block isn't tied to the chain this browser verified" };
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
  return { status: 'proven', summary: `Burns 1 DASH to the proposal's hash in block ${c.height.toLocaleString('en-US')} of the verified chain, ChainLocked and final` };
}

// ---- 3. chain -----------------------------------------------------------------------------------------------------------------

export function chainComponent(i: { report: ChainReport | null; error: string | null; unavailable: string | null; progress?: string }): ComponentState {
  if (i.error) return { status: 'error', reason: `The chain couldn't be verified: ${i.error}` };
  if (i.unavailable) return { status: 'reported', reason: `Chain facts not verified: ${i.unavailable}` };
  const r = i.report;
  if (!r) return { status: 'pending', note: i.progress || 'Verifying the chain' };
  if (r.anchor.weak) return { status: 'reported', reason: 'Testnet: the chain is only protected by proof of work, which is too weak there' };
  if (r.threshold.status !== 'verified') return { status: 'reported', reason: `The funding threshold isn't fully proven (${r.threshold.reason ?? 'reported'})` };
  const how = r.anchor.trust.kind === 'quorum-proof' ? 'ChainLocks proven from the pinned quorum checkpoint' : 'the pinned checkpoint and proof of work';
  return { status: 'proven', summary: `Chain verified to block ${r.anchor.tip.toLocaleString('en-US')} from ${how}; masternode list and threshold proven` };
}

// ---- 4. votes -----------------------------------------------------------------------------------------------------------------

export interface ShownTally {
  /** PLATFORM_TARGET or BRIDGE_TARGET: which published tally the page shows. */
  name: string;
  tally: Tally;
}

export function votesComponent(i: {
  shown: ShownTally | null;
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
  if (voteVerdict(d.runs).level === 'mismatch') return { status: 'failed', reason: "The recounted votes don't match the published tally" };
  const hit = d.runs.flatMap((run) => run.result.targets.map((t) => ({ run, t }))).find(({ t }) => t.name === i.shown!.name && t.asOfHeight === i.shown!.tally.asOfHeight);
  if (!hit) return { status: 'reported', reason: 'The tally changed while the votes were recounted; re-check to recount it' };
  const { run, t } = hit;
  if (!t.matches) {
    // Same height and different: a contradiction. Otherwise the votes moved on since this tally.
    return t.asOfHeight === run.votesAsOf ? { status: 'failed', reason: "The recounted votes don't match the published tally" } : { status: 'reported', reason: 'Votes have changed since this tally was published; re-check later' };
  }
  const r = run.result;
  if (d.sml?.weak) return { status: 'reported', reason: 'Testnet: voting keys were checked against a list only proof of work protects' };
  if (r.keysFrom !== 'sml') {
    if (r.smlUnconfirmed > 0) return { status: 'reported', reason: `Votes not fully recounted: ${r.smlUnconfirmed.toLocaleString('en-US')} voters couldn't be matched to the proven masternode list` };
    const dropped = Object.values(r.problems).reduce((a, b) => a + b, 0);
    if (dropped > 0) return { status: 'reported', reason: `Votes not fully recounted: ${dropped.toLocaleString('en-US')} votes in the bridge's set didn't check out` };
    return { status: 'reported', reason: 'Votes not fully recounted: voting keys only as the bridge reports them' };
  }
  return { status: 'proven', summary: `${r.verified.toLocaleString('en-US')} signed votes recounted against the proven masternode list; the tally and its voteSetHash match` };
}

// ---- 5. funding ---------------------------------------------------------------------------------------------------------------

/** Recounted net yes (weighted yes - no) of the shown tally, when the votes component proved it. */
export function provenNetYes(result: VotesDone | null, shown: ShownTally | null): number | null {
  if (!result || !shown) return null;
  for (const run of result.runs) {
    const t = run.result.targets.find((x) => x.name === shown.name && x.asOfHeight === shown.tally.asOfHeight);
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
  netYes: number | null;
  ranking: { result: RankingDone | null; error: string | null; progress?: string } | null;
}): ComponentState {
  const up = [i.chain, i.votes];
  if (up.some((s) => s.status === 'pending')) return { status: 'pending', note: 'Waiting for the chain facts and the vote recount' };
  if (up.some((s) => s.status !== 'proven') || !i.report) return { status: 'reported', reason: 'The funding status follows from facts that are not all proven' };
  const p = i.report.payments;
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
