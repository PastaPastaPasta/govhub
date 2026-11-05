// What a proposal's owner says on the page the proposal links to (usually DashCentral), read once at build time
// (scripts/ownerpages.mjs) and shipped as /owners.json from this origin: the browser never fetches those pages. It is the owner's own
// text, quoted and attributed (host, date), never a paraphrase and never something the chain commits to. Pure string code, so the
// build script imports it too.
import { useEffect, useState } from 'react';

export interface OwnerPage {
  /** the proposal link the build followed to it: shown only for a proposal whose verified link is this one */
  source: string;
  /** the page that was read (after redirects); http(s) only */
  url: string;
  /** its hostname without a leading "www." */
  host: string;
  /** the proposal's own title as the page gives it, or null (never just the proposal's on-chain name again) */
  title: string | null;
  /** the page's meta / og:description, when it says more than the title; else null */
  description: string | null;
  /** the first substantive paragraph of the proposal text, verbatim (whitespace collapsed), or null */
  excerpt: string | null;
}

export interface OwnerPagesFile {
  /** Unix seconds: when the build read the pages. */
  fetchedAt: number;
  /** keyed by govHash (64 lowercase hex) */
  pages: Record<string, OwnerPage>;
}

const CAP = { title: 140, description: 300, excerpt: 600 } as const;
const HASH = /^[0-9a-f]{64}$/;
const MIN_PARAGRAPH = 60;

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', laquo: '«', raquo: '»', times: '×', deg: '°', rarr: '→', larr: '←',
};

function decode(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,8}));/g, (m, dec?: string, hex?: string, name?: string) => {
    if (name) return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? m;
    const cp = dec ? Number(dec) : parseInt(hex ?? '', 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

/** Text as the page shows it: entities decoded, zero-width, direction-control characters and BOMs gone, whitespace collapsed. */
function clean(s: string): string {
  return decode(s).replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').replace(/[\u0000-\u001F\u007F\s]+/g, ' ').trim();
}

/** At most `n` characters, cut at a word boundary with "…". */
function cap(s: string, n: number): string {
  if (s.length <= n) return s;
  let cut = s.slice(0, n - 1);
  const space = cut.lastIndexOf(' ');
  if (space > n / 2) cut = cut.slice(0, space);
  cut = cut.replace(/[\s,;:.\-–—]+$/, '');
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const squash = (s: string) => s.toLowerCase().replace(/[-_\s]+/g, '');
/** A title that names no proposal in particular ("Dash proposal", "Budget proposal"): the on-chain name says more. */
const VAGUE_TITLE = /^(?:(?:my|our|new|the)\s+)?(?:dash\s+)?(?:treasury\s+|budget\s+|funding\s+|governance\s+)?proposal(?:\s+for\s+dash)?$/i;

/** "BTCBACKPORTSVIJAY_04" vs a title: true when the title is only the name again (case, -, _, spaces ignored). */
export function sameAsName(title: string, name: string): boolean {
  const t = squash(clean(title));
  return t !== '' && t === squash(name);
}

/**
 * The page as text and tags, in one pass over it (untrusted pages: no pattern may rescan the rest of the page from every "<"). A tag
 * that never closes ends the scan: the rest is text.
 */
type Token = { text: string } | { name: string; close: boolean; attrs: string };
function tokens(html: string): Token[] {
  const out: Token[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out.push({ text: html.slice(i) });
      break;
    }
    if (lt > i) out.push({ text: html.slice(i, lt) });
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]{0,15})/.exec(html.slice(lt, lt + 20));
    if (!m) {
      out.push({ text: '<' });
      i = lt + 1;
      continue;
    }
    let j = lt + m[0].length;
    let quote = '';
    for (; j < n; j++) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (j >= n) {
      out.push({ text: html.slice(lt) });
      break;
    }
    out.push({ name: m[2]!.toLowerCase(), close: m[1] === '/', attrs: html.slice(lt + m[0].length, j) });
    i = j + 1;
  }
  return out;
}

const textOf = (ts: readonly Token[]): string => ts.map((t) => ('text' in t ? t.text : '')).join('');
const stripTags = (html: string): string => textOf(tokens(html));

/** Lower case for ASCII only: the same length as the input, so its offsets are the input's (toLowerCase turns "İ" into two). */
const lowerAscii = (s: string): string => s.replace(/[A-Z]+/g, (c) => c.toLowerCase());

/** Comments, scripts and styles are never text; one that never ends drops the rest of the page. */
function withoutNoise(html: string): string {
  const lower = lowerAscii(html);
  const raw = /<(script|style|noscript|template)\b/g;
  let out = '';
  let i = 0;
  let comment = lower.indexOf('<!--');
  let el: RegExpExecArray | null = raw.exec(lower);
  while (i < html.length) {
    if (comment >= 0 && comment < i) comment = lower.indexOf('<!--', i);
    if (el && el.index < i) {
      raw.lastIndex = i;
      el = raw.exec(lower);
    }
    const next = Math.min(comment < 0 ? Infinity : comment, el ? el.index : Infinity);
    if (next === Infinity) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, next);
    if (next === comment) {
      const end = lower.indexOf('-->', next + 4);
      if (end < 0) break;
      i = end + 3;
    } else {
      const end = lower.indexOf(`</${el![1]}`, next + 1);
      const gt = end < 0 ? -1 : lower.indexOf('>', end);
      if (gt < 0) break;
      i = gt + 1;
    }
  }
  return out;
}

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function metaTags(ts: readonly Token[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of ts) {
    if ('text' in t || t.name !== 'meta' || t.close) continue;
    const attrs = new Map<string, string>();
    for (const a of t.attrs.matchAll(ATTR)) attrs.set((a[1] ?? '').toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
    const content = clean(attrs.get('content') ?? '');
    if (!content) continue;
    for (const k of [attrs.get('property'), attrs.get('name')]) if (k && !out.has(k.toLowerCase())) out.set(k.toLowerCase(), content);
  }
  return out;
}

/** The text of the first <title>, or ''. */
function titleOf(ts: readonly Token[]): string {
  const at = ts.findIndex((t) => !('text' in t) && t.name === 'title' && !t.close);
  if (at < 0) return '';
  const end = ts.findIndex((t, k) => k > at && !('text' in t) && t.name === 'title' && t.close);
  return textOf(ts.slice(at + 1, end < 0 ? undefined : end));
}

const BLOCK = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr', 'td', 'th', 'blockquote', 'pre', 'hr',
  'section', 'article', 'header', 'footer', 'aside', 'nav', 'figure', 'figcaption', 'details', 'summary', 'form', 'fieldset',
]);

/** Paragraphs of an HTML fragment: split at block elements and at two or more <br>s; a heading is one that is all bold. */
function paragraphs(ts: readonly Token[]): { text: string; heading: boolean }[] {
  const out: { text: string; heading: boolean }[] = [];
  let all = '';
  let plain = '';
  let bold = 0;
  let afterBr = false;
  const flush = () => {
    const text = clean(all);
    if (text) out.push({ text, heading: clean(plain) === '' });
    all = plain = '';
  };
  const add = (raw: string) => {
    all += raw;
    if (!bold) plain += raw;
  };
  for (const t of ts) {
    if ('text' in t) {
      if (clean(t.text)) afterBr = false;
      add(t.text);
    } else if (t.name === 'strong' || t.name === 'b') bold = t.close ? Math.max(0, bold - 1) : bold + 1;
    else if (t.name === 'br') {
      if (afterBr) {
        flush();
        afterBr = false;
      } else {
        afterBr = true;
        add(' ');
      }
    } else if (BLOCK.has(t.name)) {
      flush();
      afterBr = false;
    }
  }
  flush();
  return out;
}

const isDescription = (t: Token): boolean => !('text' in t) && t.name === 'div' && !t.close && /\bid\s*=\s*["']?description\b/i.test(t.attrs);

/** The tokens inside <div id="description"> (balanced against nested divs); null when there is none, or it never closes. */
function descriptionTokens(ts: readonly Token[]): Token[] | null {
  const at = ts.findIndex(isDescription);
  if (at < 0) return null;
  let depth = 1;
  for (let k = at + 1; k < ts.length; k++) {
    const t = ts[k]!;
    if ('text' in t || t.name !== 'div') continue;
    depth += t.close ? -1 : 1;
    if (depth === 0) return ts.slice(at + 1, k);
  }
  return null;
}

/** DashCentral's own header and fields, before the owner's description (and the discussion after it); null without one. */
function dashcentralFields(ts: readonly Token[]): Token[] | null {
  const at = ts.findIndex(isDescription);
  return at < 0 ? null : ts.slice(0, at);
}

/** The cell after the one that reads "Title:" in DashCentral's fields. */
function titleRow(ts: readonly Token[]): string {
  const label = ts.findIndex((t) => 'text' in t && /^\s*Title:\s*$/i.test(t.text));
  if (label < 0) return '';
  const open = ts.findIndex((t, k) => k > label && !('text' in t) && t.name === 'td' && !t.close);
  if (open < 0) return '';
  const end = ts.findIndex((t, k) => k > open && !('text' in t) && t.name === 'td' && t.close);
  return textOf(ts.slice(open + 1, end < 0 ? undefined : end));
}

/** The first paragraph that reads as prose (ends a sentence), else the first substantive one: list lines and labels say less. */
function firstParagraph(ts: readonly Token[]): string | null {
  const substantive = paragraphs(ts).filter((p) => !p.heading && p.text.length >= MIN_PARAGRAPH && !/[:?]$/.test(p.text));
  return (substantive.find((p) => /[.!]["”’)]?$/.test(p.text)) ?? substantive[0])?.text ?? null;
}

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

const GENERIC_TITLE = /^(sign in|log in|login|access denied|forbidden|not found|404|403|just a moment|attention required|page not found|error)\b/i;

/** DashCentral, under any of its names. */
export const isDashCentral = (host: string): boolean => host === 'dashcentral.org' || host.endsWith('.dashcentral.org');

/** How much of a page is read: DashCentral's pages are tens of KB; elsewhere only the head is used. */
const PAGE_CAP = 1_000_000;
const HEAD_CAP = 200_000;

/** Extracts the summary from a page's HTML; null when the page isn't about this proposal or says nothing usable. */
export function parseOwnerPage(html: string, ctx: { url: string; name: string; govHash: string; source?: string }): OwnerPage | null {
  const host = hostOf(ctx.url);
  if (!host || typeof html !== 'string' || !/<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<title[\s>]/i.test(html.slice(0, 200_000))) return null;
  let description: string | null = null;
  let excerpt: string | null = null;
  let own: string;

  if (isDashCentral(host)) {
    const page = html.slice(0, PAGE_CAP);
    const ts = tokens(withoutNoise(page));
    // the generic site page and a slug it doesn't know answer 200 too, and anyone can quote a hash in a discussion: only a page
    // whose own part, before the owner's description, names this proposal and carries its hash (the vote command of an open
    // proposal, or the page's own record of it, DW.proposal.hash) is its page
    const hash = ctx.govHash.toLowerCase();
    const head = dashcentralFields(ts);
    const lower = lowerAscii(page);
    const cut = lower.search(/<div\b[^>]{0,200}\bid\s*=\s*["']?description\b/);
    // no description block: nothing tells DashCentral's own part from what visitors wrote
    if (!head || cut < 0) return null;
    const fields = clean(textOf(head)).toLowerCase();
    const before = lower.slice(0, cut);
    const recorded = before.includes(`dw.proposal.hash = '${hash}'`) || before.includes(`dw.proposal.hash = "${hash}"`);
    if (!(fields.includes(`vote-many ${hash}`) || recorded) || !fields.includes(ctx.name.toLowerCase())) return null;
    // its meta description is just the title again, so there is no description to take
    own = clean(titleRow(head));
    const body = descriptionTokens(ts);
    excerpt = body ? firstParagraph(body) : null;
  } else {
    const head = html.slice(0, HEAD_CAP);
    const end = lowerAscii(head).indexOf('</head');
    const ts = tokens(withoutNoise(end < 0 ? head : head.slice(0, end)));
    const metas = metaTags(ts);
    own = clean(metas.get('og:title') ?? '') || clean(titleOf(ts));
    own = own.replace(/\s[-–—|]\s*Google (?:Docs|Sheets|Slides|Drive)$/i, '').trim();
    if (GENERIC_TITLE.test(own)) return null;
    const said = clean(metas.get('og:description') ?? '') || clean(metas.get('description') ?? '');
    if (host === 'docs.google.com') {
      // for a document the description already is its opening text
      let opening = said;
      if (own && opening.toLowerCase().startsWith(own.toLowerCase())) opening = opening.slice(own.length).replace(/^[\s:–—\-|.]+/, '');
      excerpt = opening.length >= 1 ? opening : null;
    } else {
      description = said || null;
    }
  }

  const title = own && !sameAsName(own, ctx.name) && !VAGUE_TITLE.test(own) ? own : null;
  if (description && (description.toLowerCase() === own.toLowerCase() || sameAsName(description, ctx.name))) description = null;
  if (!title && !description && !excerpt) return null;
  return {
    source: ctx.source ?? ctx.url,
    url: ctx.url,
    host,
    title: title && cap(title, CAP.title),
    description: description && cap(description, CAP.description),
    excerpt: excerpt && cap(excerpt, CAP.excerpt),
  };
}

const field = (v: unknown, max: number): string | null | undefined =>
  v === null ? null : typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;

/** owners.json as shipped, re-checked in the browser: only well-formed entries (types, lengths, http(s) url, 64-hex keys). */
export function parseOwnerPages(raw: unknown): { fetchedAt: number; pages: Map<string, OwnerPage> } {
  const none = { fetchedAt: 0, pages: new Map<string, OwnerPage>() };
  if (!raw || typeof raw !== 'object') return none;
  const { fetchedAt, pages } = raw as { fetchedAt?: unknown; pages?: unknown };
  if (typeof fetchedAt !== 'number' || !Number.isSafeInteger(fetchedAt) || fetchedAt <= 0 || !pages || typeof pages !== 'object') return none;
  const out = new Map<string, OwnerPage>();
  for (const [hash, e] of Object.entries(pages as Record<string, unknown>).slice(0, 5000)) {
    if (!HASH.test(hash) || !e || typeof e !== 'object') continue;
    const { source, url, host, title, description, excerpt } = e as Record<string, unknown>;
    if (typeof source !== 'string' || source.length > 2048) continue;
    if (typeof url !== 'string' || url.length > 2048 || typeof host !== 'string' || hostOf(url) !== host) continue;
    try {
      if (new URL(url).username || new URL(url).password) continue;
    } catch {
      continue;
    }
    const t = field(title, CAP.title), d = field(description, CAP.description), x = field(excerpt, CAP.excerpt);
    if (t === undefined || d === undefined || x === undefined || (t === null && d === null && x === null)) continue;
    out.set(hash, { source, url, host, title: t, description: d, excerpt: x });
  }
  return { fetchedAt, pages: out };
}

let shipped: Promise<ReturnType<typeof parseOwnerPages>> | null = null;
function shippedPages() {
  shipped ??= fetch(`${(import.meta.env?.BASE_URL as string | undefined) ?? '/'}owners.json`, { credentials: 'omit' })
    .then((r) => (r.ok ? r.json() : null))
    .then(parseOwnerPages, () => parseOwnerPages(null));
  return shipped;
}

/** The page the build read for this proposal, only when it followed the very link this proposal has (its verified copy). */
export const ownerPageOf = (pages: ReadonlyMap<string, OwnerPage>, p: { govHash: string; url: string }): OwnerPage | null => {
  const page = pages.get(p.govHash.toLowerCase());
  return page && page.source === p.url ? page : null;
};

/** Every page the build read, by govHash (empty until known): for matching a search against the owners' titles. */
export function useOwnerPages(): ReadonlyMap<string, OwnerPage> {
  const [pages, setPages] = useState<ReadonlyMap<string, OwnerPage>>(new Map());
  useEffect(() => {
    let on = true;
    shippedPages().then((o) => on && setPages(o.pages), () => {});
    return () => {
      on = false;
    };
  }, []);
  return pages;
}

/** What the owner's page said when the site was built, for a proposal the build read through this same link; null otherwise. */
export function useOwnerPage(p: { govHash: string; url: string }): { page: OwnerPage; fetchedAt: number } | null {
  const [found, setFound] = useState<{ page: OwnerPage; fetchedAt: number } | null>(null);
  const { govHash, url } = p;
  useEffect(() => {
    let on = true;
    shippedPages().then((o) => {
      const page = ownerPageOf(o.pages, { govHash, url });
      if (on) setFound(page ? { page, fetchedAt: o.fetchedAt } : null);
    }, () => {});
    return () => {
      on = false;
    };
  }, [govHash, url]);
  return found;
}
