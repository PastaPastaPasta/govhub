// The treasury's ledger: what each superblock paid, read from its coinbase in the verified chain, and which proposal each payment was.
//
// A superblock's coinbase holds the block reward and the treasury payments together. Since the masternode reward reallocation
// (MnRewardEra::EvoReward, Dash Core masternode/payments.cpp GetMasternodePayment and GetMasternodePayments) the masternode share is
// 3/4 of the block reward, paid as the Platform credit-pool output (OP_RETURN with a value) plus the payee outputs (owner, operator),
// and the miner keeps the rest: miner = blockReward - floor(3 * blockReward / 4), so the masternode outputs sum to between
// 3 * miner - 3 and 3 * miner duffs. Pools order the outputs differently, so the split is searched for, not read by position, and it
// must be the only one. Everything else is a treasury payment. When no unique split exists (older eras, unusual coinbases) the
// superblock's total is left unknown; payments to known proposals are still matched by address and exact amount.
import { encodeAddress, hexToBytes, superblockPaymentsLimit, type Network } from '@govhub/verify';
import type { CoreNetwork, Proposal } from '../data/types.ts';

/** A coinbase output as the worker passes it: script hex and value in duffs (decimal string). */
export interface CoinbaseOutput {
  script: string;
  value: string;
}

export interface TreasuryPayment {
  /** Output index in the coinbase. */
  index: number;
  script: string;
  /** The payee, when the script is a standard P2PKH or P2SH one. */
  address: string | null;
  amount: bigint;
}

/** A superblock as this browser read it from the verified chain. */
export interface SuperblockRead {
  height: number;
  blockHash: string;
  /** Block time (unix seconds). */
  time: number;
  outputs: CoinbaseOutput[];
  /** Why the chain it was read from is not secure (testnet's proof of work), or null. */
  weak: string | null;
}

const isNullData = (script: string) => script.startsWith('6a');

/** P2PKH `76a914<20>88ac` or P2SH `a914<20>87` as an address of `network`; null for anything else. */
export function scriptAddress(script: string, network: Network): string | null {
  const s = script.toLowerCase();
  if (/^76a914[0-9a-f]{40}88ac$/.test(s)) return encodeAddress('p2pkh', hexToBytes(s.slice(6, 46)), network);
  if (/^a914[0-9a-f]{40}87$/.test(s)) return encodeAddress('p2sh', hexToBytes(s.slice(4, 44)), network);
  return null;
}

/** Owner and operator payouts (a shared masternode can split the owner's further): at most this many payee outputs. */
const MAX_PAYEES = 4;

/** Subsets of `items` of size 1..max, as index lists. */
function* subsets(items: number[], max: number, start = 0, picked: number[] = []): Generator<number[]> {
  for (let i = start; i < items.length; i++) {
    const next = [...picked, items[i]!];
    yield next;
    if (next.length < max) yield* subsets(items, max, i + 1, next);
  }
}

/**
 * The treasury payments of a superblock's coinbase (see the header), or null when the block reward can't be told apart from them.
 * Superblock payments are never zero-value or null-data outputs.
 */
export function treasuryPayments(outputs: readonly CoinbaseOutput[], network: Network): TreasuryPayment[] | null {
  const values = outputs.map((o) => BigInt(o.value));
  const pools = outputs.map((o, i) => (isNullData(o.script) && values[i]! > 0n ? i : -1)).filter((i) => i >= 0);
  if (pools.length !== 1) return null;
  const pool = pools[0]!;
  const solutions = new Set<string>();
  for (let miner = 0; miner < outputs.length; miner++) {
    if (miner === pool || isNullData(outputs[miner]!.script)) continue;
    const m = values[miner]!;
    const hi = 3n * m, lo = hi - 3n;
    const need = hi - values[pool]!;
    // payee candidates: smaller than what is left of the masternode share
    const cands = outputs.map((_, i) => i).filter((i) => i !== miner && i !== pool && !isNullData(outputs[i]!.script) && values[i]! > 0n && values[i]! <= need);
    for (const set of subsets(cands, MAX_PAYEES)) {
      const sum = set.reduce((a, i) => a + values[i]!, values[pool]!);
      if (sum >= lo && sum <= hi) solutions.add([miner, pool, ...set].sort((a, b) => a - b).join(','));
    }
  }
  // no split, or two that leave different payments: no way to know which outputs are the treasury's
  if (solutions.size !== 1) return null;
  const reward = new Set([...solutions][0]!.split(',').map(Number));
  const indices = outputs.map((_, i) => i).filter((i) => !reward.has(i));
  if (!indices.length || indices.some((i) => values[i]! <= 0n || isNullData(outputs[i]!.script))) return null;
  return indices.map((i) => ({ index: i, script: outputs[i]!.script.toLowerCase(), address: scriptAddress(outputs[i]!.script, network), amount: values[i]! }));
}

// ---- proposals ---------------------------------------------------------------------------------------------------------------

/** Core pays in [start - 2 h, end + 2 h] (governance/signing.cpp:86-99) by its time estimate; a day of slack covers the real block time. */
const SLACK_S = 2 * 3600 + 86_400;
type Payee = Pick<Proposal, 'govHash' | 'name' | 'paymentAddress' | 'paymentAmount' | 'startEpoch' | 'endEpoch'>;
const inWindow = (p: Payee, t: number) => t >= p.startEpoch - SLACK_S && t <= p.endEpoch + SLACK_S;

export interface LedgerLine {
  payment: TreasuryPayment;
  /** The proposal this payment was (same address, exact amount, the superblock inside its window), when exactly one is known. */
  proposal: Payee | null;
  /** Known proposals that could each account for it (twins); empty unless ambiguous. */
  candidates: Payee[];
  /** A known proposal paying the same address, when this payment matches none: the same payee, another proposal. */
  samePayee: Payee | null;
}

export interface LedgerEntry {
  read: SuperblockRead;
  /** Null when the coinbase's treasury payments can't be told apart from the block reward (see treasuryPayments). */
  lines: LedgerLine[] | null;
  /** Sum of the treasury payments, when known. */
  total: bigint | null;
  /** What the superblock could pay at most (consensus). */
  limit: bigint;
}

export function ledgerEntry(read: SuperblockRead, known: readonly Payee[], network: CoreNetwork): LedgerEntry {
  const payments = treasuryPayments(read.outputs, network);
  const limit = superblockPaymentsLimit(read.height, network);
  if (!payments) return { read, lines: null, total: null, limit };
  const lines = payments.map((payment): LedgerLine => {
    const match = known.filter((p) => p.paymentAddress === payment.address && BigInt(p.paymentAmount) === payment.amount && inWindow(p, read.time));
    const samePayee = match.length ? null : (known.filter((p) => p.paymentAddress === payment.address).sort((a, b) => b.endEpoch - a.endEpoch)[0] ?? null);
    return { payment, proposal: match.length === 1 ? match[0]! : null, candidates: match.length > 1 ? match : [], samePayee };
  });
  // the treasury's own order is by votes; a reader scans the largest first
  lines.sort((a, b) => (b.payment.amount > a.payment.amount ? 1 : b.payment.amount < a.payment.amount ? -1 : a.payment.index - b.payment.index));
  return { read, lines, total: payments.reduce((a, p) => a + p.amount, 0n), limit };
}

export type OutcomeKind = 'funded' | 'partly' | 'not-funded' | 'no-payout' | 'unknown';

export interface Outcome {
  kind: OutcomeKind;
  /** Superblocks read inside its window, and those that paid it. */
  of: number;
  paid: number;
  /** What it received in those (duffs). */
  total: bigint;
  /** Some of its window lies outside the superblocks read (older, or not read): the counts are a lower bound. */
  partial: boolean;
}

/**
 * How an ended proposal turned out, from the superblocks read: paid in every superblock of its window (funded), in some (partly), in
 * none (not funded), or its window held no superblock at all (no payout date). `oldest`: the time of the oldest superblock read;
 * `unread`: estimated times of superblocks that could not be read.
 */
export function outcomeOf(p: Payee, reads: readonly SuperblockRead[], network: CoreNetwork, cover: { oldest: number | null; unread: readonly number[] }): Outcome {
  const inside = reads.filter((r) => inWindow(p, r.time));
  let paid = 0;
  let total = 0n;
  for (const r of inside) {
    const hit = r.outputs.find((o) => scriptAddress(o.script, network) === p.paymentAddress && BigInt(o.value) === BigInt(p.paymentAmount));
    if (hit) {
      paid++;
      total += BigInt(hit.value);
    }
  }
  const partial = cover.oldest === null || p.startEpoch - SLACK_S < cover.oldest || cover.unread.some((t) => inWindow(p, t));
  if (cover.oldest === null) return { kind: 'unknown', of: 0, paid: 0, total: 0n, partial: true };
  // `partial` qualifies the counts (shown with them); the kind says what the superblocks read show
  const kind: OutcomeKind = inside.length === 0 ? (partial ? 'unknown' : 'no-payout') : paid === 0 ? 'not-funded' : paid === inside.length ? 'funded' : 'partly';
  return { kind, of: inside.length, paid, total, partial };
}

/** The last `count` superblock heights at or below `lastHeight`, newest first. */
export function superblockHeights(lastHeight: number, cycle: number, count: number, lowest = 1): number[] {
  const out: number[] = [];
  for (let h = lastHeight; out.length < count && h >= lowest; h -= cycle) out.push(h);
  return out;
}
