// The identity key layout (PLAN 4.1, DashPay iOS's layout, key id = key index):
//   created with the identity: 0 AUTH/MASTER, 1 AUTH/CRITICAL, 2 AUTH/HIGH (signs govhub documents), all ECDSA_SECP256K1
//   added later on demand (IdentityUpdate signed by MASTER, same paths, id = index):
//     3 TRANSFER/CRITICAL, 4 ENCRYPTION/MEDIUM and 5 DECRYPTION/MEDIUM bound to DashPay `contactRequest`
// Phase 0 measured 0.00106 DASH for the 3-key identity vs 0.00182 for all six; adding 3..5 later costs 0.00074.
import { KeyPurpose, KeyType, SecurityLevel } from './keys.ts';

export interface KeySpec {
  id: number;
  purpose: number;
  securityLevel: number;
  type: number;
  /** Contract-bound key (`contractBounds: SingleContractDocumentType`). */
  bound?: { contractId: string; documentType: string };
}

/** DashPay's contract on mainnet and testnet (same id on both, from the system data contracts). */
export const DASHPAY_CONTRACT_ID = 'Bwr4WHCPz5rFVAD87RqTs3izo4zpzwsEdKPWUT1NS1C7';

const ecdsa = KeyType.ECDSA_SECP256K1;

export const CREATE_KEYS: readonly KeySpec[] = [
  { id: 0, purpose: KeyPurpose.AUTHENTICATION, securityLevel: SecurityLevel.MASTER, type: ecdsa },
  { id: 1, purpose: KeyPurpose.AUTHENTICATION, securityLevel: SecurityLevel.CRITICAL, type: ecdsa },
  { id: 2, purpose: KeyPurpose.AUTHENTICATION, securityLevel: SecurityLevel.HIGH, type: ecdsa },
];

export const LATER_KEYS: readonly KeySpec[] = [
  { id: 3, purpose: KeyPurpose.TRANSFER, securityLevel: SecurityLevel.CRITICAL, type: ecdsa },
  { id: 4, purpose: KeyPurpose.ENCRYPTION, securityLevel: SecurityLevel.MEDIUM, type: ecdsa, bound: { contractId: DASHPAY_CONTRACT_ID, documentType: 'contactRequest' } },
  { id: 5, purpose: KeyPurpose.DECRYPTION, securityLevel: SecurityLevel.MEDIUM, type: ecdsa, bound: { contractId: DASHPAY_CONTRACT_ID, documentType: 'contactRequest' } },
];

export const MASTER_KEY_ID = 0;
export const HIGH_KEY_ID = 2;

/** 1 DASH = 1e8 duffs = 1e11 credits. */
export const CREDITS_PER_DUFF = 1000n;

/**
 * What Platform needs in an asset lock before it starts processing an identity create or top-up, per protocol version. From
 * rs-platform-version: `dpp.state_transitions.identities.asset_locks.required_asset_lock_duff_balance_for_processing_start_for_*`
 * (STATE_TRANSITION_VERSIONS_V3 in PV13, V4 in PV14) and `fee_version.state_transition_min_fees` (STATE_TRANSITION_MIN_FEES_VERSION1
 * in FEE_VERSION2 / FEE_VERSION3), applied by rs-dpp's `calculate_min_required_fee_v1` (used from PV13 on):
 *   create = identity_create_base_cost + lock duffs × 1000 + keys × identity_key_in_creation_cost
 *   top-up = identity_topup_base_cost + lock duffs × 1000
 * PV13 is Platform v4.1.1, PV14 v5.0.0-rc.8. Below it Platform refuses with "needs N credits to start processing" (consensus 10530).
 */
const ASSET_LOCK_RULES = {
  13: { createLockDuffs: 200_000n, topUpLockDuffs: 50_000n, createBaseCost: 2_000_000n, keyInCreationCost: 6_500_000n, topUpBaseCost: 500_000n },
  14: { createLockDuffs: 200_000n, topUpLockDuffs: 50_000n, createBaseCost: 2_000_000n, keyInCreationCost: 6_500_000n, topUpBaseCost: 500_000n },
} as const;
const RULES = Object.values(ASSET_LOCK_RULES);
const max = (l: bigint[]) => l.reduce((a, b) => (b > a ? b : a));

/** Credits an identity create with `keys` public keys needs in its asset lock (the highest of the supported protocol versions). */
export const createRequiredCredits = (keys: number): bigint =>
  max(RULES.map((r) => r.createBaseCost + r.createLockDuffs * CREDITS_PER_DUFF + BigInt(keys) * r.keyInCreationCost));
/** Credits an identity top-up needs in its asset lock. */
export const topUpRequiredCredits = (): bigint => max(RULES.map((r) => r.topUpBaseCost + r.topUpLockDuffs * CREDITS_PER_DUFF));

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
/** Platform's floors in duffs locked (the hard minimum a lock is built with): 221,500 for the 3-key create, 50,500 for a top-up. */
export const MIN_CREATE_LOCK_DUFFS = Number(ceilDiv(createRequiredCredits(CREATE_KEYS.length), CREDITS_PER_DUFF));
export const MIN_TOPUP_LOCK_DUFFS = Number(ceilDiv(topUpRequiredCredits(), CREDITS_PER_DUFF));
/**
 * Asked of a depositor on top of the floor: the asset lock's Core fee (206 duffs for one payment, 148 more per extra payment) with room
 * for a dozen payments, and some slack should a later protocol version raise the floor a little.
 */
export const DEPOSIT_MARGIN_DUFFS = 2_000;
const roundUp = (n: number, step: number) => Math.ceil(n / step) * step;
/** What we ask a depositor for, rounded up to 0.00001 DASH: 0.00224 DASH to create, 0.00053 DASH to top up. */
export const MIN_CREATE_DEPOSIT_DUFFS = roundUp(MIN_CREATE_LOCK_DUFFS + DEPOSIT_MARGIN_DUFFS, 1000);
export const MIN_TOPUP_DEPOSIT_DUFFS = roundUp(MIN_TOPUP_LOCK_DUFFS + DEPOSIT_MARGIN_DUFFS, 1000);
