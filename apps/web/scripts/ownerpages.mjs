// What each proposal's owner says on the page it links to, read at build time (scripts/prerender.mjs writes the result as
// dist/owners.json). The browser never fetches these pages, so the CSP stays as it is. Proposal links are untrusted on-chain data:
// http(s) on the default port only, no credentials, no IP literals or local names, and every name resolved here and refused when
// any of its addresses is not public; the connection goes to the address that was checked (no second lookup to rebind). Every
// redirect hop is checked again; size and time are bounded. A page that can't be read or doesn't match is left out with one warning.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { isShortLink } from '../src/lib/shorteners.ts';
import { isDashCentral, parseOwnerPage } from '../src/lib/ownerPages.ts';

const UA = 'govhub-prerender/1 (+https://github.com/PastaPastaPasta/govhub)';
const MAX_BYTES = 2 * 1024 * 1024;
const GAP_MS = 300;
const TOTAL_MS = 100_000;
/** A URL this build may fetch: http(s) on its default port, no userinfo, a DNS name (not an IP literal or a local name). */
function safeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port || raw.length > 2048) return null;
  const h = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (h.startsWith('[') || /^[\d.]+$/.test(h) || /^0x/i.test(h) || !h.includes('.') || net.isIP(h)) return null;
  if (h === 'localhost' || /\.(?:localhost|local|internal|home\.arpa|localdomain|lan)$/.test(h)) return null;
  u.hostname = h;
  return u;
}

/** Addresses no public page lives at: loopback, private, link-local, CGNAT, documentation, multicast, reserved, unspecified. */
const PRIVATE = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) PRIVATE.addSubnet(a, n, 'ipv4');
// (no ::ffff:0:0/96 here: BlockList matches every IPv4 address against that range; a mapped address is checked as its IPv4 instead)
for (const [a, n] of [['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) PRIVATE.addSubnet(a, n, 'ipv6');
function isPublic({ address, family }) {
  const mapped = family === 6 ? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address) : null;
  return mapped ? !PRIVATE.check(mapped[1], 'ipv4') : !PRIVATE.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** dns.lookup for http(s).get: every address of the name must be public, and the socket connects to one of those. */
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || !addresses.every(isPublic)) return callback(Object.assign(new Error(`${hostname} is not a public address`), { code: 'ENOTPUBLIC' }));
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/** One GET, no redirects followed: status, headers and (for a 200) the body as a stream. */
function getOnce(u, signal) {
  return new Promise((resolve, reject) => {
    // agent: false, so an environment proxy (NODE_USE_ENV_PROXY) can't take the request past the address check
    const req = (u.protocol === 'https:' ? https : http).get(u, { agent: false, lookup: publicLookup, signal, headers: { 'user-agent': UA, accept: 'text/html' } }, resolve);
    req.on('error', reject);
  });
}

const nextSlot = new Map();
/** At least GAP_MS between two requests to one host. */
async function polite(host) {
  const at = Math.max(Date.now(), nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + GAP_MS);
  if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
}

async function readCapped(res) {
  const type = res.headers['content-type'] ?? '';
  let decoder;
  try {
    const cs = /charset=["']?([\w-]+)/i.exec(type)?.[1];
    decoder = new TextDecoder(cs ?? 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  const chunks = [];
  let size = 0;
  for await (const value of res) {
    chunks.push(value.subarray(0, MAX_BYTES - size));
    size += chunks.at(-1).length;
    if (size >= MAX_BYTES) break;
  }
  res.destroy();
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
    const res = await getOnce(u, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.destroy();
      try {
        u = safeUrl(new URL(res.headers.location, u).href);
      } catch {
        u = null;
      }
      continue;
    }
    if (status !== 200) {
      res.destroy();
      throw new Error(`HTTP ${status}`);
    }
    const type = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'text/html' && type !== 'application/xhtml+xml') {
      res.destroy();
      throw new Error(`content-type ${type || 'missing'}`);
    }
    return { html: await readCapped(res), url: u.href };
  }
  throw new Error('too many redirects');
}

async function read(p, target, signal) {
  const { html, url } = await getPage(target, signal);
  return parseOwnerPage(html, { url, name: p.name, govHash: p.govHash, source: p.url });
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
  if (!page && isDashCentral(u.hostname.replace(/^www\./, ''))) {
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
