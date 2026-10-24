// Chain facts for the proposal page, from the anchored chain (@govhub/dapi anchorChain): the funding threshold from the proven
// masternode list, the superblock schedule and budget limit from consensus rules at the verified height, and the payments the
// proposal received, read from superblock coinbases of the verified chain. Runs in the verification worker.
import type { AnchoredChain, Dapi, ProRegCache } from '@govhub/dapi';
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
  /** Lowest and highest verified heights (the tip is a lower bound: a node can withhold newer blocks, not invent them). */
  lo: number;
  tip: number;
  checkpoint: number;
  chainLock: { height: number; blockHash: string; quorumHash: string; exact: boolean };
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
  /** Superblocks of the verified chain from the collateral's block to the tip, each read from its coinbase. */
  checked: number[];
  /** Those whose coinbase pays the proposal's address its exact amount. */
  paid: Array<{ height: number; output: number; time: number }>;
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
    lo: a.chain.lo, tip: a.tip, checkpoint: a.checkpoint.height, chainLock: a.chainLock,
    sml: { height: a.sml.proof.height, blockHash: a.sml.proof.blockHash, entries: a.sml.proof.entries, quorums: a.sml.proof.quorums },
    headers: { cached: a.stats.cachedHeaders, fetched: a.stats.fetchedHeaders }, ms: a.stats.ms,
  };
}

/** GetMnType(type).voting_weight (evo/dmn_types.h:26-44): regular 1, evonode 4, anything else 0. */
const weight = (type: number) => (type === 0 ? 1 : type === 1 ? 4 : 0);

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
    const v = sml.masternodes.reduce((n, m) => n + (m.isValid ? weight(m.nType) : 0), 0);
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
    const claimed = sml.masternodes.reduce((n, m) => n + (m.isValid ? weight(m.nType) : 0), 0);
    return { ...base, status: 'reported', validWeighted: claimed, value: fundingThreshold(claimed, network), reason: `the type of ${legacy.length} older entries could not be proven (${(e as Error).message}); their weight is as the list states it` };
  }
}

/** Superblocks from the collateral's block to the verified tip, each fetched as a proven block of the chain, checked for this proposal's payment. */
export async function payments(dapi: Dapi, a: AnchoredChain, p: Pick<Proposal, 'collateralHeight' | 'paymentAddress' | 'paymentAmount' | 'startEpoch' | 'endEpoch'>, network: CoreNetwork, from: number, nowS: number): Promise<PaymentsFact> {
  const out: PaymentsFact = { checked: [], paid: [], unread: [], remainingEstimate: 0 };
  const cycleS = GOV_CHAIN_PARAMS[network].superblockCycle * EST_BLOCK_SECONDS;
  for (const h of superblocksBetween(Math.max(from, a.chain.lo), a.tip, network)) {
    try {
      const { block } = await dapi.getAnchoredBlock(a, h);
      const time = block.header.time;
      // A superblock long after the window cannot pay it; one long before cannot either (Core's window is end/start +- 2 h around
      // its own estimate of the superblock time, which is within a cycle of the real one).
      if (time > p.endEpoch + FUDGE_S + cycleS) break;
      out.checked.push(h);
      const i = findPayment(block.txs[0]!.outputs, p.paymentAddress, BigInt(p.paymentAmount), network);
      if (i >= 0) out.paid.push({ height: h, output: i, time });
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
