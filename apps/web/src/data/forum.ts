// The forum data source the UI uses: @govhub/forum's reader over live Platform (proof-verified evo-sdk queries) or
// over the fixture store, plus DPNS names. Writes go through the signed-in Session, never through here.
import { forumOps, ForumReader, MemoryStore, SCHEMAS, type DocReader, type ForumContracts, type ForumOps } from '@govhub/forum';
import type { Registry } from '../config/registry.ts';
import type { DataMode } from '../config/mode.ts';
import { formatInt, shortHash } from '../lib/format.ts';
import { DPNS_CONTRACT_ID } from '../contests/model.ts';
import { createDpnsResolver, type DomainDoc } from './dpns.ts';
import { getSdk, queryContract } from './platform.ts';
import type { Provenance } from './types.ts';

export interface ForumSource {
  readonly contracts: ForumContracts;
  readonly reader: ForumReader;
  readonly ops: ForumOps;
  /** fixture mode: the in-memory store the fixture session writes into */
  readonly store: MemoryStore | null;
  /** provenance of a forum read at a Platform height */
  prov(height?: number | null): Provenance;
  /** The primary DPNS username (proof-verified, first registered) of each of these identities that has one; batched and cached (data/dpns.ts). */
  names(ids: readonly string[]): Promise<Map<string, string>>;
}

export const contractsOf = (r: Registry): ForumContracts => ({ forum: r.forum.contractId, mod: r.forum.modContractId, gov: r.govContractId });

export function liveForum(registry: Registry): ForumSource {
  const contracts = contractsOf(registry);
  const reader: DocReader = {
    async query(contract, q) {
      return queryContract(registry, contracts[contract], SCHEMAS[contract], q);
    },
  };
  const dpns = createDpnsResolver(async (ids, { limit, startAfter }) => {
    const sdk = await getSdk(registry);
    const res = await sdk.documents.queryWithProof({
      dataContractId: DPNS_CONTRACT_ID,
      documentTypeName: 'domain',
      where: [['records.identity', 'in', [...ids]]],
      orderBy: [['records.identity', 'asc']],
      limit,
      ...(startAfter ? { startAfter } : {}),
    } as never);
    return [...res.data.values()].filter((d): d is NonNullable<typeof d> => !!d).map((d) => d.toJSON() as DomainDoc);
  });
  return {
    contracts,
    reader: new ForumReader(reader),
    ops: forumOps(contracts),
    store: null,
    prov: (height) => ({ kind: 'proof', source: `Platform ${registry.platformNetwork}`, detail: [`forum contract ${shortHash(contracts.forum, 4)}`, height ? `Platform height ${formatInt(height)}` : null].filter(Boolean).join(', ') }),
    names: (ids) => dpns.names(ids),
  };
}

/** Fixture mode: an in-memory store seeded with sample discussion around the snapshot's proposals. */
export function fixtureForum(registry: Registry, seed: (store: MemoryStore) => Promise<{ names: Map<string, string> }>, nowMs: () => number): ForumSource {
  const contracts = contractsOf(registry);
  const store = new MemoryStore({ contracts, owners: { mod: registry.forum.moderationIdentityId, gov: registry.forum.moderationIdentityId }, now: nowMs, latency: 40 });
  const ready = seed(store);
  const reader: DocReader = {
    async query(contract, q) {
      await ready;
      return store.query(contract, q);
    },
  };
  return {
    contracts,
    reader: new ForumReader(reader),
    ops: forumOps(contracts, nowMs),
    store,
    prov: () => ({ kind: 'fixture', source: 'fixture discussion', detail: 'sample comments, reactions and moderation around the mainnet snapshot; nothing here is on Platform' }),
    async names(ids) {
      const { names } = await ready;
      return new Map(ids.filter((id) => names.has(id)).map((id) => [id, names.get(id)!]));
    },
  };
}

export const createForum = (mode: DataMode, registry: Registry, fixture: () => ForumSource): ForumSource => (mode === 'fixtures' ? fixture() : liveForum(registry));
