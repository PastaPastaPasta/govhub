// X11 benchmark: WASM x11Many / per-call x11 vs the pure-JS oracle, in Node and (unless --no-browser) in a Web Worker in headless Chromium.
//   node scripts/bench-x11.mjs            Node + Chromium; writes test/x11-bench.json
//   node scripts/bench-x11.mjs --no-browser
// The Chromium part bundles a worker with esbuild, serves it from http://127.0.0.1:<port> (started and stopped in this foreground process)
// and drives headless Chromium with playwright. Under the Claude sandbox Chromium and the local socket need dangerouslyDisableSandbox.
import http from 'node:http';
import os from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist/bench');
mkdirSync(dist, { recursive: true });
const noBrowser = process.argv.includes('--no-browser');

// The measured code, identical in Node and the worker. `x11mod` / `oracle` are the two modules.
const N_MANY = 50_000, N_CALL = 10_000, N_JS = 2_000;
const benchSrc = `
import { x11, x11Many } from ${JSON.stringify(join(root, 'src/x11.ts'))};
import { digest } from ${JSON.stringify(join(root, 'src/vendor/x11/x11.js'))};
const now = () => performance.now();
function headers(n) { // deterministic pseudo-random 80-byte headers
  const out = new Uint8Array(n * 80); let s = 12345;
  for (let i = 0; i < out.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = s >>> 24; }
  return out;
}
const rate = (n, ms) => ({ headers: n, ms: +ms.toFixed(1), headersPerSec: Math.round(n / (ms / 1000)), usPerHeader: +((ms * 1000) / n).toFixed(2) });
export function run() {
  const all = headers(${N_MANY});
  let t = now(); x11(all.subarray(0, 80)); const coldMs = now() - t; // base64 decode + compile + instantiate + one hash
  const out = {};
  // warm, then take the best of 5 (median-ish noise on a shared machine is large; the best run is the machine's capability)
  x11Many(all.subarray(0, 80 * 1000));
  const runs = [];
  for (let r = 0; r < 5; r++) { t = now(); x11Many(all); runs.push(now() - t); }
  out.wasmMany = { ...rate(${N_MANY}, Math.min(...runs)), allRunsMs: runs.map((x) => +x.toFixed(1)) };
  const calls = [];
  for (let r = 0; r < 3; r++) { t = now(); for (let i = 0; i < ${N_CALL}; i++) x11(all.subarray(i * 80, i * 80 + 80)); calls.push(now() - t); }
  out.wasmPerCall = rate(${N_CALL}, Math.min(...calls));
  const js = [];
  for (let r = 0; r < 2; r++) {
    t = now();
    for (let i = 0; i < ${N_JS}; i++) digest(Array.from(all.subarray(i * 80, i * 80 + 80)));
    js.push(now() - t);
  }
  out.jsOracle = rate(${N_JS}, Math.min(...js));
  out.coldFirstCallMs = +coldMs.toFixed(2);
  out.speedupManyVsJs = +(out.wasmMany.headersPerSec / out.jsOracle.headersPerSec).toFixed(1);
  // sanity: the batch result equals the oracle on a sample
  const many = x11Many(all.subarray(0, 80 * 50));
  let ok = true;
  for (let i = 0; i < 50 && ok; i++) { const want = digest(Array.from(all.subarray(i * 80, i * 80 + 80))); for (let j = 0; j < 32; j++) if (many[i * 32 + j] !== want[j]) ok = false; }
  out.matchesOracle = ok;
  return out;
}
`;

async function bundle(entry, format, outfile) {
  await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, minify: true, format, platform: format === 'esm' ? 'node' : 'browser', target: 'es2022', outfile, logLevel: 'warning' });
}

const result = { date: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model, arch: process.arch, platform: process.platform };

// ---- Node ----
await bundle(`${benchSrc}`, 'esm', join(dist, 'node-bench.mjs'));
const nodeMod = await import(pathToFileURL(join(dist, 'node-bench.mjs')).href);
result.node_results = nodeMod.run();
console.log('node', JSON.stringify(result.node_results));

// ---- Chromium Web Worker ----
if (!noBrowser) {
  await bundle(`${benchSrc}\nself.onmessage = () => { try { self.postMessage({ ok: true, r: run() }); } catch (e) { self.postMessage({ ok: false, error: String(e && e.stack || e) }); } };`, 'iife', join(dist, 'worker.js'));
  const html = '<!doctype html><meta charset=utf-8><title>x11 bench</title>';
  const server = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0];
    if (p === '/worker.js') res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(readFileSync(join(dist, 'worker.js')));
    else if (p === '/') res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    else res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const guard = setTimeout(() => { console.error('global timeout'); process.exit(2); }, 5 * 60 * 1000);
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
    await page.goto(origin + '/');
    const wall0 = Date.now();
    const r = await page.evaluate(() => new Promise((resolve) => {
      const w = new Worker('/worker.js');
      w.onmessage = (e) => resolve(e.data);
      w.onerror = (e) => resolve({ ok: false, error: String(e.message) });
      w.postMessage(1);
    }));
    result.chromium_wall_ms_including_all_reps = Date.now() - wall0;
    if (!r.ok) throw new Error('worker failed: ' + r.error);
    result.chromium_version = browser.version();
    result.chromium_worker_results = r.r;
    console.log('chromium worker', JSON.stringify(r.r));
  } finally {
    clearTimeout(guard);
    await browser?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

writeFileSync(join(root, 'test/x11-bench.json'), JSON.stringify(result, null, 2) + '\n');
console.log('wrote test/x11-bench.json');
