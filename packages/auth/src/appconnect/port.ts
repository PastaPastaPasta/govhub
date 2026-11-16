// What App Connect reads from Platform. Every read is proved; `createEvoAppConnectPort` (evo.ts) is the evo-sdk implementation.

export const APP_CONNECT_CONTRACT_ID = 'H8F9mP1BM55TE1ShsxPZHzhyinaMdY9bMmP85mkDhcJJ';
export const RESPONSE_TYPE = 'loginKeyResponse';

/** `contractBounds` of an identity key, ids base58. */
export type Bounds =
  | { kind: 'singleContract'; contractId: string }
  | { kind: 'documentType'; contractId: string; documentTypeName: string }
  | { kind: 'contractGroup'; groupId: string };

/** An identity key as the verifier reads it. */
export interface ChainKey {
  id: number;
  type: number;
  purpose: number;
  securityLevel: number;
  /** 33-byte point (ECDSA_SECP256K1) or 20-byte hash160 (ECDSA_HASH160). */
  data: Uint8Array;
  disabled: boolean;
  /** Absent: unbound. 'unreadable': bounds of a kind this code does not know, never treated as unbound. */
  bounds?: Bounds | 'unreadable';
  totalBudget?: bigint;
  /** Block time (ms) from which the key can no longer sign. */
  expiresAt?: number;
}

/** One `loginKeyResponse` entry. */
export interface Candidate {
  ownerId: string;
  walletEphemeralPubKey: Uint8Array;
  encryptedPayload: Uint8Array;
}

export interface AppConnectPort {
  /** Up to `limit` responses to `requestHash`, `$ownerId` ascending, after `startAfter`, only `hint`'s when given. */
  responses(requestHash: Uint8Array, o: { hint?: string; startAfter?: string; limit: number }): Promise<Candidate[]>;
  /** The identity's keys and the block time of the proof they came with, or null when it does not exist. Never cached. */
  identityKeys(identityId: string): Promise<{ keys: ChainKey[]; blockTimeMs: number } | null>;
  /** Credits left per key id; absent for a key Platform reports no budget for. */
  remainingBudgets(identityId: string, keyIds: number[]): Promise<Map<number, bigint>>;
  /** The keys Platform resolves as current for `contractId` and `purpose`. */
  contractKeys(identityId: string, contractId: string, purpose: number): Promise<ChainKey[]>;
}
