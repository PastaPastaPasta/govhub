// Records a coherent, read-only snapshot for the offline anchoring tests: a header run, the full SML at a block inside it, the newest
// ChainLock, and the newest superblock's coinbase. Needs network.
//   node --experimental-strip-types scripts/record-anchor-fixtures.mjs mainnet [node]
// Writes test/fixtures/anchor-<network>.json.gz (dapi) and ../verify/test/fixtures/superblock-<network>.json.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createDapi, DapiCore, decodeCbor, hex, parseBlock, parseChainLock } from '../src/index.ts';
import { fetchHeaders } from '../src/anchor.ts';
import { x11Many } from '../src/x11.ts';
import { superblockSchedule } from '../../verify/src/index.ts';

const network = process.argv[2] ?? 'mainnet';
const dapi = createDapi({ network, ...(process.argv[3] ? { nodes: [process.argv[3]] } : {}) });
const nodes = await dapi.ready();
const node = process.argv[3] ?? nodes[0];
const core = new DapiCore(node);
const status = await core.getBlockchainStatus();
const tip = status.chain.blocksCount;
console.log(network, 'node', node, 'tip', tip);

const smlRaw = await new Promise((resolve, reject) => {
  const h = core.subscribeToMasternodeList((b) => { h.cancel(); resolve(b); });
  h.closed.then((r) => r.reason === 'error' && reject(r.error));
});
const cl = await new Promise((resolve, reject) => {
  const h = core.subscribeToBlockHeadersWithChainLocks({ fromHeight: tip, count: 0 }, (ev) => { if (ev.type === 'chainlock') { h.cancel(); resolve(ev.chainLock); } });
  h.closed.then((r) => r.reason === 'error' && reject(r.error));
});
const sml = decodeCbor(smlRaw), lock = parseChainLock(cl);
const top = Math.max(tip, lock.height);
const { last } = superblockSchedule(lock.height, network);
const from = Math.min(top - 1600, last - 30); // the newest superblock is inside the run
const run = await fetchHeaders(dapi, from, top, x11Many);
const sbRaw = await core.getBlock({ height: last });
const block = parseBlock(sbRaw);
const out = {
  network, recordedAt: new Date().toISOString(), now: Math.floor(Date.now() / 1000), node,
  from, headersB64: Buffer.from(run.headers).toString('base64'), smlB64: Buffer.from(smlRaw).toString('base64'), chainLockHex: hex(cl),
  superblock: { height: last, blockB64: Buffer.from(sbRaw).toString('base64') },
};
writeFileSync(new URL(`../test/fixtures/anchor-${network}.json.gz`, import.meta.url), gzipSync(JSON.stringify(out), { level: 9 }));
console.log('headers', from, top, 'cl', lock.height, 'sml block', sml.blockHash);

writeFileSync(new URL(`../../verify/test/fixtures/superblock-${network}.json`, import.meta.url), JSON.stringify({
  network, height: last, blockHash: hex(Uint8Array.from(run.hashes.subarray((last - from) * 32, (last - from + 1) * 32)).reverse()),
  coinbaseHex: hex(block.txs[0].raw), recordedAt: out.recordedAt,
}, null, 2) + '\n');
console.log('superblock', last, 'outputs', block.txs[0].outputs.length);
process.exit(0);
