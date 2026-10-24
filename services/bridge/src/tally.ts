// Tallies from verified signed votes, budget allocation (mirror of Core's superblock candidate), and the cross-check against
// Core's own numbers.
//
// Core rules mirrored here (Dash Core src/):
//  - per MN and signal the newest vote wins, ties by higher outcome          governance/object.cpp:420-440 (via @govhub/verify tallyVotes)
//  - weights: GetMNByCollateral on the TIP list, so PoSe-banned MNs still count; Regular 1, Evo 4
//                                                                            governance/object.cpp:880-895, evo/deterministicmns.cpp:104-116
//  - votes whose signer no longer matches the MN's voting key are dropped    governance/governance.cpp:1150-1195, votedb.cpp:81-101
//  - passing threshold max(nGovernanceMinQuorum, m_valid_weighted / 10)     governance/governance.cpp:1208-1209 (= getgovernanceinfo.fundingthreshold)
//  - candidate order: absolute yes desc, ties by proposal hash desc          governance/governance.cpp:1221-1226
//  - budget fill: skip what does not fit, window [start-2h, end+2h] around an estimated SB time now + Δh * 2.62 min
//                                                                            governance/signing.cpp:23, :58-104
import { tallyVotes, voteSetHash, VOTE_SIGNAL } from '@govhub/verify';
import type { DB, GovObjectRow, VoteRow } from './archive/db.ts';
import type { MnList } from './mnlist.ts';
import { proposalView, type ProposalView } from './proposal.ts';

/** GOVERNANCE_FUDGE_WINDOW (signing.cpp:23). */
export const FUDGE_WINDOW_S = 2 * 3600;
/** Core's superblock time estimate uses 2.62 minutes per block (signing.cpp:59). */
export const SB_SECONDS_PER_BLOCK = 2.62 * 60;

export interface ComputedTally {
  govHash: string;
  asOfHeight: number;
  listHash: string;
  weighted: { yes: number; no: number; abstain: number };
  unweighted: { yes: number; no: number; abstain: number };
  absoluteYes: number;
  counted: Array<VoteRow & { weight: number; proTxHash: string }>;
  voteSetHash: string;
  /** Votes with a valid signature that are not counted because the signer is not the MN's CURRENT voting key or the MN left the list. */
  staleKey: number;
  rank: number;
  inNextBudget: boolean;
  margin: number;
  passing: boolean;
}

/** Tally of one proposal from the archive against an MN list. */
export function tallyProposal(db: DB, govHash: string, list: { list: MnList; byOutpoint: Map<string, MnList['entries'][number]> }, asOfHeight: number, now: number): Omit<ComputedTally, 'rank' | 'inNextBudget' | 'margin' | 'passing'> {
  const rows = db.prepare("SELECT * FROM votes WHERE parent_hash = ? AND signal = ? AND sig_status = 'valid'").all(govHash, VOTE_SIGNAL.FUNDING) as VoteRow[];
  const eligible: VoteRow[] = [];
  let staleKey = 0;
  for (const v of rows) {
    const e = list.byOutpoint.get(`${v.collateral_txid}-${v.collateral_n}`);
    if (!e || e.votingKeyId !== v.signer_keyid) {
      staleKey++;
      continue;
    }
    eligible.push(v);
  }
  const weights = new Map<string, number>();
  for (const e of list.list.entries) weights.set(`${e.collateralTxid}-${e.collateralN}`, e.weight);
  const t = tallyVotes(
    eligible.map((v) => ({ mn: `${v.collateral_txid}-${v.collateral_n}`, outcome: v.outcome, time: v.time })),
    weights,
    { now },
  );
  const byKey = new Map<string, VoteRow>();
  for (const v of eligible) byKey.set(`${v.collateral_txid}-${v.collateral_n}|${v.time}|${v.outcome}`, v);
  const counted: ComputedTally['counted'] = [];
  // "counted" = the current vote of every masternode in the weight map (govhub-voteset-v1, packages/verify/src/voteset.ts)
  for (const [mn, cur] of t.current) {
    const e = list.byOutpoint.get(mn);
    if (!e) continue;
    const row = byKey.get(`${mn}|${cur.time}|${cur.outcome}`);
    if (row) counted.push({ ...row, weight: e.weight, proTxHash: e.proTxHash });
  }
  return {
    govHash,
    asOfHeight,
    listHash: list.list.listHash,
    weighted: t.weighted,
    unweighted: t.unweighted,
    absoluteYes: t.absoluteYes,
    counted,
    voteSetHash: voteSetHash(counted.map((v) => ({ mn: `${v.collateral_txid}-${v.collateral_n}`, outcome: v.outcome, time: v.time }))),
    staleKey,
  };
}

export interface BudgetCandidate {
  hash: string;
  absoluteYes: number;
  view: ProposalView | null;
}

export interface BudgetResult {
  /** Every candidate in Core's order (absolute yes desc, hash desc); rank = index + 1. */
  ordered: string[];
  allocated: Set<string>;
  allocatedDuffs: number;
  threshold: number;
}

/** Display hex compares like UintToArith256 (big-endian number) when both are 64 lowercase hex chars. */
const hashDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

export function allocateBudget(cands: BudgetCandidate[], opts: { threshold: number; budgetDuffs: number; sbTime: number }): BudgetResult {
  const ordered = [...cands].sort((a, b) => (a.absoluteYes === b.absoluteYes ? hashDesc(a.hash, b.hash) : b.absoluteYes - a.absoluteYes));
  const allocated = new Set<string>();
  let used = 0;
  for (const c of ordered) {
    if (c.absoluteYes < opts.threshold) continue;
    const v = c.view;
    if (!v || v.paymentAmountDuffs === null || v.paymentAmountDuffs <= 0) continue;
    if (used + v.paymentAmountDuffs > opts.budgetDuffs) continue;
    if (opts.sbTime < v.startEpoch - FUDGE_WINDOW_S || opts.sbTime > v.endEpoch + FUDGE_WINDOW_S) continue;
    used += v.paymentAmountDuffs;
    allocated.add(c.hash);
  }
  return { ordered: ordered.map((c) => c.hash), allocated, allocatedDuffs: used, threshold: opts.threshold };
}

/** max(nGovernanceMinQuorum, m_valid_weighted / 10) with C++ integer division. */
export function fundingThreshold(minQuorum: number, validWeighted: number): number {
  return Math.max(minQuorum, Math.trunc(validWeighted / 10));
}

export function estimateSbTime(now: number, height: number, sbHeight: number): number {
  return Math.floor(now + (sbHeight - height) * SB_SECONDS_PER_BLOCK);
}

/** Proposals that take part in tallies and the budget: in Core's current set, valid data, not expired beyond the fudge window. */
export function activeProposals(db: DB, now: number): GovObjectRow[] {
  const rows = db.prepare('SELECT * FROM gov_objects WHERE type = 1 AND in_core = 1').all() as GovObjectRow[];
  return rows.filter((r) => {
    const v = proposalView(r.data_hex);
    return v !== null && v.endEpoch + FUDGE_WINDOW_S >= now;
  });
}

export interface TallyRun {
  height: number;
  listHash: string;
  now: number;
  threshold: number;
  coreThreshold: number;
  validWeighted: number;
  nextSuperblock: number;
  budgetDuffs: number;
  allocatedDuffs: number;
  sbTime: number;
  tallies: ComputedTally[];
}

export function computeAll(
  db: DB,
  list: { list: MnList; byOutpoint: Map<string, MnList['entries'][number]> },
  height: number,
  gov: { governanceminquorum: number; fundingthreshold: number; nextsuperblock: number },
  budgetDuffs: number,
  now: number,
): TallyRun {
  const props = activeProposals(db, now);
  const partial = props.map((p) => ({ row: p, t: tallyProposal(db, p.hash, list, height, now), view: proposalView(p.data_hex) }));
  const threshold = fundingThreshold(gov.governanceminquorum, list.list.validWeighted);
  const sbTime = estimateSbTime(now, height, gov.nextsuperblock);
  const b = allocateBudget(
    partial.map((x) => ({ hash: x.row.hash, absoluteYes: x.t.absoluteYes, view: x.view })),
    { threshold, budgetDuffs, sbTime },
  );
  const rank = new Map(b.ordered.map((h, i) => [h, i + 1]));
  const tallies = partial.map(({ t }) => ({
    ...t,
    rank: rank.get(t.govHash)!,
    inNextBudget: b.allocated.has(t.govHash),
    margin: t.absoluteYes - threshold,
    passing: t.absoluteYes >= threshold,
  }));
  tallies.sort((a, b2) => a.rank - b2.rank);
  return {
    height,
    listHash: list.list.listHash,
    now,
    threshold,
    coreThreshold: gov.fundingthreshold,
    validWeighted: list.list.validWeighted,
    nextSuperblock: gov.nextsuperblock,
    budgetDuffs,
    allocatedDuffs: b.allocatedDuffs,
    sbTime,
    tallies,
  };
}

// ---------------------------------------------------------------- Core cross-check

export interface CoreComparison {
  govHash: string;
  match: boolean;
  core: { yes: number; no: number; abstain: number; absoluteYes: number };
  bridge: { yes: number; no: number; abstain: number; absoluteYes: number };
  /** Current funding votes Core counts (from `gobject getcurrentvotes`) that the bridge holds no verified signed copy of. */
  missingSigned: string[];
  /** Votes the bridge counts that Core does not list as current. */
  extra: string[];
}

/**
 * `gobject getcurrentvotes` values are "<txid>-<n>:<time>:<outcome>:<signal>:<weight>" keyed by vote hash (vote.cpp:135-143).
 * Returns the funding-signal vote hashes.
 */
export function coreCurrentFundingVotes(current: Record<string, string>): Set<string> {
  const out = new Set<string>();
  for (const [hash, s] of Object.entries(current)) {
    const parts = s.split(':');
    if (parts[3] === 'funding') out.add(hash);
  }
  return out;
}

export function compareWithCore(t: Pick<ComputedTally, 'govHash' | 'counted' | 'weighted' | 'absoluteYes'>, funding: { YesCount: number; NoCount: number; AbstainCount: number; AbsoluteYesCount: number }, coreCurrent: Set<string>): CoreComparison {
  const ours = new Set(t.counted.map((v) => v.hash));
  const missingSigned = [...coreCurrent].filter((h) => !ours.has(h)).sort();
  const extra = [...ours].filter((h) => !coreCurrent.has(h)).sort();
  const core = { yes: funding.YesCount, no: funding.NoCount, abstain: funding.AbstainCount, absoluteYes: funding.AbsoluteYesCount };
  const bridge = { yes: t.weighted.yes, no: t.weighted.no, abstain: t.weighted.abstain, absoluteYes: t.absoluteYes };
  const match = core.yes === bridge.yes && core.no === bridge.no && core.abstain === bridge.abstain && missingSigned.length === 0 && extra.length === 0;
  return { govHash: t.govHash, match, core, bridge, missingSigned, extra };
}

/** Stores a tally row unless the latest stored row for the proposal has identical content. Returns true if stored. */
export function storeTally(db: DB, t: ComputedTally, cmp: CoreComparison | null): boolean {
  const last = db.prepare('SELECT * FROM tallies WHERE gov_hash = ? ORDER BY id DESC LIMIT 1').get(t.govHash) as any;
  const same =
    last &&
    last.vote_set_hash === t.voteSetHash &&
    last.yes_weighted === t.weighted.yes &&
    last.no_weighted === t.weighted.no &&
    last.abstain_weighted === t.weighted.abstain &&
    last.rank === t.rank &&
    last.in_next_budget === (t.inNextBudget ? 1 : 0) &&
    last.margin === t.margin &&
    last.core_match === (cmp ? (cmp.match ? 1 : 0) : null);
  if (same) return false;
  db.prepare(
    `INSERT INTO tallies(gov_hash, as_of_height, list_hash, computed_at, yes_weighted, no_weighted, abstain_weighted, yes_count, no_count, abstain_count,
       vote_count, vote_set_hash, rank, in_next_budget, margin, core_yes, core_no, core_abstain, core_absolute, core_match, mismatch, counted_votes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.govHash,
    t.asOfHeight,
    t.listHash,
    Math.floor(Date.now() / 1000),
    t.weighted.yes,
    t.weighted.no,
    t.weighted.abstain,
    t.unweighted.yes,
    t.unweighted.no,
    t.unweighted.abstain,
    t.counted.length,
    t.voteSetHash,
    t.rank,
    t.inNextBudget ? 1 : 0,
    t.margin,
    cmp?.core.yes ?? null,
    cmp?.core.no ?? null,
    cmp?.core.abstain ?? null,
    cmp?.core.absoluteYes ?? null,
    cmp ? (cmp.match ? 1 : 0) : null,
    cmp && !cmp.match ? JSON.stringify({ core: cmp.core, bridge: cmp.bridge, missingSigned: cmp.missingSigned.length, extra: cmp.extra.length, missingSample: cmp.missingSigned.slice(0, 20), extraSample: cmp.extra.slice(0, 20) }) : null,
    JSON.stringify(t.counted.map((v) => v.hash).sort()),
  );
  return true;
}
