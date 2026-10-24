// DashCentral-compatible JSON (GET /api/v1/budget, GET /api/v1/proposal?hash=). Field names follow DashCentral's public API;
// values are only what the bridge actually knows. Things that live elsewhere or nowhere yet are null (title, owner_username,
// comment_amount), never invented. Payment counts are schedule estimates (see paymentCounts).
import type { Bridge } from '../bridge.ts';
import type { GovObjectRow } from '../archive/db.ts';
import { proposalView } from '../proposal.ts';
import { FUDGE_WINDOW_S, SB_SECONDS_PER_BLOCK } from '../tally.ts';

const fmt = (unix: number) => new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19);

/**
 * Estimated number of superblocks inside [start - 2h, end + 2h] (Core's payment window, signing.cpp:85-97), assuming
 * superblocks every `cycle` blocks at 2.62 min per block anchored at the next superblock's estimated time.
 */
export function paymentCounts(startEpoch: number, endEpoch: number, nextSbTime: number, cycleBlocks: number): { total: number; remaining: number } {
  const step = cycleBlocks * SB_SECONDS_PER_BLOCK;
  const lo = startEpoch - FUDGE_WINDOW_S;
  const hi = endEpoch + FUDGE_WINDOW_S;
  const kMin = Math.ceil((lo - nextSbTime) / step);
  const kMax = Math.floor((hi - nextSbTime) / step);
  const total = Math.max(0, kMax - kMin + 1);
  const remaining = Math.max(0, kMax - Math.max(kMin, 0) + 1);
  return { total, remaining };
}

function proposalEntry(b: Bridge, r: GovObjectRow) {
  const v = proposalView(r.data_hex);
  const run = b.lastRun;
  const info = b.govInfo;
  const t = run?.tallies.find((x) => x.govHash === r.hash);
  const sbTime = run?.sbTime ?? 0;
  const counts = v && info && run ? paymentCounts(v.startEpoch, v.endEpoch, sbTime, info.superblockcycle) : null;
  const inWindow = v ? sbTime >= v.startEpoch - FUDGE_WINDOW_S && sbTime <= v.endEpoch + FUDGE_WINDOW_S : false;
  const deadlineTime = run && info ? Math.floor(run.sbTime - info.superblockmaturitywindow * SB_SECONDS_PER_BLOCK) : null;
  const amount = v ? (v.paymentAmountDuffs !== null ? v.paymentAmountDuffs / 1e8 : v.paymentAmount) : null;
  return {
    hash: r.hash,
    name: v?.name ?? null,
    url: v?.url ?? null,
    dw_url: b.cfg.portalProposalUrl.replace('{hash}', r.hash).replace('{name}', encodeURIComponent(v?.name ?? '')),
    title: null,
    date_added: fmt(r.time),
    date_end: v ? fmt(v.endEpoch) : null,
    voting_deadline: deadlineTime !== null ? fmt(deadlineTime) : null,
    will_be_funded: t ? t.inNextBudget : false,
    remaining_yes_votes_until_funding: t && run ? Math.max(0, run.threshold - t.absoluteYes) : null,
    in_next_budget: inWindow,
    monthly_amount: amount,
    total_payment_count: counts?.total ?? null,
    remaining_payment_count: counts?.remaining ?? null,
    yes: t?.weighted.yes ?? null,
    no: t?.weighted.no ?? null,
    abstain: t?.weighted.abstain ?? null,
    order: t?.rank ?? null,
    comment_amount: null,
    owner_username: null,
  };
}

export function dashCentralBudget(b: Bridge) {
  const run = b.lastRun;
  const info = b.govInfo;
  if (!run || !info) return { status: 'error' as const, error_type: 'not_ready', error_message: 'tallies not computed yet' };
  const rows = b.db.prepare('SELECT * FROM gov_objects WHERE type = 1').all() as GovObjectRow[];
  const active = new Set(run.tallies.map((t) => t.govHash));
  const proposals = rows.filter((r) => active.has(r.hash)).map((r) => proposalEntry(b, r));
  proposals.sort((a, c) => (a.order ?? 1e9) - (c.order ?? 1e9));
  const requested = proposals.reduce((s, p) => s + (p.monthly_amount ?? 0), 0);
  const deadline = Math.floor(run.sbTime - info.superblockmaturitywindow * SB_SECONDS_PER_BLOCK);
  return {
    status: 'ok' as const,
    budget: {
      total_amount: run.budgetDuffs / 1e8,
      all_proposals: proposals.length,
      budget_requested: Math.round(requested * 1e8) / 1e8,
      budget_allocated: run.allocatedDuffs / 1e8,
      budget_left: (run.budgetDuffs - run.allocatedDuffs) / 1e8,
      superblock: run.nextSuperblock,
      payment_date: fmt(run.sbTime),
      voting_deadline: fmt(deadline),
      voting_deadline_height: run.nextSuperblock - info.superblockmaturitywindow,
      funding_threshold: run.threshold,
      as_of_height: run.height,
    },
    proposals,
  };
}

export function dashCentralProposal(b: Bridge, hash: string) {
  const r = b.db.prepare('SELECT * FROM gov_objects WHERE type = 1 AND hash = ?').get(hash) as GovObjectRow | undefined;
  if (!r) return { status: 'error' as const, error_type: 'proposal_not_found', error_message: 'unknown proposal hash' };
  return { status: 'ok' as const, proposal: { ...proposalEntry(b, r), description_base64_bb: null, description_base64_html: null, comments: null } };
}
