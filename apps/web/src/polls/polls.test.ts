import { beforeEach, describe, expect, it, vi } from 'vitest';
import { base64, bytesToId } from '@govhub/forum';
import { defaultRegistry } from '../config/registry.ts';
import { ARCHIVE_CONTRACT, POLL_CONTRACT, answerOperations, decodePoll, emptyDraft, pollOperation, readDraft, tally, type Poll } from './model.ts';
import schema from './contract.json';

const mocks = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn() }));
vi.mock('../data/platform.ts', () => ({ getSdk: async () => ({ documents: { queryWithProof: mocks.query, getWithProof: mocks.get } }) }));
const { pollSource } = await import('./source.ts');
const id = bytesToId(new Uint8Array(32).fill(1)), owner = bytesToId(new Uint8Array(32).fill(2));
const p: Poll = { id, owner, createdAt: 1, question: 'Which day?', options: ['Saturday', 'Sunday'], multiChoice: false, endsAt: 1000 };
const ballot = (who: number, choice: number, time = 900) => ({ pollId: base64.encode(new Uint8Array(32).fill(1)), $ownerId: bytesToId(new Uint8Array(32).fill(who)), choice, $createdAt: time });
const result = (docs: Record<string, unknown>[]) => ({ data: new Map(docs.map((d, i) => [i, { toJSON: () => d }])) });
const registry = { ...defaultRegistry(), platformNetwork: 'testnet' as const };

beforeEach(() => vi.clearAllMocks());
describe('poll drafts and contract operations', () => {
  it('restores all composer fields from session storage and tolerates damaged drafts', () => {
    const draft = { ...emptyDraft(), question: 'Which day?', options: ['Saturday', 'Sunday'], multiChoice: true, close: '2030-01-01T12:00' };
    expect(readDraft({ getItem: () => JSON.stringify(draft) })).toEqual(draft);
    expect(readDraft({ getItem: () => '{' })).toEqual(emptyDraft());
    expect(readDraft({ getItem: () => { throw Error('blocked'); } })).toEqual(emptyDraft());
  });
  it('builds enumerated options and optional advisory close date without a network call', () => {
    const op = pollOperation({ question: ' Question ', options: [' A ', ' B '], multiChoice: true, close: '2030-01-01T00:00Z' }, 10);
    expect(op).toEqual({ action: 'create', contractId: POLL_CONTRACT, type: 'poll', data: { $createdAt: 10, question: 'Question', option0: 'A', option1: 'B', multiChoice: true, endsAt: Date.parse('2030-01-01T00:00Z') } });
    expect(() => pollOperation({ ...emptyDraft(), question: 'Q', options: ['a', ' A '] })).toThrow('different');
  });
  it('keeps the contract-enforced single-answer and per-choice uniqueness rules', () => {
    expect(schema.documentSchemas.vote.indices.find(i => i.unique)?.properties).toEqual([{ pollId: 'asc' }, { $ownerId: 'asc' }]);
    expect(schema.documentSchemas.multiVote.indices.find(i => i.unique)?.properties).toEqual([{ pollId: 'asc' }, { $ownerId: 'asc' }, { choice: 'asc' }]);
    expect(answerOperations(p, [0], 900)[0]?.type).toBe('vote');
    expect(answerOperations({ ...p, multiChoice: true }, [0, 1], 900).map(o => o.type)).toEqual(['multiVote', 'multiVote']);
    expect(() => answerOperations(p, [0, 1], 900)).toThrow('valid');
    expect(() => answerOperations(p, [0], 1001)).toThrow('closed');
  });
  it('separates late answers, deduplicates identities and never mistakes selections for voters', () => {
    const docs = [ballot(2, 0), ballot(2, 0), ballot(3, 1, 1001)];
    expect(tally(p, docs, owner)).toEqual({ counts: [1, 0], late: [0, 1], identities: 1, selections: 1, userChoices: [0] });
    expect(tally({ ...p, multiChoice: true }, [ballot(2, 0), ballot(2, 1)])).toMatchObject({ counts: [1, 1], identities: 1, selections: 2 });
  });
  it('decodes the first contract without enabling writes to it', () => {
    const poll = decodePoll({ $id: id, $ownerId: owner, $createdAt: 1, question: base64.encode(new TextEncoder().encode('Earlier question')), options: base64.encode(new TextEncoder().encode('["A","B"]')), pollType: 0 }, true);
    expect(poll.options).toEqual(['A', 'B']);
    expect(pollOperation({ ...emptyDraft(), question: 'Q', options: ['A', 'B'] }).contractId).not.toBe(ARCHIVE_CONTRACT);
  });
});
describe('proof reads and mock-only publishing', () => {
  it('uses the existing document writer and reaches the write only against a mock', async () => {
    const signAndBroadcastDocument = vi.fn().mockResolvedValue({ id });
    const session = { identityId: owner, label: 'local mock', balance: async () => 0n, close() {}, signAndBroadcastDocument };
    await expect(pollSource(registry).create(session, { ...emptyDraft(), question: 'Question', options: ['A', 'B'] })).resolves.toEqual({ id });
    expect(signAndBroadcastDocument).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', contractId: POLL_CONTRACT, type: 'poll' }));
    expect(mocks.query).not.toHaveBeenCalled();
    await expect(pollSource({ ...registry, platformNetwork: 'mainnet' }).create(session, emptyDraft())).rejects.toThrow('Testnet');
    expect(signAndBroadcastDocument).toHaveBeenCalledTimes(1);
  });
  it('reads ballots through the proof client, with the poll/time index', async () => {
    mocks.query.mockResolvedValue(result([ballot(2, 0)]));
    const t = await pollSource(registry).results(p, owner);
    expect(t.counts).toEqual([1, 0]);
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({ documentTypeName: 'vote', where: [['pollId', '==', id]], orderBy: [['pollId', 'asc'], ['$createdAt', 'asc']] }));
  });
  it('propagates failed tally reads instead of inventing zero answers', async () => {
    mocks.query.mockRejectedValue(Error('offline'));
    await expect(pollSource(registry).results(p)).rejects.toThrow('offline');
  });
});
