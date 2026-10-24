// Node smoke test of the client (same code as the browser). node scripts/smoke.mjs [host:port]
import { DapiCore } from '../src/core.js';
import { fetchNodes, sample } from '../src/nodes.js';
import { parseBlock, parseTx, parseHeader, parseChainLock, hex } from '../src/dash.js';

const nodes = await fetchNodes();
console.log('usable nodes', nodes.length);
const node = process.argv[2] || sample(nodes, 1)[0];
const c = new DapiCore(node);
console.log(node, JSON.stringify(await c.getBlockchainStatus()));
const H = await c.getBestBlockHeight();
console.log('H', H);
const raw = await c.getBlock({ height: 2559683 });
const blk = parseBlock(raw);
console.log('block 2559683 txs', blk.txs.length, 'merkleOk', blk.merkleOk, 'prev', blk.header.prevHash);
const hit = blk.txs.filter((t) => t.txid.startsWith('3451d292'));
console.log('collateral', hit.map((t) => t.txid));
const txid = hit[0]?.txid;
if (txid) {
  const r = await c.getTransaction(txid);
  const tx = parseTx(r.raw);
  console.log('getTransaction', { ...r, raw: r.raw.length, txidOk: tx.txid === txid }, tx.outputs.map((o) => [o.value, hex(o.script).slice(0, 50)]));
}
const hs = c.subscribeToBlockHeadersWithChainLocks({ fromHeight: H - 3 }, (ev) => {
  if (ev.type === 'headers') console.log('headers', ev.headers.map((h) => parseHeader(h).prevHash.slice(-8)));
  else console.log('chainlock bytes', ev.chainLock.length, JSON.stringify(parseChainLock(ev.chainLock), (k, v) => (v instanceof Uint8Array ? undefined : v)));
});
await new Promise((r) => setTimeout(r, 8000));
hs.cancel();
console.log('closed', await hs.closed);
