// Static entry pages for the app's routes, written into dist/ after `vite build`. GitHub Pages answers `/past` with past.html
// and `/p/<name>` with p/<name>.html (200, no redirect), so a shared link gets its own title, description and share tags
// while the app itself is unchanged: every file is index.html with a different <head>. Proposals and name contests are
// listed from public reads at build time (the bridge's HTTP API and Platform, Mainnet). A route that appears after the
// build still loads, through 404.html with HTTP 404, until the next build (the Pages workflow rebuilds on a schedule).
//
// Usage: node scripts/prerender.mjs [distDir]. Env: GOVHUB_SITE_URL (canonical origin, default https://gov.dashhq.org),
// GOVHUB_BASE (as for the build), GOVHUB_PRERENDER_BRIDGE, GOVHUB_PRERENDER_OFFLINE=1 (static routes only).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDash, formatDate, formatDateTime, formatInt } from '../src/lib/format.ts';
import { parseGovParams, paymentSchedule, perPayment } from '../src/lib/governance.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.argv[2] ?? path.join(here, '../dist'));
const meta = JSON.parse(await fs.readFile(path.join(here, '../src/app/routeMeta.json'), 'utf8'));
const base = (process.env.GOVHUB_BASE ?? '/').replace(/\/?$/, '/');
const site = (process.env.GOVHUB_SITE_URL ?? 'https://gov.dashhq.org').replace(/\/+$/, '');
const bridge = (process.env.GOVHUB_PRERENDER_BRIDGE ?? 'https://gov-bridge-mainnet.dashhq.org').replace(/\/+$/, '');
const offline = process.env.GOVHUB_PRERENDER_OFFLINE === '1';
const now = Math.floor(Date.now() / 1000);

/** Core's proposal names and DPNS's normalized labels: anything else never becomes a file name. */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_LABEL = /^[a-z0-9-]{3,63}$/;
const HASH = /^[0-9a-f]{64}$/;

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const title = (record) => (record ? `${record} · ${meta.product}` : meta.product);
const urlOf = (route) => site + base.replace(/\/$/, '') + (route === '/' ? '/' : route);

function head(template, { route, record, description, canonical = route, noindex = false }) {
  const t = esc(title(record));
  const d = esc(description);
  const tags = [
    noindex ? '<meta name="robots" content="noindex" />' : `<link rel="canonical" href="${esc(urlOf(canonical))}" />`,
    '<meta property="og:site_name" content="dashhq.org" />',
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    ...(noindex ? [] : [`<meta property="og:url" content="${esc(urlOf(canonical))}" />`]),
    `<meta property="og:image" content="${esc(urlOf('/icon-512.png'))}" />`,
    '<meta property="og:image:alt" content="The dashhq mark: two layers joined by an amber link" />',
    '<meta name="twitter:card" content="summary" />',
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
  ].join('\n    ');
  const out = template
    .replace(/<title>[^<]*<\/title>/, () => `<title>${t}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, () => `<meta name="description" content="${d}" />\n    ${tags}`);
  if (out === template || !out.includes(`<title>${t}</title>`) || !out.includes(tags)) throw new Error('index.html has no <title> or description meta to replace');
  return out;
}

async function getJson(url, ms = 20_000) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** The bridge's active and past proposals (untrusted, like every share preview: the page itself checks). */
async function proposals() {
  const [active, past, cycleRes] = await Promise.all([getJson(`${bridge}/v1/proposals?state=active`), getJson(`${bridge}/v1/proposals?state=past`), getJson(`${bridge}/v1/cycle`)]);
  const params = parseGovParams(cycleRes?.governance);
  const cycle = cycleRes?.cycle;
  const rows = [];
  for (const [state, list] of [['active', active?.proposals], ['past', past?.proposals]]) {
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || typeof p.name !== 'string' || !SAFE_NAME.test(p.name) || typeof p.govHash !== 'string' || !HASH.test(p.govHash)) continue;
      if (![p.paymentAmount, p.startEpoch, p.endEpoch].every(Number.isSafeInteger)) continue;
      rows.push({ state, name: p.name, govHash: p.govHash, amount: p.paymentAmount, startEpoch: p.startEpoch, endEpoch: p.endEpoch, tally: p.tally ?? null, params, cycle });
    }
  }
  return rows;
}

function describeProposal(p) {
  const sched = p.params && Number.isSafeInteger(p.cycle?.estTime) ? paymentSchedule(p, p.cycle, p.params, now) : null;
  const ask = sched?.oneTime ? `${formatDash(p.amount)} in one payment` : `${formatDash(p.amount)} ${p.params ? perPayment(p.params) : 'per payment'}${sched?.total ? ` for ${formatInt(sched.total)} payment${sched.total === 1 ? '' : 's'}` : ''}`;
  const window = `${formatDate(p.startEpoch)} to ${formatDate(p.endEpoch)}`;
  const t = p.tally;
  const votes = t && [t.yesWeighted, t.noWeighted, t.abstainWeighted].every(Number.isSafeInteger)
    ? ` Masternode votes on ${formatDate(now)}: ${formatInt(t.yesWeighted)} yes, ${formatInt(t.noWeighted)} no, ${formatInt(t.abstainWeighted)} abstain.`
    : '';
  return `${p.state === 'active' ? 'Dash treasury proposal' : 'Past Dash treasury proposal'} asking ${ask}, ${window}.${votes}`;
}

/** Every contested username on Mainnet Platform (proof-checked by evo-sdk), and when the open ones close. */
async function contests() {
  const { EvoSDK } = await import('@dashevo/evo-sdk');
  const sdk = EvoSDK.mainnetTrusted({ settings: { timeoutMs: 20_000, retries: 2 } });
  await sdk.connect();
  const poll = { dataContractId: 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec', documentTypeName: 'domain', indexName: 'parentNameAndLabel' };
  const open = new Map();
  let start = Date.now();
  for (let page = 0; page < 20; page++) {
    const res = await sdk.voting.votePollsByEndDateWithProof({ startTimeMs: start, startTimeIncluded: true, orderAscending: true, limit: 100 });
    let added = 0, polls = 0;
    for (const b of res.data) {
      const endsAt = Number(b.timestampMs);
      if (!Number.isFinite(endsAt)) continue;
      start = Math.max(start, endsAt);
      for (const v of Array.from(b.votePolls ?? [])) {
        polls++;
        const j = v.toJSON();
        const [parent, label] = j.indexValues ?? [];
        if (j.contractId !== poll.dataContractId || j.indexName !== poll.indexName || parent !== 'dash' || typeof label !== 'string') continue;
        if (!open.has(label)) added++;
        open.set(label, endsAt);
      }
    }
    if (polls < 100 || added === 0) break;
  }
  const labels = new Set(open.keys());
  let after;
  for (let page = 0; page < 100; page++) {
    const res = await sdk.group.contestedResourcesWithProof({ ...poll, startIndexValues: ['dash'], limit: 100, ...(after !== undefined ? { startAtValue: after, startAtValueIncluded: false } : {}) });
    const raw = Array.from(res.data ?? []);
    for (const l of raw) if (typeof l === 'string') labels.add(l);
    if (raw.length < 100 || typeof raw.at(-1) !== 'string') break;
    after = raw.at(-1);
  }
  return [...labels].filter((l) => SAFE_LABEL.test(l)).map((label) => ({ label, endsAt: open.get(label) ?? null }));
}

function describeContest(c) {
  return c.endsAt
    ? `Who wants the Dash username ${c.label}.dash and how masternodes are voting. Voting closes ${formatDateTime(Math.floor(c.endsAt / 1000))}.`
    : `The masternode vote over the Dash username ${c.label}.dash: who wanted it and how the vote ended.`;
}

const written = new Set();
async function write(route, html) {
  written.add(route);
  const file = route === '/' ? 'index.html' : `${route.slice(1)}.html`;
  const target = path.join(dist, file);
  if (!target.startsWith(dist + path.sep)) throw new Error(`refusing to write outside dist: ${route}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, html);
}

async function settle(what, fn) {
  if (offline) return [];
  try {
    return await fn();
  } catch (e) {
    console.warn(`prerender: ${what} not listed (${e.message}); their links still load through 404.html`);
    return [];
  }
}

const template = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
await write('/404', head(template, { route: '/404', record: 'Page not found', description: meta.routes['/'].description, noindex: true }));
for (const [route, m] of Object.entries(meta.routes)) {
  await write(route, head(template, { route, record: m.title, description: m.description }));
}

const [ps, cs] = await Promise.all([settle('proposals', proposals), settle('name contests', contests)]);
const sameName = new Map();
for (const p of ps) sameName.set(p.name, (sameName.get(p.name) ?? 0) + 1);
for (const p of ps) {
  const description = describeProposal(p);
  const canonical = `/p/h/${p.govHash}`;
  await write(canonical, head(template, { route: canonical, record: p.name, description }));
  // a shared name is a chooser page in the app; its own entry says so instead of describing one of them
  const shared = sameName.get(p.name);
  await write(`/p/${p.name}`, head(template, shared > 1
    ? { route: `/p/${p.name}`, record: p.name, description: `${formatInt(shared)} Dash treasury proposals are named ${p.name}. Pick one to see what it asks for and how masternodes voted.` }
    : { route: `/p/${p.name}`, record: p.name, description, canonical }));
}
for (const c of cs) {
  await write(`/names/${c.label}`, head(template, { route: `/names/${c.label}`, record: `${c.label}.dash name contest`, description: describeContest(c) }));
}
console.log(`prerender: ${written.size} entry pages (${ps.length} proposals, ${cs.length} name contests${cs.length ? `, ${cs.filter((c) => c.endsAt).length} open` : ''})${offline ? ', offline' : ''}`);
// evo-sdk keeps its connections open
process.exit(0);
