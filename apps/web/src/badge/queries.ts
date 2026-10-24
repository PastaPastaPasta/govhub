// The `badge` contract queries (packages/contracts-v1/README.md shapes B1-B4), each run through the PV13 lint, and one proved
// query helper that also returns Platform's core chain-locked height (the clock every badge rule uses).
import badgeSchemas from '@govhub/contracts-v1/badge.json';
import { assertQuery, type ContractSchemas, type DocQuery } from '@govhub/contracts-v1/queryLint';
import type { Registry } from '../config/registry.ts';
import { getSdk } from '../data/platform.ts';

export const BADGE_SCHEMAS = badgeSchemas as unknown as ContractSchemas;

const checked = (q: DocQuery): DocQuery => {
  assertQuery(BADGE_SCHEMAS, q);
  return q;
};

/** B1: the issuerKey of issuer I for epoch E. */
export const issuerKeyQuery = (issuerId: string, epoch: number): DocQuery =>
  checked({ documentTypeName: 'issuerKey', where: [['$ownerId', '==', issuerId], ['epoch', '==', epoch]] });
/** B2: the issuer's revocation for epoch E. */
export const revocationQuery = (issuerId: string, epoch: number): DocQuery =>
  checked({ documentTypeName: 'issuerRevocation', where: [['$ownerId', '==', issuerId], ['epoch', '==', epoch]] });
/** B3: the issuer's self-reported token count for epoch E. */
export const reportQuery = (issuerId: string, epoch: number): DocQuery =>
  checked({ documentTypeName: 'issuerReport', where: [['$ownerId', '==', issuerId], ['epoch', '==', epoch]] });
/** B4: which of these authors (<= 100) hold a badge from issuer I in epoch E. */
export const badgesOfAuthors = (issuerId: string, epoch: number, authors: string[]): DocQuery =>
  checked({ documentTypeName: 'mnBadge', where: [['issuerId', '==', issuerId], ['epoch', '==', epoch], ['$ownerId', 'in', authors]], orderBy: [['$ownerId', 'asc']], limit: 100 });
/** B4c: every holder of issuer I in epoch E, paged (the reader's audit against issuerReport). */
export const allBadges = (issuerId: string, epoch: number, startAfter?: string): DocQuery =>
  checked({ documentTypeName: 'mnBadge', where: [['issuerId', '==', issuerId], ['epoch', '==', epoch]], orderBy: [['$ownerId', 'asc']], limit: 100, ...(startAfter ? { startAfter } : {}) });

export interface BadgeQueryResult {
  docs: Record<string, unknown>[];
  /** Platform's core chain-locked height from the proved response metadata */
  coreHeight: number;
}

export async function badgeQuery(r: Registry, contractId: string, q: DocQuery): Promise<BadgeQueryResult> {
  assertQuery(BADGE_SCHEMAS, q);
  const sdk = await getSdk(r);
  const res = await sdk.documents.queryWithProof({
    dataContractId: contractId,
    documentTypeName: q.documentTypeName,
    where: q.where as unknown[],
    ...(q.orderBy ? { orderBy: q.orderBy as unknown[] } : {}),
    ...(q.limit ? { limit: q.limit } : {}),
    ...(q.startAfter ? { startAfter: q.startAfter } : {}),
  } as never);
  const docs = [...res.data.values()].filter((d): d is NonNullable<typeof d> => !!d).map((d) => d.toJSON() as Record<string, unknown>);
  const coreHeight = Number((res as unknown as { metadata?: { coreChainLockedHeight?: unknown } }).metadata?.coreChainLockedHeight);
  if (!Number.isSafeInteger(coreHeight) || coreHeight <= 0) throw new Error('proved response without a core height');
  return { docs, coreHeight };
}
