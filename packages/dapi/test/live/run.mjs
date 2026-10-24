// Playwright harness: bundles test/live/page.ts, serves it from http://localhost:<port> (started and stopped HERE, in this
// foreground process), opens it in headless Chromium and drives window.live against live MAINNET evonodes. Read-only.
//   npm run test:live        (needs network and, under the Claude sandbox, dangerouslyDisableSandbox for Chromium + sockets)
// Writes test/live/results.json. Exit code != 0 if any check fails.
import http from 'node:http';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '../../dist/live');
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [join(here, 'page.ts')], outdir: dist, entryNames: 'page', chunkNames: 'chunk-[hash]', bundle: true, splitting: true,
  format: 'esm', platform: 'browser', target: 'es2022', minify: false, logLevel: 'warning',
});
copyFileSync(join(here, 'index.html'), join(dist, 'index.html'));

const types = { '.js': 'text/javascript', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const p = (req.url ?? '/').split('?')[0];
  const file = join(dist, p === '/' ? 'index.html' : p.replace(/\.\./g, ''));
  if (!existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${server.address().port}`;
console.log('serving', origin);

const results = { origin, startedAt: new Date().toISOString(), flows: {} };
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(detail ?? '').slice(0, 400)); };
const net = { dapiRequests: 0, perHost: {}, failed: {}, inflight: new Set(), aborted: 0, nonDapi: [] };
let browser;
const guard = setTimeout(() => { console.error('global timeout'); process.exit(2); }, 10 * 60 * 1000);

try {
  browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page console.error]', m.text().slice(0, 200)); });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  const isDapi = (u) => u.includes('/org.dash.platform.dapi.v0.');
  page.on('request', (r) => {
    if (isDapi(r.url())) { net.dapiRequests++; net.inflight.add(r); const h = new URL(r.url()).host; (net.perHost[h] ??= []).push(Date.now()); }
    else if (!r.url().startsWith(origin)) net.nonDapi.push(r.url());
  });
  page.on('requestfinished', (r) => net.inflight.delete(r));
  page.on('requestfailed', (r) => {
    net.inflight.delete(r);
    const t = r.failure()?.errorText || 'unknown';
    if (t === 'net::ERR_ABORTED') { net.aborted++; return; }
    net.failed[t] = (net.failed[t] || 0) + 1;
  });
  await page.goto(origin + '/');
  await page.waitForFunction(() => !!window.live);
  const run = async (name, ...args) => {
    const t0 = Date.now();
    const r = await page.evaluate(([f, a]) => window.live[f](...a), [name, args]);
    console.log(`[${name}] ${Date.now() - t0}ms`);
    results.flows[name] = r;
    return r;
  };

  // 1. bootstrap from the quorum service (cross-origin fetch from the page), then a height
  const boot = await run('bootstrap');
  check('node list fetched cross-origin from the quorum service (CORS) and a synced node answered', boot.ok && boot.nodes > 100 && boot.height > 2_560_000, boot);

  // 2. the old tx: merkle + height + X11 block hash + ~750-header X11 chain + BLS ChainLock + SML agreement
  const col = await run('verifiedCollateral');
  const c = col.cold;
  const exp = (await page.evaluate(() => window.live.expected));
  check('getVerifiedTransaction(collateral): chainLocked "verified", merkle ok, block hash X11-verified, height from coinbase',
    c.ok && c.chainLocked === 'verified' && c.height === exp.COLLATERAL_HEIGHT && c.blockHash === exp.COLLATERAL_BLOCK && c.proof.merkle && c.proof.blockHash === 'verified', c);
  check('  ...with an exact Core-selected quorum and >= 700 verified confirmations', c.ok && c.proof.chainLock?.exact === true && c.proof.chainLock.verifiedConfirmations >= 700 && c.proof.notes.length === 0, c.proof);
  // latency is dominated by which random nodes answer (a slow one costs seconds before failover), so timings are reported, not asserted
  check('  ...a warm second call (SML and quorum heights cached) is verified too', col.warm.ok && col.warm.chainLocked === 'verified' && col.warm.proof.chainLock?.exact === true, { coldMs: c.ms, warmMs: col.warm.ms });
  check('X11 and BLS were loaded lazily, once', col.loaded.x11 === 1 && col.loaded.bls === 1, col.loaded);

  // 3. recent confirmed tx and a coinbase
  const rec = await run('verifiedRecent');
  check('recent tx and coinbase: merkle + X11 verified, ChainLock verified', rec.ok && rec.plain.chainLocked === 'verified' && rec.coinbase.chainLocked === 'verified' && rec.plain.proof.merkle && rec.coinbase.proof.blockHash === 'verified', rec);

  // 4. unknown tx
  const nf = await run('notFound');
  check('unknown txid -> GrpcError NOT_FOUND (code 5)', !nf.ok && nf.error.code === 5, nf);

  // 5. SML agreement + node list refresh
  const sml = await run('sml');
  check('getSml: >= 2 of 3 nodes agree on tip, 4 LLMQ_400_60 quorums, 300+ evonodes', sml.ok && sml.agreedBy.length >= 2 && sml.asked.length >= 3 && sml.quorums400 === 4 && sml.evonodes > 300, sml);
  check('refreshNodesFromSml appends the SML evonodes to the pool', sml.ok && sml.poolAfter > sml.poolBefore, sml);

  // 6. watchers
  const wn = await run('watchNoDeposit');
  // a bad-cert node among the 3 is replaced from the pool ("stream-closed" errors are expected and reported, never fatal)
  check('watchAddressForDeposit: ready with >= 2 live streams of 3+ nodes, 200+ byte filter, no events for a random address, still 3 streams live after 4 s',
    wn.ok && wn.opened >= 3 && wn.liveAtReady >= 2 && wn.filterBytes >= 200 && wn.events.tx === 0 && wn.events.locks === 0 && wn.events.errors.every((e) => e.startsWith('stream-closed')) && wn.liveDuring >= 2, wn);
  check('  ...merkleblock heartbeats arrive without any match', wn.ok && wn.events.blocks >= 1, wn.events);
  const wp = await run('watchPositive');
  check('watch positive control: the collateral tx is delivered exactly once across 3 merged streams', wp.ok && wp.found && wp.distinctTxids === wp.deliveries, wp);
  const wi = await run('watchIsLock');
  check('IS-lock path: >= 1 live ISDLOCK received, parsed (96 B sig), delivered once per distinct lock, after its tx', wi.ok && wi.gotIsLock && wi.distinctLocks === wi.deliveredLocks && wi.locks.every((l) => l.sigBytes === 96) && wi.allKnown && wi.dupTxDeliveries === 0, wi);
  check('  ...merged streams suppressed duplicates from other nodes', wi.ok && wi.dupes > 0 && wi.opened >= 3, { dupes: wi.dupes, opened: wi.opened });
  results.flows.bloom = await run('bloom');
  check('bloom filter built in the browser: >= 200 bytes, contains its element', results.flows.bloom.bytes >= 200 && results.flows.bloom.contains, results.flows.bloom);

  // 7. budget + nothing left running
  await new Promise((r) => setTimeout(r, 1500));
  const perMinute = Object.fromEntries(Object.entries(net.perHost).map(([h, ts]) => {
    let max = 0; for (let i = 0, j = 0; i < ts.length; i++) { while (ts[i] - ts[j] > 60_000) j++; max = Math.max(max, i - j + 1); }
    return [h, max];
  }));
  const maxPerMin = Math.max(0, ...Object.values(perMinute));
  results.network = { dapiRequests: net.dapiRequests, hosts: Object.keys(net.perHost).length, maxRequestsPerHostPerMinute: maxPerMin, abortedByClient: net.aborted, failedByReason: net.failed, inflightAtEnd: net.inflight.size, nonDapiRequests: net.nonDapi };
  check('no host received more than 150 requests in any 60 s window (including HTTP preflights counted as requests)', maxPerMin <= 150, perMinute);
  check('no DAPI request left in flight after every watcher/stream was cancelled', net.inflight.size === 0, [...net.inflight].map((r) => r.url()));
  check('the page only talked to DAPI nodes and the quorum service', net.nonDapi.every((u) => u.startsWith('https://quorums.mainnet.networks.dash.org/')), net.nonDapi);
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
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; results -> test/live/results.json`);
process.exit(failed.length ? 1 : 0);
