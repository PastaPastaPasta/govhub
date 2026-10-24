// Prints what the testnet `gov` contract currently holds, using the same query shapes as the app
// (src/data/queries.ts). Read-only. Usage: node scripts/probe-platform.mjs [contractId]
import { EvoSDK, ensureInitialized } from '@dashevo/evo-sdk';

const contractId = process.argv[2] ?? '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ';
await ensureInitialized();
const sdk = EvoSDK.testnetTrusted({ settings: { timeoutMs: 30000, retries: 2 } });
await sdk.connect();
const now = Math.floor(Date.now() / 1000);

async function q(label, documentTypeName, where, orderBy, limit = 100) {
  const t0 = performance.now();
  const r = await sdk.documents.queryWithProof({ dataContractId: contractId, documentTypeName, where, orderBy, limit });
  const docs = [...r.data.values()].filter(Boolean).map((d) => d.toJSON());
  console.log(`${label}: ${docs.length} docs in ${Math.round(performance.now() - t0)} ms (height ${r.metadata?.height})`);
  for (const d of docs.slice(0, 3)) console.log('  ', JSON.stringify(d).slice(0, 400));
  return docs;
}

await q('G2 active', 'proposal', [['endEpoch', '>', now]], [['endEpoch', 'asc']]);
await q('G3 past', 'proposal', [['endEpoch', '<=', now]], [['endEpoch', 'desc']]);
await q('G6 cycles', 'cycle', [['superblockHeight', '>', 0]], [['superblockHeight', 'desc']], 3);
console.log('protocol version', sdk.version());
