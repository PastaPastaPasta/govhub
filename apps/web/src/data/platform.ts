// Platform reads through evo-sdk 5.x, always the proof-verifying variants. The SDK is a ~9 MB
// gzipped chunk (WASM inlined), so it is imported lazily: preloadSdk() is called after first paint.
import { decodeTallySet, parseProposalData, TALLY_SET_FIELDS } from '@govhub/verify';
import { base64 } from '@scure/base';
import type { Registry } from '../config/registry.ts';
import { b64ToHex } from '../lib/bytes.ts';
import { DUFFS_PER_DASH } from '../lib/format.ts';
import { GOV_SCHEMAS } from './queries.ts';
import { assertQuery, type ContractSchemas, type DocQuery } from '@govhub/contracts-v1/queryLint';
import type { Cycle, Proposal, Tally } from './types.ts';

type EvoModule = typeof import('@dashevo/evo-sdk');
type Sdk = InstanceType<EvoModule['EvoSDK']>;

let current: { key: string; sdk: Promise<Sdk> } | null = null;

const sdkKey = (r: Registry) => JSON.stringify([r.platformNetwork, r.platform]);

export function getSdk(r: Registry): Promise<Sdk> {
  const key = sdkKey(r);
  if (current?.key === key) return current.sdk;
  const sdk = (async () => {
    const mod: EvoModule = await import('@dashevo/evo-sdk');
    await mod.ensureInitialized?.();
    const s = new mod.EvoSDK({
      network: r.platformNetwork,
      trusted: r.platform.trusted,
      ...(r.platform.addresses.length ? { addresses: r.platform.addresses } : {}),
      settings: { timeoutMs: 20000, retries: 2 },
    });
    await s.connect();
    return s;
  })();
  current = { key, sdk };
  sdk.catch(() => {
    if (current?.sdk === sdk) current = null;
  });
  return sdk;
}

export function preloadSdk(r: Registry): void {
  getSdk(r).catch(() => {});
}

export interface DocsResult {
  docs: Record<string, unknown>[];
  height: number | null;
}

/** documents.queryWithProof against any contract, with the PV13 lint applied first (a bad shape would silently return []). */
export async function queryContract(r: Registry, contractId: string, schemas: ContractSchemas, q: DocQuery): Promise<DocsResult> {
  assertQuery(schemas, q);
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
  const h = (res as { metadata?: { height?: unknown } }).metadata?.height;
  return { docs, height: h === undefined || h === null ? null : Number(h) };
}

/** A gov-contract query. */
export const queryDocs = (r: Registry, q: DocQuery): Promise<DocsResult> => queryContract(r, r.govContractId, GOV_SCHEMAS, q);

const docTypes = new Map<string, Promise<Set<string>>>();

/**
 * The document types of the profile's gov contract (proved read, once per contract): `talliesSet` exists on mainnet gov.json and on
 * a testnet contract after its update, not on older ones, which are then read through per-proposal tallies only.
 */
export function govDocTypes(r: Registry): Promise<Set<string>> {
  const key = JSON.stringify([sdkKey(r), r.govContractId]);
  let p = docTypes.get(key);
  if (!p) {
    p = (async () => {
      const c = await (await getSdk(r)).contracts.fetch(r.govContractId);
      return new Set(Object.keys(c?.schemas ?? {}));
    })();
    docTypes.set(key, p);
    p.catch(() => docTypes.delete(key));
  }
  return p;
}

// ---- document JSON -> domain ------------------------------------------------------------------
const num = (d: Record<string, unknown>, k: string): number => {
  const v = d[k];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint' || typeof v === 'string') return Number(v);
  throw new Error(`document field ${k} missing`);
};
const s = (d: Record<string, unknown>, k: string): string => {
  const v = d[k];
  if (typeof v !== 'string') throw new Error(`document field ${k} missing`);
  return v;
};
const hex = (d: Record<string, unknown>, k: string) => b64ToHex(s(d, k));

/**
 * A `proposal` document. The slim shape (mainnet gov.json) stores only the hashed fields plus the indexed name and endEpoch: url,
 * payment address and amount and start come from dataHex (Core's parser). The full shape (older testnet contracts) is read as
 * stored, so the content check still compares every stored field with the hashed data. When dataHex does not parse, the derived
 * fields are empty and that check fails the proposal.
 */
export function docToProposal(d: Record<string, unknown>): Proposal {
  const dataHex = s(d, 'dataHex');
  const full = 'url' in d;
  const f = full ? null : parseProposalData(dataHex).fields;
  return {
    govHash: hex(d, 'govHash'),
    parentHash: hex(d, 'parentHash'),
    revision: num(d, 'revision'),
    time: num(d, 'time'),
    dataHex,
    name: s(d, 'name'),
    url: full ? s(d, 'url') : (f?.url ?? ''),
    paymentAddress: full ? s(d, 'paymentAddress') : (f?.paymentAddress ?? ''),
    paymentAmount: full ? num(d, 'paymentAmount') : f ? Math.round(f.paymentAmount * DUFFS_PER_DASH) : 0,
    startEpoch: full ? num(d, 'startEpoch') : (f?.startEpoch ?? 0),
    endEpoch: num(d, 'endEpoch'),
    collateralTxid: hex(d, 'collateralTxid'),
    collateralHeight: num(d, 'collateralHeight'),
    docId: typeof d.$id === 'string' ? d.$id : undefined,
    createdAt: typeof d.$createdAt === 'number' ? d.$createdAt : undefined,
  };
}

export function docToTally(d: Record<string, unknown>): Tally {
  return {
    govHash: hex(d, 'govHash'),
    asOfHeight: num(d, 'asOfHeight'),
    yesWeighted: num(d, 'yesWeighted'),
    noWeighted: num(d, 'noWeighted'),
    abstainWeighted: num(d, 'abstainWeighted'),
    yesCount: num(d, 'yesCount'),
    noCount: num(d, 'noCount'),
    abstainCount: num(d, 'abstainCount'),
    voteSetHash: hex(d, 'voteSetHash'),
    rank: num(d, 'rank'),
    inNextBudget: d.inNextBudget === true,
    margin: num(d, 'margin'),
  };
}

/** One `talliesSet` page: every entry becomes a Tally at the page's asOfHeight. Throws when the packed bytes do not decode. */
export function docToTallySet(d: Record<string, unknown>): { page: number; asOfHeight: number; tallies: Tally[] } {
  const asOfHeight = num(d, 'asOfHeight');
  const fields = TALLY_SET_FIELDS.map((k) => (d[k] === undefined ? undefined : base64.decode(s(d, k))));
  return { page: num(d, 'page'), asOfHeight, tallies: decodeTallySet(fields).map((e) => ({ ...e, asOfHeight })) };
}

export function docToCycle(d: Record<string, unknown>): Cycle {
  return {
    superblockHeight: num(d, 'superblockHeight'),
    budget: num(d, 'budget'),
    allocated: num(d, 'allocated'),
    votingDeadlineHeight: num(d, 'votingDeadlineHeight'),
    estTime: num(d, 'estTime'),
    validWeighted: num(d, 'validWeighted'),
    paid: num(d, 'paid'),
  };
}
