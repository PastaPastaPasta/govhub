// What @govhub/auth needs from Dash Platform. The package never imports evo-sdk itself (an 8.7 MB chunk); the app passes an
// implementation, normally `createEvoPlatform` from '@govhub/auth/evo'. Every read is expected to be proof-verified.
import type { IdentityKeyInfo, Network } from './keys.ts';
import type { KeySpec } from './layout.ts';

export interface SigningKey extends KeySpec {
  privateKey: Uint8Array;
}

export type AssetLockStatus = 'unused' | 'used' | 'partial';

export type AssetLockProofInput =
  | { kind: 'instant'; tx: Uint8Array; isLock: Uint8Array; creditIndex: number }
  | { kind: 'chain'; txid: string; creditIndex: number; coreChainLockedHeight: number };

/** A document field value: byte arrays and identifiers as bytes, integers as numbers (sent as bigint), strings, booleans. */
export type DocValue = Uint8Array | number | string | boolean;

/**
 * One document write. Structurally the same as @govhub/forum's `DocumentOp`, so forum writes pass straight through; `revision` on
 * replace is the stored revision (the writer sends revision + 1). This is the single document writer of the app (evo.ts).
 */
export type DocumentWrite =
  | { action: 'create'; contractId: string; type: string; data: Record<string, DocValue> }
  | { action: 'replace'; contractId: string; type: string; id: string; revision: number; data: Record<string, DocValue> }
  | { action: 'delete'; contractId: string; type: string; id: string };

export interface DocumentWritten {
  /** base58 id (derived for creates) */
  id: string;
  /** revision after the write (1 for creates) */
  revision?: number;
}

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
  /**
   * What Platform's state says about an asset lock's credit output (`txid` display order, `creditIndex` into the payload's credit
   * outputs: the outpoint every asset-lock proof names), proved from Drive's spent-asset-lock tree. 'unused': no entry (proved absent);
   * 'used': fully consumed; 'partial': Platform keeps what is left of it (a refused transition paid its fee from the lock).
   */
  assetLockStatus(txid: string, creditIndex: number): Promise<AssetLockStatus>;
  createIdentity(o: { proof: AssetLockProofInput; assetLockKey: Uint8Array; keys: readonly SigningKey[] }): Promise<void>;
  topUpIdentity(o: { identityId: string; proof: AssetLockProofInput; assetLockKey: Uint8Array }): Promise<void>;
  /** IdentityUpdate adding `keys`, signed by the MASTER key (each new key also signs its own registration). */
  addKeys(o: { identityId: string; master: SigningKey; keys: readonly SigningKey[] }): Promise<void>;
  /** Signs one document transition with `key` (an AUTHENTICATION key of `ownerId` the contract accepts) and broadcasts it. */
  writeDocument(o: { ownerId: string; key: SigningKey; op: DocumentWrite }): Promise<DocumentWritten>;
  vault: {
    list(contractId: string, ownerId: string): Promise<VaultEntryDoc[]>;
    byCredential(contractId: string, ownerId: string, credentialId: Uint8Array): Promise<VaultEntryDoc | null>;
    /** Creates the entry, or replaces the one with the same credential id. Signed with `key` (HIGH or CRITICAL). */
    put(o: { contractId: string; ownerId: string; key: SigningKey; entry: Omit<VaultEntryDoc, 'id' | 'ownerId' | 'revision'>; existing?: VaultEntryDoc | null }): Promise<void>;
    remove(o: { contractId: string; ownerId: string; key: SigningKey; entry: VaultEntryDoc }): Promise<void>;
  };
}
