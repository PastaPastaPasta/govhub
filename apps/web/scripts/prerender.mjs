// Static entry pages for the app's routes, written into dist/ after `vite build`. GitHub Pages answers `/past` with past.html
// and `/p/<name>` with p/<name>.html (200, no redirect), so a shared link gets its own title, description and share tags
// while the app itself is unchanged: every file is index.html with a different <head>. Proposals and name contests are
// listed from public reads at build time (the bridge's HTTP API and Platform, Mainnet), and so is every masternode
// (/masternodes/<proTxHash>, from the bridge's list). A name contest also gets an entry page under each spelling people write
// (/names/Alice and /names/alice for /names/a11ce, canonical to the label's). Each proposal's linked page is read too, for what its owner says it is
// (scripts/ownerpages.mjs, shipped as owners.json, never fetched by the browser). A route that appears after the
// build still loads, through 404.html with HTTP 404, until the next build (the Pages workflow rebuilds on a schedule).
//
// Usage: node scripts/prerender.mjs [distDir]. Env: GOVHUB_SITE_URL (canonical origin, default https://gov.dashhq.org),
// GOVHUB_BASE (as for the build), GOVHUB_PRERENDER_BRIDGE, GOVHUB_PRERENDER_OFFLINE=1 (static routes only).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDash, formatDate, formatDateTime, formatInt } from '../src/lib/format.ts';
import { parseGovParams, paymentSchedule, perPayment } from '../src/lib/governance.ts';
import { isShortLink } from '../src/lib/shorteners.ts';
import { contestAliases, DPNS_CONTRACT_ID, DPNS_POLL, normalizeLabel, PARENT_DOMAIN, registersAs } from '../src/contests/model.ts';
import { governanceObjectHash, parseProposalData } from '@govhub/verify';
import { ownerPages } from './ownerpages.mjs';

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
/** Untrusted epochs a description may use: from 2014 (Dash governance) to 2100, so date formatting and schedules stay bounded. */
const sane = (t) => Number.isSafeInteger(t) && t > 1_388_534_400 && t < 4_102_444_800;
/** Every public read together; a listing that takes longer is skipped (its links still load through 404.html). */
const DATA_MS = 120_000;
/** Tags this script adds: dropped from the template first, so running it again on a built dist doesn't add them twice. */
const OURS = /\n\s*<(?:link rel="canonical"|meta (?:property="og:|name="twitter:|name="robots"))[^>]*>/g;

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
    .replace(OURS, '')
    .replace(/<title>[^<]*<\/title>/, () => `<title>${t}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, () => `<meta name="description" content="${d}" />\n    ${tags}`);
  if (!out.includes(`<title>${t}</title>`) || !out.includes(tags)) throw new Error('index.html has no <title> or description meta to replace');
  return out;
}

async function getJson(url, ms = 20_000) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** The bridge reported the very link the network votes on: its fields hash to the governance hash, and the hashed data has this name and URL. */
function committedLink(p) {
  try {
    if (governanceObjectHash({ parentHash: p.parentHash, revision: p.revision, time: p.time, dataHex: p.dataHex }).display !== p.govHash.toLowerCase()) return false;
    const f = parseProposalData(p.dataHex).fields;
    return !!f && f.name === p.name && f.url === p.url;
  } catch {
    return false;
  }
}

/** The bridge's active and past proposals (untrusted, like every share preview: the page itself checks). */
async function proposals() {
  const [active, past, cycleRes] = await Promise.all([getJson(`${bridge}/v1/proposals?state=active`), getJson(`${bridge}/v1/proposals?state=past`), getJson(`${bridge}/v1/cycle`)]);
  // a cycle shorter than an hour of blocks or an implausible estimate would make the schedule meaningless (and long to compute)
  const p = parseGovParams(cycleRes?.governance);
  const params = p && p.superblockCycle >= 24 ? p : null;
  const cycle = sane(cycleRes?.cycle?.estTime) ? cycleRes.cycle : null;
  const rows = [];
  const seen = new Set();
  for (const [state, list] of [['active', active?.proposals], ['past', past?.proposals]]) {
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || typeof p.name !== 'string' || !SAFE_NAME.test(p.name) || typeof p.govHash !== 'string' || !HASH.test(p.govHash)) continue;
      if (!Number.isSafeInteger(p.paymentAmount) || !sane(p.startEpoch) || !sane(p.endEpoch) || seen.has(p.govHash)) continue;
      seen.add(p.govHash);
      rows.push({ state, name: p.name, govHash: p.govHash, url: typeof p.url === 'string' ? p.url : '', committed: committedLink(p), amount: p.paymentAmount, startEpoch: p.startEpoch, endEpoch: p.endEpoch, tally: p.tally ?? null, params, cycle });
    }
  }
  return rows;
}

const kindOf = (p) => (p.state === 'active' ? 'Dash treasury proposal' : 'Past Dash treasury proposal');

function describeProposal(p) {
  try {
    return describeProposalOrThrow(p);
  } catch (e) {
    console.warn(`prerender: ${p.name}: ${e.message}; a plain description instead`);
    return `${kindOf(p)} ${p.name}: what it asks for and how masternodes vote.`;
  }
}

function describeProposalOrThrow(p) {
  const sched = p.params && p.cycle ? paymentSchedule(p, p.cycle, p.params, now) : null;
  const ask = sched?.oneTime ? `${formatDash(p.amount)} in one payment` : `${formatDash(p.amount)} ${p.params ? perPayment(p.params) : 'per payment'}${sched?.total ? ` for ${formatInt(sched.total)} payment${sched.total === 1 ? '' : 's'}` : ''}`;
  const window = `${formatDate(p.startEpoch)} to ${formatDate(p.endEpoch)}`;
  const t = p.tally;
  const votes = t && [t.yesWeighted, t.noWeighted, t.abstainWeighted].every(Number.isSafeInteger)
    ? ` Masternode votes on ${formatDate(now)}: ${formatInt(t.yesWeighted)} yes, ${formatInt(t.noWeighted)} no, ${formatInt(t.abstainWeighted)} abstain.`
    : '';
  return `${kindOf(p)} asking ${ask}, ${window}.${votes}`;
}

let mainnet;
/** One Mainnet SDK for the contest reads (proof-checked by evo-sdk). */
function mainnetSdk() {
  mainnet ??= import('@dashevo/evo-sdk').then(async ({ EvoSDK }) => {
    const sdk = EvoSDK.mainnetTrusted({ settings: { timeoutMs: 20_000, retries: 2 } });
    await sdk.connect();
    return sdk;
  });
  return mainnet;
}

/** Every contested username on Mainnet Platform (proof-checked by evo-sdk), and when the open ones close. */
async function contests() {
  const sdk = await mainnetSdk();
  const poll = DPNS_POLL;
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

/**
 * How people spell each contested name, read from Mainnet: the name as registered (an awarded contest) and, for an open contest, each
 * contender's own spelling. `/names/Alice` and `/names/alice` then get an entry page of their own that names `/names/a11ce` as
 * canonical, instead of answering 404 until the app rewrites the address. Labels with no known spelling keep their normalized page only.
 */
async function spellings(cs) {
  const sdk = await mainnetSdk();
  const out = new Map(cs.map((c) => [c.label, []]));
  const add = (label, s) => {
    if (typeof s === 'string' && out.has(label) && normalizeLabel(s) === label && !out.get(label).includes(s)) out.get(label).push(s);
  };
  const labels = [...out.keys()];
  // a registered name per label at most (the index is unique), so a hundred labels fit one page
  for (let i = 0; i < labels.length; i += 100) {
    const chunk = labels.slice(i, i + 100);
    const res = await sdk.documents.queryWithProof({
      dataContractId: DPNS_CONTRACT_ID,
      documentTypeName: DPNS_POLL.documentTypeName,
      where: [['normalizedParentDomainName', '==', PARENT_DOMAIN], ['normalizedLabel', 'in', chunk]],
      orderBy: [['normalizedLabel', 'asc']],
      limit: 100,
    });
    for (const d of res.data.values()) {
      const j = d?.toJSON();
      add(j?.normalizedLabel, j?.label);
    }
  }
  const openOnes = cs.filter((c) => c.endsAt !== null);
  if (openOnes.length) {
    const [mod, contract] = await Promise.all([import('@dashevo/evo-sdk'), sdk.contracts.fetch(DPNS_CONTRACT_ID)]);
    const version = sdk.version();
    for (const c of openOnes) {
      const st = await sdk.voting.contestedResourceVoteStateWithProof({ ...DPNS_POLL, indexValues: [PARENT_DOMAIN, c.label], resultType: 'documentsAndVoteTally', limit: 100 }).catch(() => null);
      // the leading contender's spelling first, as the page shows it
      const contenders = Array.from(st?.data?.contenders ?? []).sort((a, b) => Number(b.voteTally ?? 0) - Number(a.voteTally ?? 0));
      for (const x of contenders) {
        if (!x.serializedDocument) continue;
        try {
          add(c.label, mod.Document.fromBytes(x.serializedDocument, contract, DPNS_POLL.documentTypeName, version).properties?.label);
        } catch {
          // an undecodable document: no spelling from it
        }
      }
    }
  }
  return out;
}

/** Every masternode in the bridge's list (untrusted, like the proposals: the page reads its own data). */
async function masternodes() {
  const list = await getJson(`${bridge}/v1/mnlist`, 60_000);
  const out = [];
  // an untrusted list: bounded well above the real network (about 3,000) so it can't flood the build
  for (const m of (Array.isArray(list?.masternodes) ? list.masternodes : []).slice(0, 10_000)) {
    if (!m || typeof m.proTxHash !== 'string' || !HASH.test(m.proTxHash.toLowerCase())) continue;
    out.push({ proTx: m.proTxHash.toLowerCase(), evo: m.type === 'evo' });
  }
  return out;
}

const isShortener = (u) => isShortLink(u.hostname);

/**
 * Where a shortened link leads: its redirects followed by hand (a HEAD, or a GET whose body is dropped; never the page), at most five, http(s) only, until a host
 * that is not a shortener. Null when it doesn't resolve. Untrusted and dated: the page says when it was resolved and that it can change.
 */
async function resolveShort(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  for (let hop = 0; hop < 5 && isShortener(u); hop++) {
    let to = null;
    // shorteners refuse bursts now and then (403, 429): a few tries, a little apart
    for (let attempt = 0; attempt < 4 && !to; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
      // some shorteners refuse HEAD (shorturl.at answers it 403) but redirect a GET: its body is never read, only the Location
      for (const method of ['HEAD', 'GET']) {
        const res = await fetch(u, { method, redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'govhub-prerender/1 (+https://github.com/PastaPastaPasta/govhub)' } }).catch(() => null);
        res?.body?.cancel().catch(() => {});
        to = res && res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (to) break;
      }
    }
    if (!to) return null;
    try {
      u = new URL(to, u);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  }
  return isShortener(u) ? null : u.href;
}

/** Every shortened proposal link, four at a time, each given at most 30 s: what resolved is kept even if others don't. */
async function shortLinks(ps) {
  const out = {};
  const urls = [...new Set(ps.map((p) => p.url).filter((url) => { try { return isShortener(new URL(url)); } catch { return false; } }))];
  let next = 0;
  const work = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      let timer;
      const to = await Promise.race([resolveShort(url), new Promise((r) => (timer = setTimeout(() => r(null), 30_000)))]);
      clearTimeout(timer);
      if (to && to.length <= 2048) out[url] = to;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, work));
  return out;
}

const describeMasternode = (m, active) =>
  `How Dash ${m.evo ? 'evonode' : 'masternode'} ${m.proTx.slice(0, 8)}… voted on ${active ? `the ${formatInt(active)} active treasury proposals` : 'the active treasury proposals'}, and how to vote with it.`;

function describeContest(c, shown) {
  const as = registersAs(shown, c.label);
  const name = as ? `${shown}.dash (registers as ${as}.dash)` : `${shown}.dash`;
  return c.endsAt
    ? `Who wants the Dash username ${name} and how masternodes are voting. Voting closes ${formatDateTime(Math.floor(c.endsAt / 1000))}.`
    : `The masternode vote over the Dash username ${name}: who wanted it and how the vote ended.`;
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
  let timer;
  try {
    return await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${DATA_MS / 1000} s`)), DATA_MS)))]);
  } catch (e) {
    console.warn(`prerender: ${what} not listed (${e.message}); their links still load through 404.html`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const template = await fs.readFile(path.join(dist, 'index.html'), 'utf8');
await write('/404', head(template, { route: '/404', record: 'Page not found', description: meta.routes['/'].description, noindex: true }));
for (const [route, m] of Object.entries(meta.routes)) {
  await write(route, head(template, { route, record: m.title, description: m.description }));
}

const [ps, cs, ms] = await Promise.all([settle('proposals', proposals), settle('name contests', contests), settle('masternodes', masternodes)]);
const links = offline ? {} : await shortLinks(ps);
await fs.writeFile(path.join(dist, 'links.json'), JSON.stringify({ resolvedAt: now, links }));
let owners = { fetchedAt: now, pages: {} };
if (!offline) {
  let timer;
  try {
    // only a link the network committed to: the bridge's word alone picks no page to quote
    owners = await Promise.race([ownerPages(ps.filter((p) => p.committed), links), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${DATA_MS / 1000} s`)), DATA_MS)))]);
  } catch (e) {
    console.warn(`prerender: owner pages not read (${e.message})`);
  } finally {
    clearTimeout(timer);
  }
}
await fs.writeFile(path.join(dist, 'owners.json'), JSON.stringify(owners));
const sameName = new Map();
for (const p of ps) sameName.set(p.name, (sameName.get(p.name) ?? 0) + 1);
for (const p of ps) {
  // the owner's title, quoted as theirs, ahead of what the network records: a shared link then says what the proposal is for
  const title = owners.pages[p.govHash]?.title;
  const description = `${title ? `“${title}” (the owner’s title). ` : ''}${describeProposal(p)}`;
  const canonical = `/p/h/${p.govHash}`;
  await write(canonical, head(template, { route: canonical, record: p.name, description }));
  // a shared name is a chooser page in the app; its own entry says so instead of describing one of them
  const shared = sameName.get(p.name);
  await write(`/p/${p.name}`, head(template, shared > 1
    ? { route: `/p/${p.name}`, record: p.name, description: `${formatInt(shared)} Dash treasury proposals are named ${p.name}. Pick one to see what it asks for and how masternodes voted.` }
    : { route: `/p/${p.name}`, record: p.name, description, canonical }));
}
const activeCount = ps.filter((p) => p.state === 'active').length;
for (const m of ms) {
  await write(`/masternodes/${m.proTx}`, head(template, { route: `/masternodes/${m.proTx}`, record: `Masternode ${m.proTx.slice(0, 6)}…${m.proTx.slice(-6)}`, description: describeMasternode(m, activeCount) }));
}
// a failed read leaves each contest its normalized page only
const spelled = new Map(cs.length ? await settle('name spellings', () => spellings(cs)) : []);
let aliases = 0;
for (const c of cs) {
  const known = spelled.get(c.label) ?? [];
  // the spelling the app heads the page with: the leading contender's, else the normalized label
  const shown = known[0] ?? c.label;
  const canonical = `/names/${c.label}`;
  const entry = { route: canonical, record: `${shown}.dash name contest`, description: describeContest(c, shown), canonical };
  await write(canonical, head(template, entry));
  // the same page under each spelling people write (and EvoVote's forwarding keeps): 200, naming the label's page as canonical
  for (const alias of contestAliases(c.label, known)) {
    await write(`/names/${alias}`, head(template, { ...entry, route: `/names/${alias}` }));
    aliases++;
  }
}
console.log(`prerender: ${Object.keys(links).length} short links resolved; ${Object.keys(owners.pages).length} owner pages read; ${written.size} entry pages (${ps.length} proposals, ${ms.length} masternodes, ${cs.length} name contests${cs.length ? `, ${cs.filter((c) => c.endsAt).length} open, ${aliases} spellings` : ''})${offline ? ', offline' : ''}`);
// evo-sdk keeps its connections open
process.exit(0);
