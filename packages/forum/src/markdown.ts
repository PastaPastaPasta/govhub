// Untrusted markdown -> a small, safe document tree. Nothing here (or in the app's renderer) ever produces an HTML
// string: marked is used only as a lexer, its tokens are mapped onto the node types below, and the app renders
// them as React elements. Consequences:
//   - raw HTML is shown as literal text, never interpreted;
//   - links keep only absolute http(s) URLs (no javascript:, data:, relative or protocol-relative targets);
//   - images are never loaded: they become a labelled link to the image (the CSP also blocks remote images);
//   - nesting is capped, so a pathological input cannot blow the renderer's stack.
import { Lexer, type Token, type Tokens } from 'marked';

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: MdInline[] }
  | { t: 'code'; v: string }
  | { t: 'br' }
  /** href null = the URL was not allowed; the text is shown without a link */
  | { t: 'link'; href: string | null; c: MdInline[] }
  | { t: 'image'; href: string | null; alt: string };

export type MdBlock =
  | { t: 'p'; c: MdInline[] }
  | { t: 'h'; level: number; c: MdInline[] }
  | { t: 'code'; lang?: string; v: string }
  | { t: 'quote'; c: MdBlock[] }
  | { t: 'list'; ordered: boolean; start?: number; items: MdBlock[][] }
  | { t: 'hr' }
  | { t: 'table'; align: Array<'left' | 'center' | 'right' | null>; head: MdInline[][]; rows: MdInline[][][] };

export const MAX_DEPTH = 8;
/** Inputs are at most 5,000 B for comments; posts inflate to at most 256 KiB. */
const MAX_INPUT = 256 * 1024;

/** Only absolute http(s) URLs survive, normalised by the URL parser (so `java\nscript:` tricks cannot pass). */
export function safeHref(href: string | undefined | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** marked leaves character references in text; show them as the characters they name (text only, never markup). */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function pushText(out: MdInline[], v: string) {
  if (!v) return;
  const last = out.at(-1);
  if (last?.t === 'text') last.v += v;
  else out.push({ t: 'text', v });
}

function inline(tokens: readonly Token[] | undefined, depth: number): MdInline[] {
  const out: MdInline[] = [];
  for (const tok of tokens ?? []) {
    switch (tok.type) {
      case 'text':
      case 'escape': {
        const t = tok as Tokens.Text;
        if (t.tokens?.length && depth < MAX_DEPTH) for (const x of inline(t.tokens, depth + 1)) x.t === 'text' ? pushText(out, x.v) : out.push(x);
        else pushText(out, decodeEntities(t.text));
        break;
      }
      case 'html':
        pushText(out, (tok as Tokens.HTML).raw);
        break;
      case 'codespan':
        out.push({ t: 'code', v: decodeEntities((tok as Tokens.Codespan).text) });
        break;
      case 'br':
        out.push({ t: 'br' });
        break;
      case 'strong':
      case 'em':
      case 'del': {
        const t = tok as Tokens.Strong;
        if (depth >= MAX_DEPTH) pushText(out, t.text);
        else out.push({ t: tok.type, c: inline(t.tokens, depth + 1) });
        break;
      }
      case 'link': {
        const t = tok as Tokens.Link;
        const c = depth >= MAX_DEPTH ? [{ t: 'text' as const, v: t.text }] : inline(t.tokens, depth + 1).filter((x) => x.t !== 'link');
        out.push({ t: 'link', href: safeHref(t.href), c });
        break;
      }
      case 'image': {
        const t = tok as Tokens.Image;
        out.push({ t: 'image', href: safeHref(t.href), alt: decodeEntities(t.text) });
        break;
      }
      default:
        pushText(out, tok.raw);
    }
  }
  return out;
}

function blocks(tokens: readonly Token[], depth: number): MdBlock[] {
  const out: MdBlock[] = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
      case 'def':
        break;
      case 'paragraph':
      case 'text': {
        const t = tok as Tokens.Paragraph;
        out.push({ t: 'p', c: t.tokens ? inline(t.tokens, depth) : [{ t: 'text', v: decodeEntities(t.text) }] });
        break;
      }
      case 'heading': {
        const t = tok as Tokens.Heading;
        out.push({ t: 'h', level: Math.min(Math.max(t.depth, 1), 6), c: inline(t.tokens, depth) });
        break;
      }
      case 'code': {
        const t = tok as Tokens.Code;
        const lang = t.lang?.trim().split(/\s/)[0]?.slice(0, 20);
        out.push({ t: 'code', v: t.text, ...(lang ? { lang } : {}) });
        break;
      }
      case 'blockquote': {
        const t = tok as Tokens.Blockquote;
        out.push(depth >= MAX_DEPTH ? { t: 'p', c: [{ t: 'text', v: t.text }] } : { t: 'quote', c: blocks(t.tokens, depth + 1) });
        break;
      }
      case 'list': {
        const t = tok as Tokens.List;
        if (depth >= MAX_DEPTH) {
          out.push({ t: 'p', c: [{ t: 'text', v: t.raw }] });
          break;
        }
        const start = t.ordered && typeof t.start === 'number' && t.start !== 1 ? Math.max(0, Math.min(t.start, 1e9)) : undefined;
        out.push({ t: 'list', ordered: t.ordered, ...(start !== undefined ? { start } : {}), items: t.items.map((it) => blocks(it.tokens, depth + 1)) });
        break;
      }
      case 'hr':
        out.push({ t: 'hr' });
        break;
      case 'table': {
        const t = tok as Tokens.Table;
        out.push({ t: 'table', align: t.align, head: t.header.map((h) => inline(h.tokens, depth)), rows: t.rows.map((r) => r.map((c) => inline(c.tokens, depth))) });
        break;
      }
      case 'html':
        out.push({ t: 'p', c: [{ t: 'text', v: (tok as Tokens.HTML).raw.trimEnd() }] });
        break;
      default:
        out.push({ t: 'p', c: [{ t: 'text', v: tok.raw }] });
    }
  }
  return out;
}

/**
 * Markdown (GFM, single newlines are line breaks like DashCentral comments) -> safe tree. marked's lexer itself
 * recurses per nesting level, so deep blockquote prefixes are clamped first, and any input that still overflows
 * the stack (e.g. thousands of nested emphasis markers) is shown as plain text instead.
 */
export function parseMarkdown(src: string): MdBlock[] {
  const text = (src.length > MAX_INPUT ? src.slice(0, MAX_INPUT) : src).replace(/^((?:[ \t]*>){8})(?:[ \t]*>)+/gm, '$1');
  try {
    return blocks(Lexer.lex(text, { gfm: true, breaks: true }), 0);
  } catch (e) {
    if (e instanceof RangeError) return parsePlain(text);
    throw e;
  }
}

/** Plain-text comments (`fmt` 0): paragraphs split on blank lines, line breaks kept, no markup at all. */
export function parsePlain(src: string): MdBlock[] {
  return src
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => {
      const c: MdInline[] = [];
      p.split('\n').forEach((line, i) => {
        if (i) c.push({ t: 'br' });
        pushText(c, line);
      });
      return { t: 'p', c };
    });
}
