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

/** Platform's floors (rs-platform-version dpp state transition versions v1..v4): duffs locked to start processing. */
export const MIN_CREATE_LOCK_DUFFS = 200_000;
export const MIN_TOPUP_LOCK_DUFFS = 50_000;
/** What we ask a depositor for: the lock floor plus the Core fee of the asset-lock tx. PLAN 4.4: top-ups need >= 51,000. */
export const MIN_CREATE_DEPOSIT_DUFFS = 201_000;
export const MIN_TOPUP_DEPOSIT_DUFFS = 51_000;
/** 1 DASH = 1e8 duffs = 1e11 credits. */
export const CREDITS_PER_DUFF = 1000n;
