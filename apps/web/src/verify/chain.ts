// Chain facts for the proposal page, from the anchored chain (@govhub/dapi anchorChain): the funding threshold from the proven
// masternode list, the superblock schedule and budget limit from consensus rules at the verified height, and the payments the
// proposal received, read from superblock coinbases of the verified chain. Runs in the verification worker.
import type { AnchorTrust, AnchoredChain, Dapi, ProRegCache } from '@govhub/dapi';
import {
  findPayment, fundingThreshold, GOV_CHAIN_PARAMS, superblockPaymentsLimit, superblockSchedule, superblocksBetween, type SuperblockSchedule,
} from '@govhub/verify';
import type { CoreNetwork, Proposal } from '../data/types.ts';

/** Core's superblock-time estimate (governance/signing.cpp:58-59): 2.62 minutes per block from now. */
export const EST_BLOCK_SECONDS = 2.62 * 60;
/** GOVERNANCE_FUDGE_WINDOW (signing.cpp:23). */
const FUDGE_S = 2 * 3600;

/** What the anchored chain itself established (shown in "how this was checked"). */
export interface AnchorSummary {
  /** Set on networks where proof of work protects nothing (testnet): every fact below is consistent, not secure. */
  weak: string | null;
  /** Lowest and highest verified heights (the tip is a lower bound: a node can withhold newer blocks, not invent them). */
  lo: number;
  tip: number;
  checkpoint: number;
  /** What the chain rests on: ChainLocks proven from the pinned quorum checkpoint, or proof of work (and why). */
  trust: AnchorTrust;
  chainLock: { height: number; blockHash: string; quorumHash: string; exact: boolean; time: number };
  sml: { height: number; blockHash: string; entries: number; quorums: number };
  headers: { cached: number; fetched: number };
  ms: Record<string, number>;
}

export interface ThresholdFact {
  status: 'verified' | 'reported';
  /** max(nGovernanceMinQuorum, validWeighted / 10). */
  value: number;
  validWeighted: number;
  /** Height of the masternode list it was computed from. */
  height: number;
  /** Valid version-1 entries, whose type the list's hash does not cover, and how many of them a ProRegTx proved. */
  legacy: { valid: number; proven: number };
  reason?: string;
}

export interface PaymentsFact {
  /** Superblocks of the verified chain in the proposal's window (from the collateral's block on), each read from its coinbase. */
  checked: number[];
  /** Those whose coinbase pays the proposal's address its exact amount. */
  paid: Array<{ height: number; output: number; time: number }>;
  /** Whether every listed proposal (active and past) was compared; otherwise an unlisted twin could account for a payment. */
  othersComplete?: boolean;
  /** Payments another listed proposal (same address and amount, its window too) could equally account for. */
  ambiguous: Array<{ height: number; with: string }>;
  /** Superblocks that could not be read (the count above is then a lower bound). */
  unread: Array<{ height: number; error: string }>;
  /** Later superblocks whose estimated time falls inside the proposal window (Core's estimate: now + blocks * 2.62 min). */
  remainingEstimate: number;
}

export interface ChainReport {
  network: CoreNetwork;
  anchor: AnchorSummary;
  schedule: SuperblockSchedule & { tip: number; nextEstTime: number; deadlineEstTime: number };
  /** Payments limit of the next superblock, duffs (decimal string: structured-clone safe and exact). */
  budget: { height: number; limit: string };
  threshold: ThresholdFact;
  payments: PaymentsFact | null;
}

export function summarize(a: AnchoredChain): AnchorSummary {
  return {
    weak: a.weak, lo: a.chain.lo, tip: a.tip, checkpoint: a.checkpoint.height, trust: a.trust, chainLock: a.chainLock,
    sml: { height: a.sml.proof.height, blockHash: a.sml.proof.blockHash, entries: a.sml.proof.entries, quorums: a.sml.proof.quorums },
    headers: { cached: a.stats.cachedHeaders, fetched: a.stats.fetchedHeaders }, ms: a.stats.ms,
  };
}

/** GetMnType(type).voting_weight (evo/dmn_types.h:26-44): regular 1, evonode 4, anything else 0. */
function weight(type: number): number {
  if (type === 0) return 1;
  return type === 1 ? 4 : 0;
}

/** Valid weighted count with every entry's type as the list states it. */
export function claimedWeight(masternodes: ReadonlyArray<{ isValid: boolean; nType: number }>): number {
  return masternodes.reduce((n, m) => n + (m.isValid ? weight(m.nType) : 0), 0);
}

/**
 * Valid weighted count of the proven list (CDeterministicMNList::GetCounts, evo/deterministicmns.h:269-293). Entry types from
 * version 2 on are covered by the list's merkle root; version-1 types are proven from their ProRegTxs (cached, fetched once).
 */
export async function threshold(dapi: Dapi, a: AnchoredChain, network: CoreNetwork, cache: ProRegCache, progress: (m: string) => void): Promise<ThresholdFact> {
  const sml = a.sml;
  let w = 0;
  const legacy: string[] = [];
  for (const m of sml.masternodes) {
    if (!m.isValid) continue;
    if (m.nVersion >= 2) w += weight(m.nType);
    else legacy.push(m.proTxHash);
  }
  const base = { height: sml.proof.height, legacy: { valid: legacy.length, proven: 0 } };
  if (sml.masternodes.length !== sml.mnCount) {
    const v = claimedWeight(sml.masternodes);
    return { ...base, status: 'reported', validWeighted: v, value: fundingThreshold(v, network), reason: `${sml.mnCount - sml.masternodes.length} list entries could not be read` };
  }
  try {
    const info = await dapi.getProRegInfo(legacy, {
      cache,
      onProgress: (done, total) => { if (done === 1 || done % 50 === 0 || done === total) progress(`Proving the type of ${total.toLocaleString('en-US')} older masternode entries from their registrations (${done.toLocaleString('en-US')} done; cached afterwards)`); },
    });
    for (const h of legacy) w += weight(info.get(h)!.type);
    return { ...base, status: 'verified', validWeighted: w, value: fundingThreshold(w, network), legacy: { valid: legacy.length, proven: legacy.length } };
  } catch (e) {
    // fall back to the list's claimed types for the unproven entries, and say so
    const claimed = claimedWeight(sml.masternodes);
    return { ...base, status: 'reported', validWeighted: claimed, value: fundingThreshold(claimed, network), reason: `the type of ${legacy.length} older entries could not be proven (${(e as Error).message}); their weight is as the list states it` };
  }
}

/**
 * Core pays a proposal in a superblock whose time, as Core estimates it when the maturity window opens (now + blocks * 2.62 min,
 * signing.cpp:58-59), lies in [start - 2 h, end + 2 h] (signing.cpp:86-99). The real block time is within hours of that estimate,
 * so a day of slack on each side keeps every real payment and no payment of another proposal's period.
 */
const WINDOW_SLACK_S = 86_400;
type Payee = Pick<Proposal, 'paymentAddress' | 'paymentAmount' | 'startEpoch' | 'endEpoch'>;
const inWindow = (p: Payee, t: number) => t >= p.startEpoch - FUDGE_S - WINDOW_SLACK_S && t <= p.endEpoch + FUDGE_S + WINDOW_SLACK_S;

/** Superblocks from the collateral's block to the verified tip, each fetched as a proven block of the chain, checked for this proposal's payment. */
export async function payments(
  dapi: Dapi, a: AnchoredChain, p: Payee, others: ReadonlyArray<Payee & { govHash: string }>, network: CoreNetwork, from: number, nowS: number,
): Promise<PaymentsFact> {
  const out: PaymentsFact = { checked: [], paid: [], ambiguous: [], unread: [], remainingEstimate: 0 };
  const twins = others.filter((o) => o.paymentAddress === p.paymentAddress && o.paymentAmount === p.paymentAmount);
  for (const h of superblocksBetween(Math.max(from, a.chain.lo), a.tip, network)) {
    try {
      const { block } = await dapi.getAnchoredBlock(a, h);
      const time = block.header.time;
      if (time > p.endEpoch + FUDGE_S + WINDOW_SLACK_S) break;
      if (!inWindow(p, time)) continue;
      out.checked.push(h);
      const i = findPayment(block.txs[0]!.outputs, p.paymentAddress, BigInt(p.paymentAmount), network);
      if (i < 0) continue;
      const twin = twins.find((o) => inWindow(o, time));
      if (twin) out.ambiguous.push({ height: h, with: twin.govHash });
      else out.paid.push({ height: h, output: i, time });
    } catch (e) {
      out.unread.push({ height: h, error: (e as Error).message });
    }
  }
  const { next } = superblockSchedule(a.tip, network);
  for (let h = next; ; h += GOV_CHAIN_PARAMS[network].superblockCycle) {
    const est = nowS + (h - a.tip) * EST_BLOCK_SECONDS;
    if (est > p.endEpoch + FUDGE_S) break;
    if (est >= p.startEpoch - FUDGE_S) out.remainingEstimate++;
  }
  return out;
}

export function scheduleAndBudget(a: AnchoredChain, network: CoreNetwork, nowS: number): Pick<ChainReport, 'schedule' | 'budget'> {
  const s = superblockSchedule(a.tip, network);
  return {
    schedule: { ...s, tip: a.tip, nextEstTime: Math.round(nowS + (s.next - a.tip) * EST_BLOCK_SECONDS), deadlineEstTime: Math.round(nowS + (s.votingDeadline - a.tip) * EST_BLOCK_SECONDS) },
    budget: { height: s.next, limit: superblockPaymentsLimit(s.next, network).toString() },
  };
}
