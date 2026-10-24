// Do ENABLED nodes with versionCheck=fail still serve Core RPCs? (Node, one getBlockchainStatus each, 20 at a time)
import { DapiCore } from '../src/core.js';
const { data } = await (await fetch('https://quorums.mainnet.networks.dash.org/masternodes')).json();
const nodes = data.filter((n) => n.status === 'ENABLED' && n.versionCheck !== 'success' && n.addresses?.platform_https?.length).map((n) => n.addresses.platform_https[0]);
let i = 0; const res = [];
await Promise.all(Array.from({ length: 20 }, async () => { while (i < nodes.length) { const node = nodes[i++]; const t0 = performance.now(); try { const s = await new DapiCore(node, { timeoutMs: 10000 }).getBlockchainStatus(); res.push({ node, ok: true, synced: s.chain.isSynced, h: s.chain.blocksCount, ms: performance.now() - t0 }); } catch (e) { res.push({ node, ok: false, err: e.message }); } } }));
const ok = res.filter((r) => r.ok), maxH = Math.max(...ok.map((r) => r.h));
console.log({ tried: nodes.length, ok: ok.length, failed: res.length - ok.length, synced: ok.filter((r) => r.synced && r.h >= maxH - 1).length });
const errs = {}; for (const r of res.filter((r) => !r.ok)) errs[r.err] = (errs[r.err] || 0) + 1; console.log(errs);
