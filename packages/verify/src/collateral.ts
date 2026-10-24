// Proposal collateral check. Source: CGovernanceObject::IsCollateralValid, src/governance/object.cpp:790-880
// (expected script L824-825, per-output test L834-843, confirmations L863; GOVERNANCE_PROPOSAL_FEE_TX = 1 DASH and
// GOVERNANCE_FEE_CONFIRMATIONS = 6 in governance/object.h:87-88; IsUnspendable script/script.h:534, IsPayToPublicKeyHash script/script.cpp:202).
//
// This function checks only what is decidable from the transaction bytes. The caller must still establish
// (a) that the tx is in a block with >= 6 confirmations / a ChainLock (Core: `nConfirmationsIn < GOVERNANCE_FEE_CONFIRMATIONS`)
// and (b) that the raw bytes really are the tx with the expected txid (pass `expectedTxid`).
import { bytesEqual, bytesToHex, concatBytes, uint256ToDisplay } from './bytes.ts';
import { parseTransaction, type DashTx } from './tx.ts';

/** GOVERNANCE_PROPOSAL_FEE_TX: 1 DASH in duffs. */
export const GOVERNANCE_PROPOSAL_FEE_DUFFS = 100_000_000n;
/** GOVERNANCE_FEE_CONFIRMATIONS (documented here, enforced by the caller). */
export const GOVERNANCE_FEE_CONFIRMATIONS = 6;
/** MAX_SCRIPT_SIZE: scripts above this are "unspendable" (script.h IsUnspendable). */
const MAX_SCRIPT_SIZE = 10_000;

const OP_RETURN = 0x6a;

/** The exact script Core searches for: `CScript() << OP_RETURN << ToByteVector(hash)` = 6a 20 <32 raw bytes>. */
export function collateralScript(govHashRaw: Uint8Array): Uint8Array {
  if (govHashRaw.length !== 32) throw new Error('govHashRaw must be 32 bytes');
  return concatBytes(Uint8Array.of(OP_RETURN, 0x20), govHashRaw);
}

/** CScript::IsPayToPublicKeyHash(): OP_DUP OP_HASH160 PUSH20 <20> OP_EQUALVERIFY OP_CHECKSIG. */
export function isP2PKH(s: Uint8Array): boolean {
  return s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac;
}

/** CScript::IsUnspendable(): starts with OP_RETURN, or is longer than MAX_SCRIPT_SIZE. */
export function isUnspendable(s: Uint8Array): boolean {
  return (s.length > 0 && s[0] === OP_RETURN) || s.length > MAX_SCRIPT_SIZE;
}

export type CollateralFailure =
  | 'tx-parse-error'
  | 'txid-mismatch'
  | 'no-outputs'
  | 'invalid-output-script' // some output is neither P2PKH nor unspendable
  | 'no-matching-op-return'; // no output is exactly OP_RETURN PUSH32(hash) with value >= 1 DASH

export interface CollateralResult {
  valid: boolean;
  /** Set when !valid. */
  failure?: CollateralFailure;
  message?: string;
  txid?: string;
  /** Index of the first output that satisfied the OP_RETURN rule (when valid). */
  opReturnIndex?: number;
  /** Index of the first offending output for 'invalid-output-script'. */
  badOutputIndex?: number;
  /** Set when an exact-script output exists but is underfunded: its value in duffs. */
  underfundedValue?: bigint;
  tx?: DashTx;
}

export interface CollateralOptions {
  /**
   * Display-order txid the caller believes this is (e.g. the proposal's CollateralHash). STRONGLY RECOMMENDED: without it
   * the function only proves that these bytes are *a* valid collateral for the hash, not that they are the mined transaction.
   * When provided it must match exactly (an empty string never matches).
   */
  expectedTxid?: string;
  /** Override the minimum burn (default 1 DASH). */
  minFeeDuffs?: bigint;
}

/**
 * IsCollateralValid minus the chain-state parts. Rules (all must hold):
 *  1. at least one output;
 *  2. EVERY output script is P2PKH or unspendable (OP_RETURN-prefixed or > 10,000 bytes). Any other output (P2SH, P2PK, ...)
 *     invalidates the whole transaction, even though the OP_RETURN is present;
 *  3. at least one output has script == 6a 20 <raw hash> exactly and value >= 1 DASH.
 * `govHashRaw` is the INTERNAL byte order hash, i.e. `governanceObjectHash(...).raw` (the reverse of what RPCs print).
 */
export function checkCollateralTx(rawTx: Uint8Array, govHashRaw: Uint8Array, opts: CollateralOptions = {}): CollateralResult {
  let tx: DashTx;
  try {
    tx = parseTransaction(rawTx);
  } catch (e) {
    return { valid: false, failure: 'tx-parse-error', message: (e as Error).message };
  }
  const base = { txid: tx.txid, tx };
  // Any supplied value (even "") must equal the txid: a falsy-but-present expectedTxid must never silently disable the binding.
  if (opts.expectedTxid !== undefined && opts.expectedTxid.toLowerCase() !== tx.txid) {
    return { valid: false, failure: 'txid-mismatch', message: `tx hashes to ${tx.txid}, expected ${JSON.stringify(opts.expectedTxid)}`, ...base };
  }
  if (tx.vout.length === 0) return { valid: false, failure: 'no-outputs', message: 'tx vout is empty', ...base };

  const want = collateralScript(govHashRaw);
  const minFee = opts.minFeeDuffs ?? GOVERNANCE_PROPOSAL_FEE_DUFFS;
  let found = -1;
  let underfunded: bigint | undefined;
  for (let i = 0; i < tx.vout.length; i++) {
    const o = tx.vout[i]!;
    if (!isP2PKH(o.script) && !isUnspendable(o.script)) {
      return { valid: false, failure: 'invalid-output-script', message: `output ${i} script ${bytesToHex(o.script)} is neither P2PKH nor unspendable`, badOutputIndex: i, ...base };
    }
    if (bytesEqual(o.script, want)) {
      if (o.value >= minFee) {
        if (found < 0) found = i;
      } else underfunded = o.value;
    }
  }
  if (found < 0) {
    return {
      valid: false,
      failure: 'no-matching-op-return',
      message: `no output pays >= ${minFee} duffs to OP_RETURN ${uint256ToDisplay(govHashRaw)} (raw ${bytesToHex(govHashRaw)})`,
      ...(underfunded !== undefined ? { underfundedValue: underfunded } : {}),
      ...base,
    };
  }
  return { valid: true, opReturnIndex: found, ...base };
}
