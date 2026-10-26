// Every forum / mod / claimAttestation query, as builders named after the shape IDs in
// packages/contracts-v1/README.md. Each one is run through the PV13 lint when it is built, so a shape that PV13
// would silently answer with [] can never reach the network. queries.test.ts asserts the chosen index per shape.
import forumJson from '@govhub/contracts-v1/forum.json';
import govJson from '@govhub/contracts-v1/gov.json';
import modJson from '@govhub/contracts-v1/mod.json';
import { assertQuery, type ContractSchemas, type DocQuery } from '@govhub/contracts-v1/queryLint';
import { hexToB64, idToB64 } from './encoding.ts';
import type { ContractKey } from './types.ts';

export const SCHEMAS: Record<ContractKey, ContractSchemas> = {
  forum: forumJson as unknown as ContractSchemas,
  mod: modJson as unknown as ContractSchemas,
  gov: govJson as unknown as ContractSchemas,
};

/** Drive's page size (rule 5): the default and the maximum `limit`, and the largest `in` list. */
export const PAGE = 100;

/** A query plus the contract it runs against. */
export interface ContractQuery {
  contract: ContractKey;
  q: DocQuery;
}

const checked = (contract: ContractKey, q: DocQuery): ContractQuery => {
  assertQuery(SCHEMAS[contract], q);
  return { contract, q };
};
const paged = (q: DocQuery, startAfter?: string): DocQuery => (startAfter ? { ...q, startAfter } : q);
const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const batchOf = (xs: readonly string[]): string[] => {
  const u = uniq(xs);
  if (u.length === 0 || u.length > PAGE) throw new Error(`in-list needs 1..${PAGE} distinct values, got ${u.length}`);
  return u;
};

// ---- profile ----------------------------------------------------------------------------------
/** F1: one identity's profile. */
export const profileOf = (ownerId: string): ContractQuery => checked('forum', { documentTypeName: 'profile', where: [['$ownerId', '==', ownerId]] });

/** F1b: profiles of up to 100 identities. */
export const profilesOf = (ownerIds: readonly string[]): ContractQuery =>
  checked('forum', { documentTypeName: 'profile', where: [['$ownerId', 'in', batchOf(ownerIds)]], orderBy: [['$ownerId', 'asc']], limit: PAGE });

// ---- comment ----------------------------------------------------------------------------------
/** F2 (+F3p paging): a proposal's comments, oldest first. */
export const commentsOf = (govHash: string, startAfter?: string): ContractQuery =>
  checked('forum', paged({ documentTypeName: 'comment', where: [['govHash', '==', hexToB64(govHash)]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']], limit: PAGE }, startAfter));

/**
 * F2c: a proposal's comments, newest first. The `$createdAt` range makes desc work on PV13 (rule 7); later pages bound it with
 * `<= atOrBeforeMs` (the last page's oldest time) instead of `startAfter`, which rc.8 cannot verify on a desc proof (R8). The
 * caller skips the ids it already has at that time (pageDesc in reader.ts).
 */
export const commentsNewestOf = (govHash: string, atOrBeforeMs?: number): ContractQuery =>
  checked('forum', {
    documentTypeName: 'comment',
    where: [['govHash', '==', hexToB64(govHash)], atOrBeforeMs === undefined ? ['$createdAt', '>', 0] : ['$createdAt', '<=', atOrBeforeMs]],
    orderBy: [['govHash', 'desc'], ['$createdAt', 'desc']],
    limit: PAGE,
  });

/**
 * F2d: a proposal's comments created at or after `sinceMs` (block time), oldest first. `>=`, not `>`: several comments can share
 * one block time, so the caller passes the newest time it has and skips the ids it already holds.
 */
export const commentsSince = (govHash: string, sinceMs: number, startAfter?: string): ContractQuery =>
  checked(
    'forum',
    paged({ documentTypeName: 'comment', where: [['govHash', '==', hexToB64(govHash)], ['$createdAt', '>=', sinceMs]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']], limit: PAGE }, startAfter),
  );

/** F3: an author's comments, newest first; paged like F2c with `<= atOrBeforeMs` (rules 7 and R8). */
export const commentsBy = (ownerId: string, atOrBeforeMs?: number): ContractQuery =>
  checked('forum', {
    documentTypeName: 'comment',
    where: [['$ownerId', '==', ownerId], atOrBeforeMs === undefined ? ['$createdAt', '>', 0] : ['$createdAt', '<=', atOrBeforeMs]],
    orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']],
    limit: PAGE,
  });

// ---- reaction ---------------------------------------------------------------------------------
/** A reaction target as base64: a comment id (base58). */
export const targetB64 = (t: { commentId: string }): string => idToB64(t.commentId);

/** F6: every reaction on one target, oldest first; the orderBy pins `byTarget` (rule 1's ambiguity trap). */
export const reactionsOn = (target: string, startAfter?: string): ContractQuery =>
  checked('forum', paged({ documentTypeName: 'reaction', where: [['target', '==', target]], orderBy: [['target', 'asc'], ['$createdAt', 'asc']], limit: PAGE }, startAfter));

/** F5: my reaction on one target. */
export const myReactionOn = (ownerId: string, target: string): ContractQuery =>
  checked('forum', { documentTypeName: 'reaction', where: [['$ownerId', '==', ownerId], ['target', '==', target]] });

/** F5b: my reactions on up to 100 targets. */
export const myReactionsOn = (ownerId: string, targets: readonly string[]): ContractQuery =>
  checked('forum', { documentTypeName: 'reaction', where: [['$ownerId', '==', ownerId], ['target', 'in', batchOf(targets)]], orderBy: [['$ownerId', 'asc'], ['target', 'asc']], limit: PAGE });

// ---- claim / attestation / post ---------------------------------------------------------------
/** F7: claims on a proposal, oldest first. */
export const claimsOf = (govHash: string, startAfter?: string): ContractQuery =>
  checked('forum', paged({ documentTypeName: 'claim', where: [['govHash', '==', hexToB64(govHash)]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']], limit: PAGE }, startAfter));

/** G7: the hosting team's claim attestations for a proposal (gov contract). */
export const attestationsOf = (govHash: string, startAfter?: string): ContractQuery =>
  checked('gov', paged({ documentTypeName: 'claimAttestation', where: [['govHash', '==', hexToB64(govHash)]], orderBy: [['govHash', 'asc']], limit: PAGE }, startAfter));

/** F8: the post one identity wrote for a proposal (the reader asks for the verified owner's). */
export const postOf = (govHash: string, ownerId: string): ContractQuery =>
  checked('forum', { documentTypeName: 'proposalPost', where: [['govHash', '==', hexToB64(govHash)], ['$ownerId', '==', ownerId]] });

// ---- moderation -------------------------------------------------------------------------------
/** F10 / M1: one list's blocks, paged in target order. `mod` is the default list, `forum` anyone's own list. */
export const blocksOf = (contract: 'forum' | 'mod', ownerId: string, startAfter?: string): ContractQuery =>
  checked(contract, paged({ documentTypeName: 'block', where: [['$ownerId', '==', ownerId]], orderBy: [['$ownerId', 'asc'], ['target', 'asc']], limit: PAGE }, startAfter));

/** F10b / M1c: which of these (≤ 100) targets list L blocks. */
export const blocksAmong = (contract: 'forum' | 'mod', ownerId: string, targets: readonly string[]): ContractQuery =>
  checked(contract, { documentTypeName: 'block', where: [['$ownerId', '==', ownerId], ['target', 'in', batchOf(targets)]], orderBy: [['$ownerId', 'asc'], ['target', 'asc']], limit: PAGE });

/** M1b: default-list entries added after `sinceMs`. Removals are invisible here; re-run M1 on a schedule. */
export const modBlocksSince = (ownerId: string, sinceMs: number, startAfter?: string): ContractQuery =>
  checked('mod', paged({ documentTypeName: 'block', where: [['$ownerId', '==', ownerId], ['$createdAt', '>', sinceMs]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']], limit: PAGE }, startAfter));

/** F11: my list subscriptions. */
export const blockSubsOf = (ownerId: string): ContractQuery => checked('forum', { documentTypeName: 'blockSubs', where: [['$ownerId', '==', ownerId]] });
