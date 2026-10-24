// Playwright harness: serves the built page from http://localhost:<port> (started and stopped HERE, in this
// foreground process), opens it in headless Chromium and drives window.spike against live mainnet evonodes.
// Read-only: no broadcasts. Writes test/results.json. Exit code != 0 if any assertion fails.
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { buildPage } from '../scripts/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SWEEP = process.env.SWEEP === 'all' || !process.env.SWEEP ? Infinity : Number(process.env.SWEEP), NODES = Number(process.env.NODES || 3);
const dist = await buildPage();
const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/flows.js': ['flows.js', 'text/javascript'] };

const server = http.createServer((req, res) => {
  const f = files[req.url.split('?')[0]];
  if (!f) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' }).end(readFileSync(join(dist, f[0])));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${server.address().port}`;
console.log('serving', origin);

const results = { origin, startedAt: new Date().toISOString(), flows: {} };
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(detail ?? '').slice(0, 300)); };
const net = { dapiRequests: 0, failed: {}, failedHosts: {}, inflight: new Set(), aborted: 0 };
let browser;
const guard = setTimeout(() => { console.error('global timeout'); process.exit(2); }, 12 * 60 * 1000);

try {
  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page console.error]', m.text().slice(0, 200)); });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  const isDapi = (u) => u.includes('/org.dash.platform.dapi.v0.');
  page.on('request', (r) => { if (isDapi(r.url())) { net.dapiRequests++; net.inflight.add(r); } });
  page.on('requestfinished', (r) => net.inflight.delete(r));
  page.on('requestfailed', (r) => {
    net.inflight.delete(r);
    const t = r.failure()?.errorText || 'unknown';
    if (t === 'net::ERR_ABORTED') { net.aborted++; return; }
    net.failed[t] = (net.failed[t] || 0) + 1;
    try { (net.failedHosts[t] ??= []).push(new URL(r.url()).host); } catch {}
  });
  await page.goto(origin + '/');
  await page.waitForFunction(() => !!window.spike);
  const call = (fn, ...args) => page.evaluate(([f, a]) => window.spike[f](...a), [fn, args]);
  const timed = async (name, fn, ...args) => { const t0 = Date.now(); const r = await call(fn, ...args); console.log(`[${name}] ${Date.now() - t0}ms`); return r; };

  // 1. node list from the quorum service, fetched cross-origin from the page
  const nl = await timed('listNodes', 'listNodes');
  const { nodes } = nl; results.flows.nodeList = { ms: nl.ms, count: nl.count };
  check('node list fetched cross-origin (CORS)', nl.count > 100, nl);

  // 2. health sweep over random nodes (failure rate)
  const sweepNodes = await page.evaluate(([n, k]) => window.spike.sample(n, Math.min(k, n.length)), [nodes, SWEEP === Infinity ? 1e9 : SWEEP]);
  const sweep = await timed('healthSweep', 'healthSweep', sweepNodes);
  results.flows.healthSweep = { ...sweep, results: sweep.results.map(({ node, ok, ms, error, height, synced, agent }) => ({ node, ok, ms, error, height, synced, agent })) };
  check('health sweep: >=90% of random nodes answer', sweep.failed / sweep.total <= 0.1, { failed: sweep.failed, total: sweep.total });
  const maxH = Math.max(...sweep.results.filter((r) => r.ok).map((r) => r.height));
  const healthy = sweep.results.filter((r) => r.ok && r.synced && r.height >= maxH - 1).map((r) => r.node);
  const picked = healthy.slice(0, NODES);
  check(`>= ${NODES} healthy nodes for full flows`, picked.length >= NODES, healthy.length);

  // 3. full flows on each picked node (nodes in parallel, steps sequential)
  const perNode = await Promise.all(picked.map(async (node) => {
    const r = { node };
    r.unary = await call('unaryFlow', node);
    const H = r.unary.height?.height;
    if (!Number.isInteger(H)) return r; // unary failed; checks below will flag it
    r.headers = await call('headersFlow', node, H);
    r.tx = await call('txFlow', node, H);
    r.sml = await call('smlFlow', node);
    return r;
  }));
  results.flows.perNode = perNode;
  for (const r of perNode) {
    if (!r.headers) { check(`[${r.node}] node reachable for full flows`, false, r.unary); continue; }
    const u = r.unary, tag = `[${r.node}]`;
    check(`${tag} getBlockchainStatus + getBestBlockHeight`, u.status.ok && u.height.ok, [u.status, u.height]);
    check(`${tag} getBlock(height) parses, merkle root ok`, u.blockRecent.ok && u.blockRecent.merkleOk && u.blockCollateral.ok && u.blockCollateral.merkleOk, [u.blockRecent, u.blockCollateral]);
    check(`${tag} collateral found by scanning block ${2559683}`, u.blockCollateral.collateralTxid?.startsWith('3451d292'), u.blockCollateral);
    const tc = u.txCollateral;
    check(`${tag} getTransaction(collateral): raw, height, confs, IS/CL flags, OP_RETURN`, tc.ok && tc.txidMatches && tc.height === 2559683 && tc.confirmations > 100 && tc.isChainLocked && tc.outputs.some((o) => o.type === 'op_return' && o.opReturn?.length === 64), tc);
    check(`${tag} getTransaction(recent)`, u.txRecent.ok && u.txRecent.txidMatches, u.txRecent);
    check(`${tag} getTransaction(unknown) -> NOT_FOUND`, !u.txUnknown.ok && u.txUnknown.error.code === 5, u.txUnknown);
    check(`${tag} headers stream: headers + chainlock, clean cancel`, r.headers.ok, r.headers);
    check(`${tag} bloom positive control: real P2PKH hash160 filter returns the collateral tx + valid merkleblock`, r.tx.bloomControl.gotCollateral && r.tx.bloomControl.merkleContainsTx && r.tx.bloomControl.merkleRootOk, r.tx.bloomControl);
    check(`${tag} bloom (>=200B) stream: opened, ~0 matches, clean cancel`, r.tx.bloom.vDataBytes >= 200 && r.tx.bloom.txs <= 5 && r.tx.bloom.closed === 'cancelled', r.tx.bloom);
    const ma = r.tx.matchAll;
    check(`${tag} match-all stream: raw txs + merkle blocks (root ok), clean cancel`, ma.txs > 0 && ma.merkleBlocks.length > 0 && ma.merkleBlocks.every((m) => m.rootOk && m.allMatchedDelivered) && ma.closed === 'cancelled', ma);
    check(`${tag} SML: first full diff parsed`, r.sml.ok && r.sml.mnCount > 2000 && r.sml.evonodeCount > 200 && r.sml.baseBlockHash === '0'.repeat(64) && r.sml.closed === 'cancelled', r.sml);
  }

  results.flows.latency = await timed('latencyFlow', 'latencyFlow', picked[0]);

  // 4. optional BLS chainlock verification in the browser
  results.flows.bls = await timed('blsFlow', 'blsFlow');
  check('ChainLock BLS signature verifies in browser against SML quorum key; tampered rejected', results.flows.bls.cold?.ok && results.flows.bls.warm?.ok && results.flows.bls.tamperedRejected, results.flows.bls);

  // 5. race helpers
  const rest = healthy.slice(0, 6);
  results.flows.race = await timed('raceFlow', 'raceFlow', rest);
  check('race(): winner despite dead nodes first', results.flows.race.withBadNodesFirst.winner && !results.flows.race.withBadNodesFirst.winner.startsWith('127.') && results.flows.race.withBadNodesFirst.failures.length >= 2, results.flows.race);
  const Hnow = perNode[0].unary.height.height;
  results.flows.merge = await timed('mergeFlow', 'mergeFlow', healthy.slice(0, 3), Hnow);
  const mg = results.flows.merge;
  check('mergeStreams(): items delivered exactly once across 3 nodes, dead node replaced, clean cancel', mg.deliveredTxs + mg.deliveredIsLocks.length >= 1 && mg.deliveredExactlyOnce && mg.stats.failed.length >= 1 && mg.stats.opened.length >= 4 && mg.stats.dupes > 0 && mg.closed === 'closed', mg);

  const totalIsLocks = perNode.reduce((a, r) => a + r.tx.matchAll.islocks, 0) + mg.deliveredIsLocks.length;
  check('InstantSend lock messages received and parsed in the browser (match-all streams + merged streams)', totalIsLocks >= 1, { totalIsLocks });

  // 6. nothing left running
  await new Promise((r) => setTimeout(r, 1500));
  results.network = { dapiRequests: net.dapiRequests, abortedByClient: net.aborted, failedByReason: net.failed, failedHosts: net.failedHosts, inflightAtEnd: net.inflight.size };
  check('no DAPI request left in flight after all streams cancelled', net.inflight.size === 0, [...net.inflight].map((r) => r.url()));
  results.browser = browser.version();
} catch (e) {
  check('harness ran to completion', false, String(e.stack || e));
} finally {
  clearTimeout(guard);
  results.checks = checks;
  writeFileSync(join(here, 'results.json'), JSON.stringify(results, null, 2));
  await browser?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; results -> test/results.json`);
process.exit(failed.length ? 1 : 0);
