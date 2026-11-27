// The live source against a fake SDK: whether polls exist is read (and a "not yet" read again), documents and states map to the
// model, and the open multiple choice polls are picked out of the shared contested-poll scan.
import { describe, expect, it, vi } from 'vitest';
import type { Registry } from '../config/registry.ts';
import { DECISIONS_CONTRACT_ID } from './model.ts';

const fake = vi.hoisted(() => ({ sdk: null as unknown }));
vi.mock('../data/platform.ts', () => ({ getSdk: async () => fake.sdk }));
const { liveDecisions, toChoicePoll, toYesNo, toYesNoState } = await import('./source.ts');

const ID = 'Bx4sgMPNXuZxZwnHa42sT7NKvzZsMpywSX9zDiYp69bK';
const OWNER = 'BZU5G74aRjoxkupGoS98Rq4Hm5TLp5BFyewNxTWuVRUS';
const registry = (): Registry => ({ platformNetwork: 'testnet', coreNetwork: 'testnet', platform: { trusted: true, addresses: [`t${Math.random()}`] } }) as unknown as Registry;
const doc = (j: Record<string, unknown>) => ({ toJSON: () => j });

describe('documents', () => {
  it('maps a proposal as testnet returns it', () => {
    const p = toYesNo({ $id: ID, $ownerId: OWNER, title: 'Q?', description: 'd', endDate: 1798060084514, minimumTurnoutPercent: 10, passPercent: 60, $revision: 1, $createdAt: 1795644484832, $updatedAt: 1795644484832 });
    expect(p).toMatchObject({ kind: 'yn', id: ID, ownerId: OWNER, url: null, passPercent: 60, minimumTurnoutPercent: 10, endDate: 1798060084514, revision: 1 });
    expect(toYesNo({ $id: ID, title: 'Q?' })).toBeNull();
  });

  it('maps a multiple choice proposal, with a description document only when named whole', () => {
    const base = { $id: ID, $ownerId: OWNER, title: 'Which?', url: 'https://x.org', open: false, $revision: 2, $createdAt: 1, $updatedAt: 2 };
    expect(toChoicePoll(base)).toMatchObject({ kind: 'mc', open: false, url: 'https://x.org', description: null, revision: 2 });
    expect(toChoicePoll({ ...base, descriptionId: ID, descriptionContractId: OWNER, descriptionDocumentType: 'page' })!.description).toEqual({ id: ID, contractId: OWNER, documentType: 'page' });
  });

  it('takes a finished poll’s tallies from its recorded result (the running ones are zeroed)', () => {
    expect(toYesNoState({ status: 'started', yesVotingPower: 4, noVotingPower: 1, abstainVotingPower: 0 })).toEqual({ status: 'open', tally: { yes: 4, no: 1, abstain: 0 }, result: null });
    const done = toYesNoState({
      status: 'finished',
      yesVotingPower: 0,
      noVotingPower: 0,
      abstainVotingPower: 0,
      result: { passed: true, yesVotingPower: 9, noVotingPower: 2, abstainVotingPower: 1, requiredVotingPower: 5, finalizationBlock: { timeMs: 77n } },
    });
    expect(done).toEqual({ status: 'finished', tally: { yes: 9, no: 2, abstain: 1 }, result: { passed: true, required: 5, at: 77 } });
  });
});

describe('liveDecisions', () => {
  it('says whether the network has polls from a proved read of the contract, and asks again while it has not', async () => {
    const fetch = vi.fn(async () => undefined as unknown);
    fake.sdk = { contracts: { fetch } };
    const now = vi.spyOn(Date, 'now');
    const t0 = Date.now();
    now.mockReturnValue(t0);
    const src = liveDecisions(registry());
    expect(await src.available()).toBe(false);
    expect(await src.available()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(DECISIONS_CONTRACT_ID);
    // a few minutes later protocol 15 is live: it is read again and lights up, and stays
    now.mockReturnValue(t0 + 6 * 60_000);
    fetch.mockResolvedValue({ id: DECISIONS_CONTRACT_ID });
    expect(await src.available()).toBe(true);
    now.mockReturnValue(t0 + 60 * 60_000);
    expect(await src.available()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('a failed read is an error, never "not yet"', async () => {
    fake.sdk = { contracts: { fetch: vi.fn(async () => Promise.reject(new Error('no node answered'))) } };
    await expect(liveDecisions(registry()).available()).rejects.toThrow('no node answered');
  });

  it('picks the open multiple choice polls out of the contested polls by end date', async () => {
    const poll = (contractId: string, documentTypeName: string, v: string) => ({ toJSON: () => ({ contractId, documentTypeName, indexName: 'byProposal', indexValues: [v] }) });
    fake.sdk = {
      voting: {
        votePollsByEndDateWithProof: vi.fn(async () => ({
          data: [
            { timestampMs: 1000n, votePolls: [poll(DECISIONS_CONTRACT_ID, 'choice', ID), poll('GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec', 'domain', 'dash')] },
            { timestampMs: 2000n, votePolls: [poll(DECISIONS_CONTRACT_ID, 'choice', OWNER)] },
          ],
        })),
      },
    };
    expect([...(await liveDecisions(registry()).openChoices())]).toEqual([
      [ID, 1000],
      [OWNER, 2000],
    ]);
  });

  it('pages every poll of a kind newest first, and reads a masternode’s answers by proTxHash', async () => {
    const byCreatedAt = vi.fn(async () => new Map([[ID, doc({ $id: ID, $ownerId: OWNER, title: 'Q', description: 'd', endDate: 5, minimumTurnoutPercent: 0, passPercent: 50, $createdAt: 1 })]]));
    const masternodeVote = vi.fn(async (pro: string) => (pro === 'aa' ? { choice: 'no', timesVoted: 1 } : undefined));
    const mcVote = vi.fn(async (pro: string) => (pro === 'aa' ? { choiceId: { toString: () => OWNER } } : 'noneOfTheChoices'));
    fake.sdk = { decisionProposals: { byCreatedAt, masternodeVote, multipleChoice: { masternodeVote: mcVote } } };
    const src = liveDecisions(registry());
    const page = await src.page('yn');
    expect(page.polls.map((p) => p.id)).toEqual([ID]);
    expect(page.next).toBeNull();
    expect(byCreatedAt).toHaveBeenCalledWith({ limit: 50 });
    expect([...(await src.votesOf('yn', ID, ['aa', 'bb']))]).toEqual([
      ['aa', { kind: 'no' }],
      ['bb', null],
    ]);
    expect([...(await src.votesOf('mc', ID, ['aa', 'bb']))]).toEqual([
      ['aa', { kind: 'contender', identityId: OWNER }],
      ['bb', { kind: 'lock' }],
    ]);
  });

  it('has no voting power estimate where Core and Platform are different networks', async () => {
    expect(await liveDecisions({ ...registry(), coreNetwork: 'mainnet' } as Registry).totalPower()).toBeNull();
  });
});
