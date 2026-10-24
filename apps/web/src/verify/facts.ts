// What the proposal page may claim about chain facts, and on what basis: each helper returns the text and the provenance mark.
// "verified" only for what this browser proved; heights from consensus rules are verified, times derived from them are estimates.
import type { Cycle, Provenance } from '../data/types.ts';
import { formatDash, formatInt, formatRelative } from '../lib/format.ts';
import type { ChainReport } from './chain.ts';
import type { ChainFacts } from './collateral.ts';
import type { RankingResult } from './ranking.ts';

const SOURCE = 'chain verified in this browser';

const verified = (detail: string): Provenance => ({ kind: 'verified', source: SOURCE, detail });
const estimate = (detail: string): Provenance => ({ kind: 'reported', source: 'estimate', detail });

/** The collateral's place in the chain: verified when its block is in the verified chain or under a verified ChainLock. */
export function collateralStatus(c: ChainFacts): { text: string; prov: Provenance } {
  const source = 'collateral check in this browser';
  if (c.anchored) {
    const a = c.anchored;
    return {
      text: `${formatInt(a.confirmations)} confirmations; ${a.final ? `final (ChainLocked at block ${formatInt(a.chainLockHeight)})` : `not ChainLocked yet (newest lock: block ${formatInt(a.chainLockHeight)})`}`,
      prov: { kind: 'verified', source, detail: 'the block is the one at its height in the chain verified from the checkpoint; confirmations counted from the verified tip; ChainLock BLS-verified' },
    };
  }
  if (c.chainLocked === 'verified' && c.lockDepth !== null) {
    return {
      text: `final (ChainLocked); at least ${formatInt(c.lockDepth)} confirmations`,
      prov: { kind: 'verified', source, detail: 'a BLS-valid ChainLock covers the block through verified headers' },
    };
  }
  const conf = formatInt(c.confirmations);
  return {
    text: c.chainLocked === 'claimed' ? `ChainLocked as a node reports; ${conf} confirmations (node-reported)` : `not ChainLocked yet; ${conf} confirmations (node-reported)`,
    prov: { kind: 'reported', source, detail: `${c.merkle ? 'the block a node names is internally consistent but not tied to the chain' : 'block inclusion not proven'}; the ChainLock was not verified here` },
  };
}

/** The collateral height as shown next to the txid. */
export function collateralHeightProv(c: ChainFacts | undefined, published: number, fallback: Provenance): Provenance {
  if (!c || c.height !== published) return fallback;
  if (c.anchored || c.chainLocked === 'verified') return verified("the block's coinbase commits to this height and the block is in the verified chain");
  return fallback;
}

/** Funding threshold: from the proven masternode list when it is fully proven, else the bridge's cycle document. */
export function thresholdFact(r: ChainReport | null, fallback: { value: number; prov: Provenance } | null): { value: number; prov: Provenance } | null {
  if (!r) return fallback;
  const t = r.threshold;
  const how = `${formatInt(t.validWeighted)} weighted valid masternodes / 10 (at least the minimum quorum), list at block ${formatInt(t.height)}`;
  if (t.status === 'verified') return { value: t.value, prov: verified(`${how}; masternode list proven by that block's coinbase${t.legacy.valid ? `, ${formatInt(t.legacy.valid)} older entries' types proven by their registrations` : ''}`) };
  return { value: t.value, prov: { kind: 'reported', source: 'masternode list', detail: `${how}; ${t.reason ?? 'not fully proven'}` } };
}

/** Voting deadline: the height is a consensus fact at the verified tip; the time is Core's own 2.62-minute estimate. */
export function deadlineFact(r: ChainReport | null, cycle: Cycle | null, nowS: number, cycleProv: Provenance | undefined, fallbackTime: number | null): { text: string; prov: Provenance | undefined } | null {
  if (r) {
    const s = r.schedule;
    const when = s.inMaturityWindow ? 'passed: the payees of the next superblock are being decided' : `${formatRelative(s.deadlineEstTime, nowS)} (estimated)`;
    return { text: `block ${formatInt(s.votingDeadline)}, ${when}`, prov: verified(`height from the superblock schedule at verified block ${formatInt(s.tip)}; the date assumes 2.62 minutes per block, as Core does`) };
  }
  if (!cycle) return null;
  return { text: `${fallbackTime !== null ? `${formatRelative(fallbackTime, nowS)}, ` : ''}block ${formatInt(cycle.votingDeadlineHeight)}`, prov: cycleProv };
}

/** Payments made (proven from coinbases) and still possible (estimated). */
export function paymentsFact(r: ChainReport | null): { made: { text: string; prov: Provenance }; remaining: { text: string; prov: Provenance } } | null {
  const p = r?.payments;
  if (!r || !p) return null;
  const heights = p.paid.map((x) => formatInt(x.height)).join(', ');
  const unread = p.unread.length ? `; ${p.unread.length} superblocks could not be read, so this is a lower bound` : '';
  return {
    made: {
      text: `${formatInt(p.paid.length)}${p.unread.length ? ' or more' : ''}`,
      prov: verified(`${p.paid.length ? `paid in superblock${p.paid.length > 1 ? 's' : ''} ${heights}` : 'no payment found'}: each superblock from the collateral's block to the verified tip (${formatInt(p.checked.length)} checked) was read from its coinbase in the verified chain${unread}`),
    },
    remaining: {
      text: `${formatInt(p.remainingEstimate)} more possible`,
      prov: estimate("superblocks whose estimated time (2.62 minutes per block from now, Core's estimate) falls in the payment window; each still needs the votes"),
    },
  };
}

/** Budget limit of the next superblock, compared with what the bridge reports. */
export function budgetFact(r: ChainReport, cycle: Cycle | null): { text: string; ok: boolean | null } {
  const limit = Number(r.budget.limit);
  const vs = cycle && cycle.superblockHeight === r.budget.height ? (cycle.budget === limit ? 'the bridge reports the same' : `the bridge reports ${formatDash(cycle.budget)}`) : null;
  const exact = `${(limit / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 })} DASH`;
  return { text: `${exact} for superblock ${formatInt(r.budget.height)}${vs ? `; ${vs}` : ''}`, ok: vs === null ? null : cycle!.budget === limit };
}

/** Funded / rank for one proposal from a recount of every listed proposal. */
export function fundedFact(rk: RankingResult | null, govHash: string): { text: string; prov: Provenance } | null {
  const e = rk?.entries.find((x) => x.govHash === govHash);
  if (!rk || !e) return null;
  const text = e.funded ? `Yes, in the next superblock (rank ${e.rank})` : e.rank !== null ? `Passing (rank ${e.rank}), but not in the next superblock` : 'No';
  const basis = `recount of all ${rk.entries.length} proposals the bridge lists, ranked by Core's rules against the proven threshold and budget (a proposal the bridge leaves out cannot be detected)`;
  return rk.verified && !e.timeSensitive
    ? { text, prov: verified(basis) }
    : { text, prov: { kind: 'reported', source: 'funding order', detail: `${basis}; not verified: ${rk.reasons.join('; ') || 'the superblock time decides it'}` } };
}
