// Domain types for forum, mod and gov.claimAttestation documents. Hashes are lowercase hex in stored (display) order,
// identifiers base58, times milliseconds of Platform block time (Drive overwrites $createdAt on creation).

/** Contract ids the data layer reads and writes. */
export interface ForumContracts {
  forum: string;
  mod: string;
  gov: string;
}
export type ContractKey = keyof ForumContracts;

export const COMMENT_FMT = { plain: 0, markdown: 1 } as const;
export const REACTION_KIND = { comment: 1, proposal: 2 } as const;
export const BLOCK_KIND = { identity: 1, document: 2 } as const;
/** `claim.method` / `claimAttestation.method` / the claim verifier's ranks (PLAN §6.3; lower = stronger). */
export const CLAIM_METHOD = { url: 1, paymentAddress: 2, collateralInput: 3, attestation: 4 } as const;
export type ClaimMethod = (typeof CLAIM_METHOD)[keyof typeof CLAIM_METHOD];

/** Policy cap for `comment.body` in UTF-8 bytes (the field cap is 5,120 B; maxLength counts characters). */
export const COMMENT_MAX_BYTES = 5000;

export interface Comment {
  id: string;
  ownerId: string;
  govHash: string;
  parentId?: string;
  body: string;
  fmt: number;
  createdAt: number;
}

export interface Reaction {
  id: string;
  ownerId: string;
  /** hex of the 32 target bytes: a govHash, or a comment id's bytes */
  target: string;
  kind: number;
  value: 1 | -1;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface Profile {
  id: string;
  ownerId: string;
  revision: number;
  displayName: string;
  about?: string;
  avatarUrl?: string;
}

export interface Claim {
  id: string;
  ownerId: string;
  govHash: string;
  method: number;
  sig: Uint8Array;
  createdAt: number;
}

export interface ClaimAttestation {
  id: string;
  ownerId: string;
  govHash: string;
  identityId: string;
  method: number;
  note?: string;
}

export interface ProposalPost {
  id: string;
  ownerId: string;
  revision: number;
  govHash: string;
  title: string;
  /** b0..b2: the deflated markdown split into ≤ 5,120-byte chunks */
  chunks: Uint8Array[];
  links?: string;
}

export interface Block {
  id: string;
  ownerId: string;
  target: string;
  kind: number;
  reason?: string;
  createdAt?: number;
}

export interface BlockSubs {
  id: string;
  revision: number;
  /** list-owner identity ids */
  lists: string[];
  defaultOff: boolean;
}
