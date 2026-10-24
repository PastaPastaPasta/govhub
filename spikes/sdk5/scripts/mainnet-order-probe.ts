// Read-only follow-up to mainnet-check.ts: `desc` orderBy returned ascending results on PV13 (F2c, F3). Characterise it:
// which orderBy shapes honour `desc`, with and without proofs, and is the returned Map order just the document-id order?
import { errText, resultsDir, saveResult } from './lib.ts';
import { readState } from './mainnet-lib.ts';

const w: any = await import('evo5');
await w.ensureInitialized();
const sdk = w.EvoSDK.mainnetTrusted({ settings: { timeoutMs: 60000, retries: 2 } });
await sdk.connect();
const st: any = readState(null);
const C = st.check, CID = C.contract.id, M = st.items[0].identityId;
const keyById: Record<string, string> = Object.fromEntries(Object.entries<any>(C.docs).map(([k, d]) => [d.id, k]));
const b64 = (h: string) => Buffer.from(h, 'hex').toString('base64');
const G1 = b64(C.fixtures.G1), T1 = b64(C.fixtures.T1);
const created = Object.fromEntries(Object.entries<any>(C.docs).filter(([, d]) => !d.deleted).map(([k, d]) => [k, d.createdAt]));
console.log('createdAt (block time ms):', JSON.stringify(created));
const sortedIds = (ks: string[]) => ks.slice().sort((a, b) => C.docs[a].id < C.docs[b].id ? -1 : 1);
console.log('doc id order (base58 string sort, not byte order):', JSON.stringify(sortedIds(['C1', 'C2', 'C3'])));

type P = { name: string; type: string; where: any[]; orderBy?: any[]; limit?: number };
const probes: P[] = [
  { name: 'comment G1: [govHash asc, $createdAt asc]', type: 'comment', where: [['govHash', '==', G1]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']] },
  { name: 'comment G1: [govHash desc, $createdAt desc]  (F2c)', type: 'comment', where: [['govHash', '==', G1]], orderBy: [['govHash', 'desc'], ['$createdAt', 'desc']] },
  { name: 'comment G1: [govHash asc, $createdAt desc]', type: 'comment', where: [['govHash', '==', G1]], orderBy: [['govHash', 'asc'], ['$createdAt', 'desc']] },
  { name: 'comment G1: [$createdAt desc] only', type: 'comment', where: [['govHash', '==', G1]], orderBy: [['$createdAt', 'desc']] },
  { name: 'comment G1: [govHash desc] only', type: 'comment', where: [['govHash', '==', G1]], orderBy: [['govHash', 'desc']] },
  { name: 'comment M: [$ownerId asc, $createdAt desc]  (F3)', type: 'comment', where: [['$ownerId', '==', M]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']] },
  { name: 'comment M: [$ownerId desc, $createdAt desc]', type: 'comment', where: [['$ownerId', '==', M]], orderBy: [['$ownerId', 'desc'], ['$createdAt', 'desc']] },
  { name: 'comment M: [$createdAt desc] only', type: 'comment', where: [['$ownerId', '==', M]], orderBy: [['$createdAt', 'desc']] },
  { name: 'comment M: [$ownerId asc, $createdAt asc]', type: 'comment', where: [['$ownerId', '==', M]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'asc']] },
  { name: 'reaction T1: [target desc, $createdAt desc]', type: 'reaction', where: [['target', '==', T1]], orderBy: [['target', 'desc'], ['$createdAt', 'desc']] },
  { name: 'reaction T1: [target asc, $createdAt asc]', type: 'reaction', where: [['target', '==', T1]], orderBy: [['target', 'asc'], ['$createdAt', 'asc']] },
  { name: 'comment M, range $createdAt > 0: [$ownerId asc, $createdAt desc]', type: 'comment', where: [['$ownerId', '==', M], ['$createdAt', '>', 0]], orderBy: [['$ownerId', 'asc'], ['$createdAt', 'desc']] },
  { name: 'comment M, range $createdAt > 0: [$createdAt desc]', type: 'comment', where: [['$ownerId', '==', M], ['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']] },
];
const S = st.items[1].identityId;
const ISS = M;
const keyById2 = keyById; // B* keys map via keyById too
probes.push(
  { name: 'comment G1 + $createdAt > 0: [govHash asc, $createdAt desc]', type: 'comment', where: [['govHash', '==', G1], ['$createdAt', '>', 0]], orderBy: [['govHash', 'asc'], ['$createdAt', 'desc']] },
  { name: 'comment G1 + $createdAt > 0: [$createdAt desc]', type: 'comment', where: [['govHash', '==', G1], ['$createdAt', '>', 0]], orderBy: [['$createdAt', 'desc']] },
  { name: 'comment G1 + $createdAt > 0: [govHash asc, $createdAt asc]', type: 'comment', where: [['govHash', '==', G1], ['$createdAt', '>', 0]], orderBy: [['govHash', 'asc'], ['$createdAt', 'asc']] },
  { name: 'reaction T1 + $createdAt > 0: [target asc, $createdAt desc]', type: 'reaction', where: [['target', '==', T1], ['$createdAt', '>', 0]], orderBy: [['target', 'asc'], ['$createdAt', 'desc']] },
  { name: 'reaction T1 + $createdAt > 0: [target asc, $createdAt asc]', type: 'reaction', where: [['target', '==', T1], ['$createdAt', '>', 0]], orderBy: [['target', 'asc'], ['$createdAt', 'asc']] },
  { name: 'mnBadge issuer, epoch >= 0: [epoch desc]', type: 'mnBadge', where: [['issuerId', '==', ISS], ['epoch', '>=', 0]], orderBy: [['epoch', 'desc']] },
  { name: 'mnBadge issuer, epoch >= 0: [epoch asc]', type: 'mnBadge', where: [['issuerId', '==', ISS], ['epoch', '>=', 0]], orderBy: [['epoch', 'asc']] },
  { name: 'mnBadge issuer, epoch 300, $ownerId in [M,S]: [$ownerId asc]', type: 'mnBadge', where: [['issuerId', '==', ISS], ['epoch', '==', 300], ['$ownerId', 'in', [M, S]]], orderBy: [['$ownerId', 'asc']] },
  { name: 'mnBadge issuer, epoch 300, $ownerId in [M,S]: [$ownerId desc]', type: 'mnBadge', where: [['issuerId', '==', ISS], ['epoch', '==', 300], ['$ownerId', 'in', [M, S]]], orderBy: [['$ownerId', 'desc']] },
);
const out: any[] = [];
for (const p of probes) {
  const row: any = { name: p.name };
  for (const mode of ['withProof', 'noProof'] as const) {
    try {
      const q = { dataContractId: CID, documentTypeName: p.type, where: p.where, orderBy: p.orderBy, limit: 100 };
      const r: any = mode === 'withProof' ? (await sdk.documents.queryWithProof(q)).data : await sdk.documents.query(q);
      const docs = [...r.values()].filter(Boolean) as any[];
      row[mode] = docs.map((d) => keyById[d.id.toString()]).join(',') + `  (createdAt order: ${docs.map((d) => String(d.createdAt).slice(-5)).join('<>')})`;
    } catch (e) { row[mode] = `ERROR ${errText(e).slice(0, 120)}`; }
  }
  out.push(row);
  console.log(`${p.name}\n    proof:   ${row.withProof}\n    noproof: ${row.noProof}`);
}
saveResult('mainnet-order-probe.json', { at: new Date().toISOString(), network: 'mainnet (protocol 13)', createdAt: created, probes: out });
process.exit(0);
