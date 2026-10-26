import { describe, expect, it } from 'vitest';
import forumSchemas from '@govhub/contracts-v1/forum.json';
import badgeSchemas from '@govhub/contracts-v1/badge.json';
import govTestnetSchemas from '@govhub/contracts-v1/gov-testnet.json';
import { activeProposals, GOV_SCHEMAS, latestCycles, pastProposals, proposalByHash, proposalsByName, talliesFor, tallyByHash, tallySetPage, tallySetPages } from './queries.ts';
import { lintQuery, type ContractSchemas, type DocQuery } from '@govhub/contracts-v1/queryLint';

const H = 'a5465cdb6caf234cc9b8b776b1e3b60f319367504527e80a669bf41811419901';
const H2 = 'f64341933c383620eb01d3eb8dccebf6400490a03b1cf0a7d2700747d8a4163b';
const B64 = 'ZFSRN5FFs1hwAgXik28A4GANN5FMwiMFpqJH5GQjtWA=';
const ID = '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv';
const FORUM = forumSchemas as unknown as ContractSchemas;
const BADGE = badgeSchemas as unknown as ContractSchemas;
const ok = (s: ContractSchemas, q: DocQuery) => {
  const r = lintQuery(s, q);
  expect(r.errors).toEqual([]);
  return r;
};
const bad = (s: ContractSchemas, q: DocQuery, rule: string) => {
  const r = lintQuery(s, q);
  expect(r.ok).toBe(false);
  expect(r.errors.join(' ')).toContain(rule);
};

describe('every query the app sends passes the PV13 lint', () => {
  it.each([
    ['G1', proposalByHash(H), 'byGovHash'],
    ['G2', activeProposals(1_792_807_235), 'byEndEpoch'],
    ['G2 paged', activeProposals(1_792_807_235, 'GiCkEzSnk6SCCbXgjCnPYtvviYiRS5Vnbu7AcpAMUPFE'), 'byEndEpoch'],
    ['G3', pastProposals(1_792_807_235), 'byEndEpoch'],
    ['G4', proposalsByName('Dash-Mass-Organic-Content-Attraction'), 'byNameCreated'],
    ['G5', talliesFor([H, H2, H.toUpperCase()]), 'byGovHash'],
    ['G5b', tallyByHash(H), 'byGovHash'],
    ['G6', latestCycles(), 'bySuperblock'],
    ['G8', tallySetPages(), 'byPage'],
    ['G8b', tallySetPage(0), 'byPage'],
  ])('%s', (_id, q, index) => {
    expect(ok(GOV_SCHEMAS, q).index).toBe(index);
    // the testnet contracts (old proposal shape + talliesSet) answer every gov query the app sends the same way
    expect(ok(govTestnetSchemas as unknown as ContractSchemas, q).index).toBe(index);
  });
  it('the slim mainnet proposal keeps every indexed field; the dropped ones are re-derived from dataHex', () => {
    const p = (GOV_SCHEMAS.proposal as unknown as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(p)).toEqual(['govHash', 'parentHash', 'revision', 'time', 'dataHex', 'name', 'endEpoch', 'collateralTxid', 'collateralHeight']);
  });
  it('G8 shapes that PV13 would answer wrongly are rejected', () => {
    // desc without a range on page (rule 7), an orderBy on a non-index property, more than 100
    bad(GOV_SCHEMAS, { documentTypeName: 'talliesSet', where: [['page', '==', 0]], orderBy: [['page', 'desc']] }, 'R7');
    bad(GOV_SCHEMAS, { documentTypeName: 'talliesSet', where: [['asOfHeight', '>', 0]], orderBy: [['asOfHeight', 'asc']] }, 'R1');
    bad(GOV_SCHEMAS, { documentTypeName: 'talliesSet', where: [['page', '>=', 0]], orderBy: [['page', 'asc']], limit: 101 }, 'R5');
  });
  it('G3 (past, newest first) carries a range on endEpoch so desc works on PV13, and pages by that bound, never startAfter (R8)', () => {
    const q = pastProposals(100);
    expect(q.orderBy).toEqual([['endEpoch', 'desc']]);
    expect(q.where[0]![1]).toBe('<=');
    expect(q.startAfter).toBeUndefined();
    bad(GOV_SCHEMAS, { ...q, startAfter: '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv' }, 'R8');
  });
  it('G5 dedupes hashes and sends base64', () => {
    const q = talliesFor([H, H.toUpperCase()]);
    expect((q.where[0]![2] as string[]).length).toBe(1);
    expect((q.where[0]![2] as string[])[0]).toMatch(/=$/);
  });
  it('builders refuse shapes the lint rejects (more than 100 hashes)', () => {
    expect(() => talliesFor(Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(64, '0')))).toThrow(/R5/);
  });
});

describe('README shapes that must pass', () => {
  it.each([
    ['G7', GOV_SCHEMAS, { documentTypeName: 'claimAttestation', where: [['govHash', '==', B64]], orderBy: [['govHash', 'asc']] }],
    ['F2', FORUM, { documentTypeName: 'comment', where: [['govHash', '==', B64]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']] }],
    ['F2c', FORUM, { documentTypeName: 'comment', where: [['govHash', '==', B64], ['$createdAt', '>', 0]], orderBy: [['govHash', 'desc'], ['$createdAt', 'desc']] }],
    ['F3', FORUM, { documentTypeName: 'comment', where: [['$ownerId', '==', ID], ['$createdAt', '>', 0]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']] }],
    ['F5', FORUM, { documentTypeName: 'reaction', where: [['$ownerId', '==', ID], ['target', '==', B64]] }],
    ['F5b', FORUM, { documentTypeName: 'reaction', where: [['$ownerId', '==', ID], ['target', 'in', [B64]]], orderBy: [['$ownerId', 'asc'], ['target', 'asc']] }],
    ['F6', FORUM, { documentTypeName: 'reaction', where: [['target', '==', B64]], orderBy: [['target', 'asc'], ['$createdAt', 'asc']] }],
    ['B1b', BADGE, { documentTypeName: 'issuerKey', where: [['$ownerId', '==', ID], ['epoch', '>=', 0]], orderBy: [['$ownerId', 'asc'], ['epoch', 'desc']] }],
    ['B4', BADGE, { documentTypeName: 'mnBadge', where: [['issuerId', '==', ID], ['epoch', '==', 300], ['$ownerId', 'in', [ID]]], orderBy: [['$ownerId', 'asc']] }],
    ['B4c', BADGE, { documentTypeName: 'mnBadge', where: [['issuerId', '==', ID], ['epoch', '==', 300]], orderBy: [['$ownerId', 'asc']] }],
    ['B4d', BADGE, { documentTypeName: 'mnBadge', where: [['issuerId', '==', ID], ['epoch', '>=', 300]], orderBy: [['epoch', 'asc']] }],
  ] as Array<[string, ContractSchemas, DocQuery]>)('%s', (_id, s, q) => {
    ok(s, q);
  });
});

describe('shapes PV13 silently answers with [] are rejected', () => {
  it('F6 without its orderBy (ambiguity trap, confirmed on mainnet)', () => {
    bad(FORUM, { documentTypeName: 'reaction', where: [['target', '==', B64]] }, 'R1b');
    bad(FORUM, { documentTypeName: 'reaction', where: [['target', '==', B64]], orderBy: [['target', 'asc']] }, 'R1b');
  });
  it('X1: gap inside an index', () => {
    bad(BADGE, { documentTypeName: 'mnBadge', where: [['issuerId', '==', ID], ['$ownerId', '==', ID]] }, 'R1');
  });
  it('X2: not an index prefix', () => {
    bad(BADGE, { documentTypeName: 'mnBadge', where: [['$ownerId', '==', ID]] }, 'R1');
  });
  it('X3: no index starts with $createdAt', () => {
    bad(FORUM, { documentTypeName: 'comment', where: [['$createdAt', '>', 0]], orderBy: [['$createdAt', 'asc']] }, 'R1');
  });
  it('desc without a range on the last ordered property (F2c as first written)', () => {
    bad(FORUM, { documentTypeName: 'comment', where: [['govHash', '==', B64]], orderBy: [['govHash', 'desc'], ['$createdAt', 'desc']] }, 'R7');
    bad(GOV_SCHEMAS, { documentTypeName: 'proposal', where: [['name', '==', 'x']], orderBy: [['name', 'asc'], ['$createdAt', 'desc']] }, 'R7');
  });
  it('in on a property that is not the last one of the index', () => {
    bad(FORUM, { documentTypeName: 'reaction', where: [['$ownerId', 'in', [ID]]], orderBy: [['$ownerId', 'asc'], ['target', 'asc']] }, 'R2');
  });
  it('range followed by another constraint', () => {
    bad(FORUM, { documentTypeName: 'comment', where: [['govHash', '>', B64], ['$createdAt', '>', 0]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']] }, 'R1');
  });
  it('orderBy continuing past the range property', () => {
    bad(GOV_SCHEMAS, { documentTypeName: 'proposal', where: [['name', '>', 'a']], orderBy: [['name', 'asc'], ['$createdAt', 'asc']] }, 'nothing after it');
  });
  it('startAfter must be a document id', () => {
    bad(GOV_SCHEMAS, { ...activeProposals(1), startAfter: 'not an id!' }, 'startAfter');
  });
  it('range without orderBy', () => {
    bad(GOV_SCHEMAS, { documentTypeName: 'proposal', where: [['endEpoch', '>', 1]] }, 'R3');
  });
  it('orderBy out of index order', () => {
    bad(FORUM, { documentTypeName: 'comment', where: [['govHash', '==', B64]], orderBy: [['$createdAt', 'asc'], ['govHash', 'asc']] }, 'R3');
  });
  it('X0 / encodings: Uint8Array, hex, and wrong length for byteArray; base64 for identifiers', () => {
    bad(GOV_SCHEMAS, { documentTypeName: 'proposal', where: [['govHash', '==', new Uint8Array(32)]] }, 'R6');
    bad(GOV_SCHEMAS, { documentTypeName: 'proposal', where: [['govHash', '==', H]] }, 'R6');
    bad(GOV_SCHEMAS, { documentTypeName: 'proposal', where: [['govHash', '==', 'AAAA']] }, 'R6');
    bad(FORUM, { documentTypeName: 'profile', where: [['$ownerId', '==', B64]] }, 'R6');
    bad(GOV_SCHEMAS, { documentTypeName: 'cycle', where: [['superblockHeight', '==', '5']] }, 'R6');
  });
  it('limits', () => {
    bad(GOV_SCHEMAS, { documentTypeName: 'cycle', where: [['superblockHeight', '>', 0]], orderBy: [['superblockHeight', 'asc']], limit: 101 }, 'R5');
    bad(GOV_SCHEMAS, { documentTypeName: 'tally', where: [['govHash', 'in', [B64, B64]]], orderBy: [['govHash', 'asc']] }, 'R5');
  });
  it('unknown fields and types', () => {
    bad(GOV_SCHEMAS, { documentTypeName: 'proposal', where: [['rank', '==', 1]] }, 'not a property');
    bad(GOV_SCHEMAS, { documentTypeName: 'nope', where: [] }, 'unknown document type');
  });
});
