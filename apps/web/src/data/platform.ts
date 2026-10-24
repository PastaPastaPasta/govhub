// Platform reads through evo-sdk 5.x, always the proof-verifying variants. The SDK is a ~9 MB
// gzipped chunk (WASM inlined), so it is imported lazily: preloadSdk() is called after first paint.
import type { Registry } from '../config/registry.ts';
import { b64ToHex } from '../lib/bytes.ts';
import { GOV_SCHEMAS } from './queries.ts';
import { assertQuery, type DocQuery } from '@govhub/contracts-v1/queryLint';
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

/** documents.queryWithProof with the PV13 lint applied first (a bad shape would silently return []). */
export async function queryDocs(r: Registry, q: DocQuery): Promise<DocsResult> {
  assertQuery(GOV_SCHEMAS, q);
  const sdk = await getSdk(r);
  const res = await sdk.documents.queryWithProof({
    dataContractId: r.govContractId,
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

export function docToProposal(d: Record<string, unknown>): Proposal {
  return {
    govHash: hex(d, 'govHash'),
    parentHash: hex(d, 'parentHash'),
    revision: num(d, 'revision'),
    time: num(d, 'time'),
    dataHex: s(d, 'dataHex'),
    name: s(d, 'name'),
    url: s(d, 'url'),
    paymentAddress: s(d, 'paymentAddress'),
    paymentAmount: num(d, 'paymentAmount'),
    startEpoch: num(d, 'startEpoch'),
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
