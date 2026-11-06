import { assertQuery, type ContractSchemas, type DocQuery } from '@govhub/contracts-v1/queryLint';
import schema from './contract.json';
import legacySchema from './legacy-contract.json';
import { getSdk } from '../data/platform.ts';
import type { Registry } from '../config/registry.ts';
import type { Session } from '../session/session.ts';
import type { DataContract, DocumentCreateCostOptions } from '@dashevo/evo-sdk';
import { ARCHIVE_CONTRACT, POLL_CONTRACT, answerOperations, decodePoll, identifier, pollOperation, tally, voteType, type Draft, type Poll, type Tally } from './model.ts';

export function pollSource(registry: Registry) {
  let costContract: Promise<DataContract> | undefined;
  const contract = (archive: boolean) => archive ? ARCHIVE_CONTRACT : POLL_CONTRACT;
  const checkNetwork = () => { if (registry.platformNetwork !== 'testnet') throw Error('Polls are available on Testnet only.'); };
  async function documents(type: string, archive = false, poll?: Poll): Promise<Record<string, unknown>[]> {
    checkNetwork();
    const sdk = await getSdk(registry), docs: Record<string, unknown>[] = [];
    let startAfter: string | undefined;
    for (let page = 0; page < 100; page++) {
      const query: DocQuery = { documentTypeName: type, where: poll ? [['pollId', '==', poll.id]] : [],
        orderBy: poll ? [['pollId', 'asc'], ['$createdAt', 'asc']] : [['$createdAt', 'asc']],
        limit: 100, ...(startAfter ? { startAfter } : {}) };
      assertQuery((archive ? legacySchema : schema.documentSchemas) as unknown as ContractSchemas, query);
      const res = await sdk.documents.queryWithProof({ dataContractId: contract(archive), ...query } as never);
      const rows = [...res.data.values()].filter(d => d != null).map(d => d.toJSON() as Record<string, unknown>);
      docs.push(...rows);
      if (rows.length < 100) return docs;
      const next = identifier(rows.at(-1)!.$id);
      if (next === startAfter) break;
      startAfter = next;
    }
    throw Error('This read is too large to finish. No partial totals are shown.');
  }
  return {
    async estimate(type: string, fields: DocumentCreateCostOptions['fields']) {
      checkNetwork();
      const sdk = await getSdk(registry);
      costContract ??= sdk.contracts.fetchWithProof(POLL_CONTRACT).then(result => {
        if (!result.data) throw Error('Poll contract unavailable.');
        return result.data;
      }).catch(error => { costContract = undefined; throw error; });
      const [{ documentCreateCost }, contract] = await Promise.all([import('@dashevo/evo-sdk'), costContract]);
      return Number(documentCreateCost(contract, type, { fields }, sdk.version()).totalCredits.newValues);
    },
    async list(archive = false) { return (await documents('poll', archive)).map(d => decodePoll(d, archive)).sort((a, b) => b.createdAt - a.createdAt); },
    async get(id: string, archive = false) {
      checkNetwork();
      identifier(id);
      const res = await (await getSdk(registry)).documents.getWithProof(contract(archive), 'poll', id);
      return res.data ? decodePoll(res.data.toJSON() as Record<string, unknown>, archive) : null;
    },
    async results(p: Poll, viewer?: string, archive = false): Promise<Tally> {
      return tally(p, await documents(archive ? 'vote' : voteType(p), archive, p), viewer, archive);
    },
    async create(session: Session, draft: Draft) {
      checkNetwork();
      return session.signAndBroadcastDocument(pollOperation(draft));
    },
    async answer(session: Session, p: Poll, choices: number[]) {
      checkNetwork();
      const operations = answerOperations(p, choices);
      const before = await this.results(p, session.identityId);
      if (!p.multiChoice && before.userChoices.length) throw Error('This identity has already answered.');
      const recorded = [...before.userChoices];
      for (const op of operations) {
        const choice = op.action === 'create' ? Number(op.data.choice) : -1;
        if (recorded.includes(choice)) continue;
        try { await session.signAndBroadcastDocument(op); recorded.push(choice); }
        catch (error) { throw Error(`${recorded.length ? `${recorded.length} selection(s) recorded. ` : ''}${error instanceof Error ? error.message : 'Answer could not be sent.'} Refresh results before trying again.`); }
      }
    },
  };
}
export type PollSource = ReturnType<typeof pollSource>;
