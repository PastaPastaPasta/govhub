// What @govhub/auth needs from Dash Platform. The package never imports evo-sdk itself (an 8.7 MB chunk); the app passes an
// implementation, normally `createEvoPlatform` from '@govhub/auth/evo'. Every read is expected to be proof-verified.
import type { IdentityKeyInfo, Network } from './keys.ts';
import type { KeySpec } from './layout.ts';

export interface SigningKey extends KeySpec {
  privateKey: Uint8Array;
}

export type AssetLockProofInput =
  | { kind: 'instant'; tx: Uint8Array; isLock: Uint8Array; creditIndex: number }
  | { kind: 'chain'; txid: string; creditIndex: number; coreChainLockedHeight: number };

export interface VaultEntryDoc {
  /** Document id (base58). */
  id: string;
  ownerId: string;
  revision: number;
  credentialId: Uint8Array;
  recipientKey: Uint8Array;
  version: number;
  authKeyId: number;
  enc: Uint8Array;
  sealed: Uint8Array;
  createdAt?: number;
  updatedAt?: number;
}

export interface PlatformPort {
  readonly network: Network;
  /** The identity whose UNIQUE key hashes to `hash160` (AUTH MASTER/CRITICAL/HIGH keys are unique), or null. */
  identityByUniqueKeyHash(hash160: Uint8Array): Promise<string | null>;
  /** Identities holding a non-unique key with this hash (MEDIUM keys, shared keys). */
  identitiesByNonUniqueKeyHash(hash160: Uint8Array): Promise<string[]>;
  /** The identity's keys, or null when it does not exist. */
  identityKeys(identityId: string): Promise<IdentityKeyInfo[] | null>;
  /** Credits, or null when the identity does not exist. */
  balance(identityId: string): Promise<bigint | null>;
  /** Platform's view of Core: the newest ChainLocked height Platform has seen (what a chain asset-lock proof may reference). */
  coreChainLockedHeight(): Promise<number>;
  createIdentity(o: { proof: AssetLockProofInput; assetLockKey: Uint8Array; keys: readonly SigningKey[] }): Promise<void>;
  topUpIdentity(o: { identityId: string; proof: AssetLockProofInput; assetLockKey: Uint8Array }): Promise<void>;
  /** IdentityUpdate adding `keys`, signed by the MASTER key (each new key also signs its own registration). */
  addKeys(o: { identityId: string; master: SigningKey; keys: readonly SigningKey[] }): Promise<void>;
  vault: {
    list(contractId: string, ownerId: string): Promise<VaultEntryDoc[]>;
    byCredential(contractId: string, ownerId: string, credentialId: Uint8Array): Promise<VaultEntryDoc | null>;
    /** Creates the entry, or replaces the one with the same credential id. Signed with `key` (HIGH or CRITICAL). */
    put(o: { contractId: string; ownerId: string; key: SigningKey; entry: Omit<VaultEntryDoc, 'id' | 'ownerId' | 'revision'>; existing?: VaultEntryDoc | null }): Promise<void>;
    remove(o: { contractId: string; ownerId: string; key: SigningKey; entry: VaultEntryDoc }): Promise<void>;
  };
}
