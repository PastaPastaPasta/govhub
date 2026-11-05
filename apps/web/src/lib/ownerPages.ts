// What a proposal's owner says on the page the proposal links to (usually DashCentral), read once at build time
// (scripts/ownerpages.mjs) and shipped as /owners.json from this origin: the browser never fetches those pages. It is the owner's own
// text, quoted and attributed (host, date), never a paraphrase and never something the chain commits to. Pure string code, so the
// build script imports it too.
import { useEffect, useState } from 'react';

export interface OwnerPage {
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

/** Text as the page shows it: entities decoded, zero-width characters and BOMs gone, whitespace collapsed. */
function clean(s: string): string {
  return decode(s).replace(/[​-‍﻿]/g, '').replace(/[\u0000-\u001F\u007F\s]+/g, ' ').trim();
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

/** "BTCBACKPORTSVIJAY_04" vs a title: true when the title is only the name again (case, -, _, spaces ignored). */
export function sameAsName(title: string, name: string): boolean {
  const t = squash(clean(title));
  return t !== '' && t === squash(name);
}

const TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;

const stripTags = (html: string): string => html.replace(TAG, '');

/** Comments, scripts and styles are never text. */
const withoutNoise = (html: string): string =>
  html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '');

function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of (m[1] ?? '').matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attrs.set((a[1] ?? '').toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
    }
    const content = clean(attrs.get('content') ?? '');
    if (!content) continue;
    for (const k of [attrs.get('property'), attrs.get('name')]) if (k && !out.has(k.toLowerCase())) out.set(k.toLowerCase(), content);
  }
  return out;
}

const BLOCK = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr', 'td', 'th', 'blockquote', 'pre', 'hr',
  'section', 'article', 'header', 'footer', 'aside', 'nav', 'figure', 'figcaption', 'details', 'summary', 'form', 'fieldset',
]);

/** Paragraphs of an HTML fragment: split at block elements and at two or more <br>s; a heading is one that is all bold. */
function paragraphs(fragment: string): { text: string; heading: boolean }[] {
  const html = withoutNoise(fragment);
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
  let last = 0;
  for (const m of html.matchAll(TAG)) {
    const text = html.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    if (clean(text)) afterBr = false;
    add(text);
    const name = (m[1] ?? '').toLowerCase();
    if (name === 'strong' || name === 'b') bold = m[0].startsWith('</') ? Math.max(0, bold - 1) : bold + 1;
    else if (name === 'br') {
      if (afterBr) {
        flush();
        afterBr = false;
      } else {
        afterBr = true;
        add(' ');
      }
    } else if (BLOCK.has(name)) {
      flush();
      afterBr = false;
    }
  }
  add(html.slice(last));
  flush();
  return out;
}

/** The inner HTML of <div id="description"> (balanced against nested divs), or null. */
function descriptionHtml(html: string): string | null {
  const open = /<div\b[^>]*\bid=["']description["'][^>]*>/i.exec(html);
  if (!open) return null;
  const from = open.index + open[0].length;
  const rest = html.slice(from, from + 400_000);
  let depth = 1;
  for (const m of rest.matchAll(/<(\/?)div\b[^>]*>/gi)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return rest.slice(0, m.index);
  }
  return rest;
}

function firstParagraph(fragment: string): string | null {
  for (const p of paragraphs(fragment)) {
    if (p.heading || p.text.length < MIN_PARAGRAPH || /[:?]$/.test(p.text)) continue;
    return p.text;
  }
  return null;
}

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

const GENERIC_TITLE = /^(sign in|log in|login|access denied|forbidden|not found|404|403|just a moment|attention required|page not found|error)\b/i;

/** Extracts the summary from a page's HTML; null when the page isn't about this proposal or says nothing usable. */
export function parseOwnerPage(html: string, ctx: { url: string; name: string; govHash: string }): OwnerPage | null {
  const host = hostOf(ctx.url);
  if (!host || typeof html !== 'string' || !/<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<title[\s>]/i.test(html.slice(0, 200_000))) return null;
  const shown = withoutNoise(html);
  let description: string | null = null;
  let excerpt: string | null = null;
  let own: string;

  if (host === 'dashcentral.org') {
    // the generic site page and a slug it doesn't know answer 200 too: only a page that carries this proposal's hash is its page
    if (!html.toLowerCase().includes(ctx.govHash.toLowerCase())) return null;
    // its meta description is just the title again, so there is no description to take
    const row = /<tr[^>]*>\s*<td[^>]*>\s*Title:\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i.exec(shown);
    own = clean(stripTags(row?.[1] ?? ''));
    const body = descriptionHtml(shown);
    excerpt = body ? firstParagraph(body) : null;
  } else {
    const metas = metaTags(shown);
    const tag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(shown);
    own = clean(metas.get('og:title') ?? '') || clean(stripTags(tag?.[1] ?? ''));
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

  const title = own && !sameAsName(own, ctx.name) ? own : null;
  if (description && (description.toLowerCase() === own.toLowerCase() || sameAsName(description, ctx.name))) description = null;
  if (!title && !description && !excerpt) return null;
  return {
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
    const { url, host, title, description, excerpt } = e as Record<string, unknown>;
    if (typeof url !== 'string' || url.length > 2048 || typeof host !== 'string' || hostOf(url) !== host) continue;
    try {
      if (new URL(url).username || new URL(url).password) continue;
    } catch {
      continue;
    }
    const t = field(title, CAP.title), d = field(description, CAP.description), x = field(excerpt, CAP.excerpt);
    if (t === undefined || d === undefined || x === undefined || (t === null && d === null && x === null)) continue;
    out.set(hash, { url, host, title: t, description: d, excerpt: x });
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

/** What the owner's page said when the site was built, for a proposal the build could read; null otherwise (or until known). */
export function useOwnerPage(govHash: string): { page: OwnerPage; fetchedAt: number } | null {
  const [found, setFound] = useState<{ page: OwnerPage; fetchedAt: number } | null>(null);
  useEffect(() => {
    let on = true;
    shippedPages().then((o) => {
      const page = o.pages.get(govHash.toLowerCase());
      if (on) setFound(page ? { page, fetchedAt: o.fetchedAt } : null);
    }, () => {});
    return () => {
      on = false;
    };
  }, [govHash]);
  return found;
}
