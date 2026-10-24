// Proposal data helpers on top of @govhub/verify (Core-compatible JSON semantics).
import { hexToBytes, lookup, parseCoreJson, parseProposalData, type ProposalFields } from '@govhub/verify';

export interface ProposalView extends ProposalFields {
  /** payment_amount in duffs as Core's ParsePaymentAmount reads it; null when Core would skip the payment. */
  paymentAmountDuffs: number | null;
}

/**
 * ParsePaymentAmount (governance/superblock.cpp:22-64) applied to the JSON lexeme of payment_amount
 * (signing.cpp:72 calls it on `getValStr()`, i.e. the lexeme): digits and one '.', no leading '.', <= 20 chars,
 * no exponent, at most 8 decimals (ParseFixedPoint), within MoneyRange.
 */
export function parsePaymentAmountDuffs(lexeme: string): number | null {
  if (lexeme.length === 0 || lexeme.length > 20) return null;
  if (!/^[0-9.]+$/.test(lexeme)) return null;
  if (lexeme.startsWith('.')) return null;
  const parts = lexeme.split('.');
  if (parts.length > 2) return null;
  const whole = parts[0]!;
  let frac = parts[1] ?? '';
  if (whole.length === 0) return null;
  // ParseFixedPoint tolerates trailing zeros beyond the 8th decimal, nothing else.
  if (frac.length > 8) {
    if (!/^0*$/.test(frac.slice(8))) return null;
    frac = frac.slice(0, 8);
  }
  if (lexeme.endsWith('.') && frac.length === 0) return null;
  const duffs = BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, '0') || '0');
  if (duffs > 2_100_000_000_000_000n) return null; // MAX_MONEY
  return Number(duffs);
}

/** Typed proposal fields for display, budget and publishing; null when Core's parser would not yield all fields. */
export function proposalView(dataHex: string): ProposalView | null {
  const parsed = parseProposalData(dataHex);
  if (!parsed.fields) return null;
  let paymentAmountDuffs: number | null = null;
  const root = parseCoreJson(hexToBytes(dataHex)).root;
  if (root && root.t === 'obj') {
    const v = lookup(root, 'payment_amount');
    if (v && v.t === 'num') paymentAmountDuffs = parsePaymentAmountDuffs(v.s);
  }
  return { ...parsed.fields, paymentAmountDuffs };
}

export interface TriggerPayment {
  address: string;
  amountDuffs: number;
  proposalHash: string | null;
}

export interface TriggerView {
  eventBlockHeight: number;
  payments: TriggerPayment[];
}

/** Superblock trigger data: {"event_block_height", "payment_addresses": "a|b", "payment_amounts": "1.0|2.0", "proposal_hashes": "h|h"}. */
export function triggerView(dataHex: string): TriggerView | null {
  try {
    const j = JSON.parse(new TextDecoder().decode(hexToBytes(dataHex))) as Record<string, unknown>;
    const height = Number(j.event_block_height);
    if (!Number.isInteger(height)) return null;
    const addrs = String(j.payment_addresses ?? '').split('|').filter(Boolean);
    const amts = String(j.payment_amounts ?? '').split('|').filter(Boolean);
    const hashes = String(j.proposal_hashes ?? '').split('|');
    if (addrs.length !== amts.length) return null;
    const payments = addrs.map((address, i) => ({ address, amountDuffs: parsePaymentAmountDuffs(amts[i]!) ?? 0, proposalHash: hashes[i] || null }));
    return { eventBlockHeight: height, payments };
  } catch {
    return null;
  }
}
