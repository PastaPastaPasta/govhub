import { describe, expect, it } from 'vitest';
import { lintQuery } from '@govhub/contracts-v1/queryLint';
import {
  attestationsOf,
  blocksAmong,
  blocksOf,
  blockSubsOf,
  claimsOf,
  commentsBy,
  commentsOf,
  commentsSince,
  modBlocksSince,
  myReactionOn,
  myReactionsOn,
  postOf,
  profileOf,
  profilesOf,
  reactionsOn,
  SCHEMAS,
  targetB64,
  type ContractQuery,
} from '../src/index.ts';

const H = 'a5465cdb6caf234cc9b8b776b1e3b60f319367504527e80a669bf41811419901';
const ID = '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv';
const ID2 = '4eYvJ1QzRxFy82CRK3tP5QHmdRcgkG8xdbGBQMqSroif';
const DOC = 'AWf9ZB521jBDgNMj7aDTrx9fNHtT5Ua522CBdDm2S13y';

describe('every forum/mod/gov query the data layer sends passes the PV13 lint on the intended index', () => {
  const cases: Array<[string, ContractQuery, string]> = [
    ['F1', profileOf(ID), 'byOwner'],
    ['F1b', profilesOf([ID, ID2, ID]), 'byOwner'],
    ['F2', commentsOf(H), 'byProposal'],
    ['F2 paged', commentsOf(H, DOC), 'byProposal'],
    ['F2d', commentsSince(H, 1_792_807_000_000), 'byProposal'],
    ['F3', commentsBy(ID), 'byAuthor'],
    ['F5', myReactionOn(ID, targetB64({ commentId: DOC })), 'byOwnerTarget'],
    ['F5b', myReactionsOn(ID, [targetB64({ govHash: H }), targetB64({ commentId: DOC })]), 'byOwnerTarget'],
    ['F6 comment', reactionsOn(targetB64({ commentId: DOC })), 'byTarget'],
    ['F6 proposal paged', reactionsOn(targetB64({ govHash: H }), DOC), 'byTarget'],
    ['F7', claimsOf(H), 'byProposal'],
    ['F8', postOf(H, ID), 'byProposalOwner'],
    ['F10', blocksOf('forum', ID), 'byOwnerTarget'],
    ['F10b', blocksAmong('forum', ID, [ID2, DOC]), 'byOwnerTarget'],
    ['F11', blockSubsOf(ID), 'byOwner'],
    ['M1', blocksOf('mod', ID), 'byOwnerTarget'],
    ['M1 paged', blocksOf('mod', ID, DOC), 'byOwnerTarget'],
    ['M1b', modBlocksSince(ID, 5), 'byOwnerCreated'],
    ['M1c', blocksAmong('mod', ID, [ID2]), 'byOwnerTarget'],
    ['G7', attestationsOf(H), 'byGovHash'],
  ];
  it.each(cases)('%s', (_label, { contract, q }, index) => {
    const r = lintQuery(SCHEMAS[contract], q);
    expect(r.errors).toEqual([]);
    expect(r.index).toBe(index);
  });

  it('F6 carries the orderBy that pins byTarget (without it PV13 picks the gapped byOwnerTarget and returns [])', () => {
    const { q } = reactionsOn(targetB64({ govHash: H }));
    expect(q.orderBy?.at(-1)?.[0]).toBe('$createdAt');
    const r = lintQuery(SCHEMAS.forum, { ...q, orderBy: undefined });
    expect(r.ok).toBe(false);
  });

  it('newest-first comments by author carry the $createdAt range PV13 needs for desc (rule 7)', () => {
    expect(commentsBy(ID).q.where).toContainEqual(['$createdAt', '>', 0]);
  });

  it('byte-array values go out as base64, identifiers as base58 (rule 6)', () => {
    expect(commentsOf(H).q.where[0]![2]).toBe(Buffer.from(H, 'hex').toString('base64'));
    expect(targetB64({ commentId: DOC })).toHaveLength(44);
    expect(blocksAmong('mod', ID, [DOC]).q.where[1]![2]).toEqual([DOC]);
  });

  it('refuses in-lists over 100 or empty, and malformed hashes', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `${i}`);
    expect(() => profilesOf(ids)).toThrow(/1\.\.100/);
    expect(() => profilesOf([])).toThrow(/1\.\.100/);
    expect(() => commentsOf('zz')).toThrow();
  });
});
