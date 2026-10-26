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
import { countVotes, VOTE_SIGNAL } from '@govhub/verify';
import type { DB, GovObjectRow, VoteRow } from './archive/db.ts';
import { nowS } from './log.ts';
import type { LoadedMnList } from './mnlist.ts';
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

/** The masternode key ("<collateral txid>-<n>") a vote belongs to. */
const voteMn = (v: VoteRow): string => `${v.collateral_txid}-${v.collateral_n}`;

/** Tally of one proposal from the archive against an MN list. */
export function tallyProposal(db: DB, govHash: string, list: LoadedMnList, asOfHeight: number, now: number): Omit<ComputedTally, 'rank' | 'inNextBudget' | 'margin' | 'passing'> {
  const rows = db.prepare("SELECT * FROM votes WHERE parent_hash = ? AND signal = ? AND sig_status = 'valid'").all(govHash, VOTE_SIGNAL.FUNDING) as VoteRow[];
  const eligible: VoteRow[] = [];
  let staleKey = 0;
  for (const v of rows) {
    const e = list.byOutpoint.get(voteMn(v));
    if (!e || e.votingKeyId !== v.signer_keyid) {
      staleKey++;
      continue;
    }
    eligible.push(v);
  }
  const weights = new Map<string, number>();
  for (const e of list.list.entries) weights.set(`${e.collateralTxid}-${e.collateralN}`, e.weight);
  // THE counting rule lives in @govhub/verify (countVotes): clients recount with the same function.
  const t = countVotes(
    eligible.map((v) => ({ mn: voteMn(v), outcome: v.outcome, time: v.time })),
    weights,
    { now },
  );
  const byKey = new Map<string, VoteRow>();
  for (const v of eligible) byKey.set(`${voteMn(v)}|${v.time}|${v.outcome}`, v);
  const counted: ComputedTally['counted'] = [];
  for (const { mn, outcome, time } of t.counted) {
    const e = list.byOutpoint.get(mn);
    const row = byKey.get(`${mn}|${time}|${outcome}`);
    if (e && row) counted.push({ ...row, weight: e.weight, proTxHash: e.proTxHash });
  }
  // the published set and the hash must describe the same masternodes
  if (counted.length !== t.counted.length) throw new Error(`tally ${govHash}: ${t.counted.length} counted masternodes but ${counted.length} archived votes for them`);
  return {
    govHash,
    asOfHeight,
    listHash: list.list.listHash,
    weighted: t.weighted,
    unweighted: t.unweighted,
    absoluteYes: t.absoluteYes,
    counted,
    voteSetHash: t.voteSetHash,
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
  /**
   * Whether these tallies were stored (the `tallies` rows readers recount published tallies against). Only a stored run may be
   * published; a live vote refresh is not stored.
   */
  persisted: boolean;
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
  list: LoadedMnList,
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
    persisted: false,
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

// ---------------------------------------------------------------- superseded live vote sets

/** How long a superseded live vote set stays retrievable by its voteSetHash, and how many are kept at most (oldest go first). */
export const RETIRED_SET_TTL_S = 15 * 60;
export const RETIRED_SET_MAX = 256;

/** A counted vote set as recorded: the tally it belongs to, and the hashes of its votes (the votes themselves are in the archive). */
export interface RecordedVoteSet {
  asOfHeight: number;
  listHash: string;
  voteSetHash: string;
  weighted: ComputedTally['weighted'];
  voteHashes: string[];
}

/** A live tally's vote set after a newer run replaced it. */
export interface RetiredVoteSet extends RecordedVoteSet {
  govHash: string;
  retiredAt: number;
}

/**
 * The live tally changes at the same height whenever a vote arrives, and only the block path stores tallies: a client that read the live
 * tally and then asks for its votes may find a newer set. The sets a newer run replaced are kept here for a while, so that client can
 * still fetch exactly the set behind the tally it holds (`/v1/proposals/{hash}/votes?voteSetHash=`). Memory only, bounded in age and count.
 */
export class RetiredVoteSets {
  private readonly sets = new Map<string, RetiredVoteSet>();

  /** Keeps every tally of `old` whose vote set `next` no longer has. */
  retire(old: TallyRun, next: TallyRun, now: number): void {
    const current = new Set(next.tallies.map((t) => `${t.govHash}|${t.voteSetHash}`));
    for (const t of old.tallies) {
      const key = `${t.govHash}|${t.voteSetHash}`;
      if (current.has(key)) continue;
      // re-inserted (a set can be current again, e.g. a voter banned and revived): it ages from now, at the end of the order
      this.sets.delete(key);
      this.sets.set(key, { govHash: t.govHash, voteSetHash: t.voteSetHash, asOfHeight: t.asOfHeight, listHash: t.listHash, weighted: t.weighted, voteHashes: t.counted.map((v) => v.hash), retiredAt: now });
    }
    // Map order is insertion order: the oldest first
    for (const [key, s] of this.sets) {
      if (this.sets.size <= RETIRED_SET_MAX && now - s.retiredAt <= RETIRED_SET_TTL_S) break;
      this.sets.delete(key);
    }
  }

  get(govHash: string, voteSetHash: string, now: number): RetiredVoteSet | undefined {
    const s = this.sets.get(`${govHash}|${voteSetHash}`);
    return s && now - s.retiredAt <= RETIRED_SET_TTL_S ? s : undefined;
  }

  get size(): number {
    return this.sets.size;
  }
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
    nowS(),
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
    null,
  );
  db.prepare('INSERT OR IGNORE INTO vote_sets(gov_hash, vote_set_hash, vote_hashes, created_at) VALUES (?, ?, ?, ?)').run(t.govHash, t.voteSetHash, JSON.stringify(t.counted.map((v) => v.hash).sort()), nowS());
  return true;
}
