// Every Platform query the app sends, as builders named after the shape IDs in
// packages/contracts-v1/README.md. queries.test.ts runs each through the PV13 linter.
import { TALLY_SET_MAX_PAGES } from '@govhub/verify';
import govSchemas from '@govhub/contracts-v1/gov.json';
import { hexToB64 } from '../lib/bytes.ts';
import { assertQuery, type ContractSchemas, type DocQuery } from '@govhub/contracts-v1/queryLint';

export const GOV_SCHEMAS = govSchemas as unknown as ContractSchemas;
export const PAGE = 100;

const checked = (q: DocQuery): DocQuery => {
  assertQuery(GOV_SCHEMAS, q);
  return q;
};
const paged = (q: DocQuery, startAfter?: string): DocQuery => (startAfter ? { ...q, startAfter } : q);

/** G1: one proposal by its (display-order) gov hash. */
export const proposalByHash = (govHashHex: string): DocQuery =>
  checked({ documentTypeName: 'proposal', where: [['govHash', '==', hexToB64(govHashHex)]] });

/** G2: proposals whose end is still ahead, soonest end first. */
export const activeProposals = (nowS: number, startAfter?: string): DocQuery =>
  checked(paged({ documentTypeName: 'proposal', where: [['endEpoch', '>', nowS]], orderBy: [['endEpoch', 'asc']], limit: PAGE }, startAfter));

/** G3: ended proposals, newest end first (the range on endEpoch is what makes desc work on PV13, rule 7). */
export const pastProposals = (nowS: number, startAfter?: string, limit = PAGE): DocQuery =>
  checked(paged({ documentTypeName: 'proposal', where: [['endEpoch', '<=', nowS]], orderBy: [['endEpoch', 'desc']], limit }, startAfter));

/** G4: proposals by name (slug lookup), oldest first. */
export const proposalsByName = (name: string): DocQuery =>
  checked({ documentTypeName: 'proposal', where: [['name', '==', name]], orderBy: [['name', 'asc'], ['$createdAt', 'asc']], limit: PAGE });

/** G5: tallies of up to 100 proposals. */
export const talliesFor = (govHashesHex: readonly string[]): DocQuery =>
  checked({
    documentTypeName: 'tally',
    where: [['govHash', 'in', [...new Set(govHashesHex.map((h) => h.toLowerCase()))].map(hexToB64)]],
    orderBy: [['govHash', 'asc']],
    limit: PAGE,
  });

/** G5b: one tally. */
export const tallyByHash = (govHashHex: string): DocQuery =>
  checked({ documentTypeName: 'tally', where: [['govHash', '==', hexToB64(govHashHex)]] });

/** G8: every page of the packed tally set, page 0 first (161 proposals a page; the bridge writes at most TALLY_SET_MAX_PAGES). */
export const tallySetPages = (): DocQuery =>
  checked({ documentTypeName: 'talliesSet', where: [['page', '>=', 0]], orderBy: [['page', 'asc']], limit: TALLY_SET_MAX_PAGES });

/** G8b: one page of the packed tally set (the bridge's lookup). */
export const tallySetPage = (page: number): DocQuery => checked({ documentTypeName: 'talliesSet', where: [['page', '==', page]] });

/** G6: latest cycles, highest superblock first. */
export const latestCycles = (limit = 3): DocQuery =>
  checked({ documentTypeName: 'cycle', where: [['superblockHeight', '>', 0]], orderBy: [['superblockHeight', 'desc']], limit });
