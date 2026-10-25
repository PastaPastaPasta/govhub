// Measures what proposal-page verification costs across navigations in ONE browser profile (IndexedDB survives between steps):
// a recent proposal, an old one, the same old one again, a different old one, then a reload. Headless Chromium, persistent context.
//
//   node scripts/measure-verify-cache.mjs [--base https://gov.dashhq.org] [--out results/verify-cache.json] [--steps recent,old,old,older,reload] [--gap 65]
//
// Per step it records: wall time to the collateral verdict and to the chain facts, the anchor stats the chain report carries
// (cachedHeaders, fetchedHeaders, ms), every "Downloading N block headers" progress line the worker posted, bytes received per host
// (DAPI grpc-web, bridge, proof source), and what the verification database holds afterwards (scope, lo..hi, MB).
// Read-only: it opens pages and reads; it never signs or sends anything. Mainnet (Dev profile: mainnet Core data).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg('base', 'https://gov.dashhq.org').replace(/\/+$/, '');
const OUT = arg('out', '');
const PROPOSALS = {
  recent: { name: 'Optional-Content-Control', govHash: '7f1ac941caba970d6940bcfee3886a7c3790d86d58c259837881c74b9c9cf9ce' }, // collateral 2,560,804
  old: { name: 'GEG-PPP-30M-Film-On-Chain', govHash: 'e1cd4d7f9160427e' }, // 2,448,904 (~112k blocks deep on 2026-10-25)
  older: { name: 'Dash-Italia-Management-2026', govHash: 'ce46b7dc4fba25c6' }, // 2,409,375 (~152k deep)
};
const STEPS = arg('steps', 'recent,old,old,older,reload').split(',');
/** Seconds to stay on each page before the next step (a reader's minute: the in-memory anchor is reused for 60 s). */
const GAP_S = Number(arg('gap', '0'));

/** Full govHashes from the bridge (the table above keeps prefixes short). */
async function resolveHashes() {
  const r = await fetch('https://gov-bridge.dashhq.org/v1/proposals');
  const { proposals } = await r.json();
  for (const p of Object.values(PROPOSALS)) {
    const hit = proposals.find((x) => x.govHash.startsWith(p.govHash));
    if (!hit) throw new Error(`proposal ${p.name} (${p.govHash}) is not listed by the bridge any more`);
    p.govHash = hit.govHash;
    p.collateralHeight = hit.collateralHeight;
  }
}

const profileDir = mkdtempSync(join(tmpdir(), 'govhub-measure-'));
const context = await chromium.launchPersistentContext(profileDir, { headless: true, viewport: { width: 1280, height: 900 } });
let bytes = new Map();
context.on('requestfinished', (req) => {
  void req.sizes().then((s) => {
    const host = new URL(req.url()).host;
    bytes.set(host, (bytes.get(host) ?? 0) + s.responseBodySize + s.responseHeadersSize);
  }, () => {});
});

/** Worker posts (progress lines and results), recorded inside the worker so nothing is missed between polls. */
async function hookWorker(page) {
  const workers = [];
  page.on('worker', (w) => {
    workers.push(w);
    void w.evaluate(() => {
      const g = self;
      if (g.__log) return;
      g.__log = [];
      g.__bytes = {};
      g.__paths = {};
      // body bytes per host, counted as the worker reads them (grpc-web streams are cancelled, so the browser's own counters miss them)
      const f = g.fetch.bind(g);
      g.fetch = async (input, init) => {
        const res = await f(input, init);
        const host = new URL(typeof input === 'string' ? input : input.url).host;
        if (!res.body) return res;
        const u = new URL(typeof input === 'string' ? input : input.url);
        const key = /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(host) ? `dapi ${u.pathname.split('/').pop()}` : `${host}${u.pathname.replace(/[0-9a-f]{64}/, ':hash')}`;
        const body = res.body.pipeThrough(new TransformStream({ transform(chunk, c) { g.__bytes[host] = (g.__bytes[host] ?? 0) + chunk.byteLength; g.__paths[key] = (g.__paths[key] ?? 0) + chunk.byteLength; c.enqueue(chunk); } }));
        return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
      };
      const post = g.postMessage.bind(g);
      g.postMessage = (m, ...rest) => {
        g.__log.push({ t: Date.now(), m: m.kind === 'progress' ? { kind: 'progress', message: m.message } : m.kind === 'chain' ? { kind: 'chain', anchor: m.report.anchor } : m.kind === 'anchor' ? { kind: 'anchor', anchor: m.anchor } : { kind: m.kind } });
        return post(m, ...rest);
      };
    }).catch(() => {});
  });
  return async () => {
    const log = [], bytes = {}, paths = {};
    for (const w of workers) {
      const r = await w.evaluate(() => { const b = self.__bytes, p = self.__paths; self.__bytes = {}; self.__paths = {}; return { log: self.__log.splice(0), bytes: b, paths: p }; }).catch(() => null);
      if (!r) continue;
      log.push(...r.log);
      for (const [k, n] of Object.entries(r.paths)) paths[k] = (paths[k] ?? 0) + n;
      for (const [h, n] of Object.entries(r.bytes)) bytes[h] = (bytes[h] ?? 0) + n;
    }
    return { log, bytes, paths };
  };
}

async function dbSummary(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('govhub-verify');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      const out = {};
      if (!db.objectStoreNames.contains('chains')) return resolve(out);
      const tx = db.transaction('chains', 'readonly');
      const st = tx.objectStore('chains');
      const c = st.openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return;
        const v = cur.value;
        const bytes = (v.hashes?.length ?? 0) + (v.segments ?? []).reduce((n, s) => n + s.hashes.length, 0);
        out[cur.key] = {
          lo: v.lo, hi: v.lo !== undefined && v.hashes ? v.lo + v.hashes.length / 32 - 1 : undefined, mb: +(bytes / 1e6).toFixed(2),
          ...(v.segments ? { segments: v.segments.map((s) => `${s.lo}..${s.pin}`) } : {}),
        };
        cur.continue();
      };
      tx.oncomplete = () => { db.close(); resolve(out); };
    };
  }));
}

async function step(page, drain, label, p, reload = false) {
  bytes = new Map();
  const t0 = Date.now();
  if (reload) await page.reload();
  else if (!page.url().startsWith(BASE)) await page.goto(`${BASE}/p/h/${p.govHash}`);
  else {
    // in-app navigation (what a click does): the page and its verification worker stay
    await page.evaluate((path) => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `/p/h/${p.govHash}`);
  }
  await page.getByRole('heading', { level: 1, name: p.name }).waitFor({ timeout: 60_000 });
  const drawer = page.getByTestId('verify-drawer');
  if (!(await drawer.isVisible())) await page.getByTestId('trust-badge').click({ timeout: 60_000 });
  await drawer.waitFor();
  const collateral = drawer.getByTestId('collateral-check').locator('[data-verdict]');
  await collateral.waitFor({ state: 'attached', timeout: 600_000 });
  const tCollateral = Date.now() - t0;
  const chain = drawer.getByTestId('chain-check').locator('[data-chain]');
  await chain.waitFor({ state: 'attached', timeout: 600_000 });
  const tChain = Date.now() - t0;
  // let the payments and vote recount settle: they anchor too
  await page.waitForTimeout(8000);
  const { log, bytes: wb, paths } = await drain();
  const kb = (n) => Math.round(n / 1024);
  const dapiHost = (h) => /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(h);
  const sum = (f) => Object.entries(wb).filter(([h]) => f(h)).reduce((n, [, b]) => n + b, 0);
  const workerKb = { dapi: kb(sum(dapiHost)), ...Object.fromEntries(Object.entries(wb).filter(([h]) => !dapiHost(h)).map(([h, b]) => [h, kb(b)])) };
  const downloads = log.filter((e) => e.m.kind === 'progress' && /Downloading [\d,]+ block headers/.test(e.m.message)).map((e) => e.m.message.match(/([\d,]+)/)[1]);
  const anchors = log.filter((e) => e.m.kind === 'chain' || e.m.kind === 'anchor').map((e) => ({ kind: e.m.kind, lo: e.m.anchor.lo, tip: e.m.anchor.tip, trust: e.m.anchor.trust.kind, source: e.m.anchor.trust.source, headers: e.m.anchor.headers, ms: e.m.anchor.ms }));
  const r = {
    step: label, proposal: p.name, collateralHeight: p.collateralHeight, tCollateralMs: tCollateral, tChainMs: tChain,
    verdict: await collateral.getAttribute('data-verdict'), chain: await chain.getAttribute('data-chain'),
    chainReport: { headers: JSON.parse((await chain.getAttribute('data-headers')) ?? 'null'), ms: JSON.parse((await chain.getAttribute('data-ms')) ?? 'null') },
    headerDownloads: downloads, anchors,
    workerKb, workerKbByPath: Object.fromEntries(Object.entries(paths).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, Math.round(n / 1024)])), workerKbTotal: kb(Object.values(wb).reduce((a, b) => a + b, 0)),
    pageKb: kb([...bytes.values()].reduce((a, b) => a + b, 0)),
    db: await dbSummary(page),
  };
  console.log(JSON.stringify(r));
  return r;
}

try {
  await resolveHashes();
  const page = await context.newPage();
  const drain = await hookWorker(page);
  const results = [];
  let last = null;
  for (const [i, s] of STEPS.entries()) {
    if (i > 0 && GAP_S > 0) await page.waitForTimeout(GAP_S * 1000);
    if (s === 'reload') results.push(await step(page, drain, 'reload', last, true));
    else {
      last = PROPOSALS[s];
      results.push(await step(page, drain, s, last));
    }
  }
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ base: BASE, ranAt: new Date().toISOString(), results }, null, 2) + '\n');
  }
} finally {
  await context.close();
  rmSync(profileDir, { recursive: true, force: true });
}
