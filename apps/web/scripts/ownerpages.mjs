// What each proposal's owner says on the page it links to, read at build time (scripts/prerender.mjs writes the result as
// dist/owners.json). The browser never fetches these pages, so the CSP stays as it is. Proposal links are untrusted on-chain data:
// http(s) only, no credentials, no IP literals or local names, every redirect hop checked again, size and time bounded.
// A page that can't be read or doesn't match is left out with one warning.
import { isShortLink } from '../src/lib/shorteners.ts';
import { parseOwnerPage } from '../src/lib/ownerPages.ts';

const UA = 'govhub-prerender/1 (+https://github.com/PastaPastaPasta/govhub)';
const MAX_BYTES = 2 * 1024 * 1024;
const GAP_MS = 300;
const TOTAL_MS = 100_000;
const DASHCENTRAL = new Set(['dashcentral.org', 'www.dashcentral.org']);

/** A URL this build may fetch: http(s), no userinfo, a real DNS name (not an IP literal, localhost, *.local or *.internal). */
function safeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || raw.length > 2048) return null;
  if (h.startsWith('[') || /^[\d.]+$/.test(h) || !h.includes('.')) return null;
  if (h === 'localhost' || /\.(?:localhost|local|internal)$/.test(h)) return null;
  return u;
}

const nextSlot = new Map();
/** At least GAP_MS between two requests to one host. */
async function polite(host) {
  const at = Math.max(Date.now(), nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + GAP_MS);
  if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
}

async function readCapped(res) {
  const type = res.headers.get('content-type') ?? '';
  let decoder;
  try {
    const cs = /charset=["']?([\w-]+)/i.exec(type)?.[1];
    decoder = new TextDecoder(cs ?? 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  const chunks = [];
  let size = 0;
  const reader = res.body.getReader();
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value.subarray(0, MAX_BYTES - size));
    size += chunks.at(-1).length;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return decoder.decode(all);
}

/** The page at `url` as HTML text and where it ended up; throws with the reason. Redirects are followed by hand, each hop checked. */
async function getPage(url, signal) {
  let u = safeUrl(url);
  for (let hop = 0; hop < 6; hop++) {
    if (!u) throw new Error('not a fetchable http(s) address');
    await polite(u.hostname);
    const res = await fetch(u, {
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: { 'user-agent': UA, accept: 'text/html' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      res.body?.cancel().catch(() => {});
      try {
        u = safeUrl(new URL(res.headers.get('location'), u).href);
      } catch {
        u = null;
      }
      continue;
    }
    if (res.status !== 200) {
      res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'text/html' && type !== 'application/xhtml+xml') {
      res.body?.cancel().catch(() => {});
      throw new Error(`content-type ${type || 'missing'}`);
    }
    return { html: await readCapped(res), url: u.href };
  }
  throw new Error('too many redirects');
}

async function read(p, target, signal) {
  const { html, url } = await getPage(target, signal);
  return parseOwnerPage(html, { url, name: p.name, govHash: p.govHash });
}

async function ownerPage(p, links, signal) {
  let target = p.url;
  let u = safeUrl(target);
  if (u && isShortLink(u.hostname)) {
    target = links[p.url];
    if (!target) throw new Error('short link not resolved');
    u = safeUrl(target);
  }
  if (!u) throw new Error('no fetchable link');
  let page = await read(p, u.href, signal);
  if (!page && DASHCENTRAL.has(u.hostname.toLowerCase())) {
    // a slug DashCentral doesn't know (or its front page): its page for this governance name, if it has one
    const own = `https://www.dashcentral.org/p/${encodeURIComponent(p.name)}`;
    if (own !== u.href) page = await read(p, own, signal);
  }
  if (!page) throw new Error('no match or nothing usable');
  return page;
}

/** One summary per proposal whose linked page could be read, keyed by govHash; four at a time, the whole step bounded. */
export async function ownerPages(ps, links) {
  const pages = {};
  const todo = ps.filter((p) => p && typeof p.url === 'string' && p.url);
  const signal = AbortSignal.timeout(TOTAL_MS);
  let next = 0;
  const work = async () => {
    while (next < todo.length && !signal.aborted) {
      const p = todo[next++];
      try {
        pages[p.govHash.toLowerCase()] = await ownerPage(p, links ?? {}, signal);
      } catch (e) {
        console.warn(`prerender: owner page of ${p.name}: ${e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : (e?.message ?? e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, work));
  return { fetchedAt: Math.floor(Date.now() / 1000), pages };
}
