// Untrusted markdown -> a small, safe document tree. Nothing here (or in the app's renderer) ever produces an HTML
// string: marked is used only as a lexer, its tokens are mapped onto the node types below, and the app renders
// them as React elements. Consequences:
//   - raw HTML is shown as literal text, never interpreted;
//   - links keep only absolute http(s) URLs (no javascript:, data:, relative or protocol-relative targets);
//   - images are never loaded: they become a labelled link to the image (the CSP also blocks remote images);
//   - nesting is capped, so a pathological input cannot blow the renderer's stack.
//   - bidi controls are removed from every rendered string, including ones that character references decode to, so text
//     cannot be reordered on screen (an RLO turns "invoice\u202Etxt.exe" into "invoiceexe.txt");
//   - a link whose text looks like a URL or domain other than its target's host carries `realHost`, shown next to it.
import { Lexer, type Token, type Tokens } from 'marked';
import { stripBidi } from './text.ts';

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: MdInline[] }
  | { t: 'code'; v: string }
  | { t: 'br' }
  /** href null = the URL was not allowed; the text is shown without a link. `realHost`: the text names another host */
  | { t: 'link'; href: string | null; c: MdInline[]; realHost?: string }
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
/** Comments are at most 5,000 B; longer post bodies than this are shown as plain text. */
const MAX_INPUT = 64 * 1024;
/**
 * marked's inline lexer is quadratic in mixed emphasis / bracket / backtick delimiters (64 KB of `*a_` takes ~20 s).
 * Text dense in them is rendered as plain text instead: ordinary prose and formatting stay far below this.
 */
const DELIMITER_BUDGET = 1500;
const DELIMITERS = /[*_~`[\]<]/g;
export function tooCostly(text: string): boolean {
  if (text.length >= MAX_INPUT) return true;
  const n = text.match(DELIMITERS)?.length ?? 0;
  return n > DELIMITER_BUDGET && n > text.length * 0.04;
}

/** Only absolute http(s) URLs survive, normalised by the URL parser (so `java\nscript:` tricks cannot pass). */
export function safeHref(href: string | undefined | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // `https://gov.dashhq.org@evil.example/` goes to evil.example: refuse userinfo outright.
    if (!u.hostname || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** HTML named character references in common use (the full HTML list is 2,000+; others stay as typed). */
const ENTITIES = new Map<string, string>(
  (
    'amp:38 lt:60 gt:62 quot:34 apos:39 nbsp:160 iexcl:161 cent:162 pound:163 curren:164 yen:165 brvbar:166 sect:167 uml:168 copy:169 ordf:170 ' +
    'laquo:171 not:172 shy:173 reg:174 macr:175 deg:176 plusmn:177 sup2:178 sup3:179 acute:180 micro:181 para:182 middot:183 cedil:184 sup1:185 ' +
    'ordm:186 raquo:187 frac14:188 frac12:189 frac34:190 iquest:191 times:215 divide:247 szlig:223 agrave:224 aacute:225 acirc:226 atilde:227 ' +
    'auml:228 aring:229 aelig:230 ccedil:231 egrave:232 eacute:233 ecirc:234 euml:235 igrave:236 iacute:237 icirc:238 iuml:239 ntilde:241 ' +
    'ograve:242 oacute:243 ocirc:244 otilde:245 ouml:246 oslash:248 ugrave:249 uacute:250 ucirc:251 uuml:252 yacute:253 yuml:255 ' +
    'Agrave:192 Aacute:193 Acirc:194 Atilde:195 Auml:196 Aring:197 AElig:198 Ccedil:199 Egrave:200 Eacute:201 Ecirc:202 Euml:203 Igrave:204 ' +
    'Iacute:205 Icirc:206 Iuml:207 Ntilde:209 Ograve:210 Oacute:211 Ocirc:212 Otilde:213 Ouml:214 Oslash:216 Ugrave:217 Uacute:218 Ucirc:219 ' +
    'Uuml:220 Yacute:221 euro:8364 hellip:8230 ndash:8211 mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 ldquo:8220 rdquo:8221 bdquo:8222 ' +
    'bull:8226 prime:8242 Prime:8243 dagger:8224 Dagger:8225 permil:8240 lsaquo:8249 rsaquo:8250 trade:8482 larr:8592 uarr:8593 rarr:8594 ' +
    'darr:8595 harr:8596 lArr:8656 rArr:8658 hArr:8660 minus:8722 le:8804 ge:8805 ne:8800 asymp:8776 infin:8734 sum:8721 radic:8730 ' +
    'alpha:945 beta:946 gamma:947 delta:948 epsilon:949 lambda:955 mu:956 pi:960 sigma:963 tau:964 phi:966 omega:969 Delta:916 Sigma:931 ' +
    'Omega:937 spades:9824 clubs:9827 hearts:9829 diams:9830 check:10003 star:9734 starf:9733 ensp:8194 emsp:8195 thinsp:8201 zwnj:8204 ' +
    'zwj:8205 lrm:8206 rlm:8207'
  )
    .split(' ')
    .map((e) => {
      const [name, cp] = e.split(':') as [string, string];
      return [name, String.fromCodePoint(Number(cp))] as const;
    }),
);
/**
 * marked leaves character references in text; show them as the characters they name (text only, never markup). Bidi
 * controls they decode to (&#x202E;, &rlm;) are dropped like typed ones.
 */
function decodeEntities(s: string): string {
  return stripBidi(
    s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{0,31});/gi, (m, e: string) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
      }
      return ENTITIES.get(e) ?? ENTITIES.get(e.toLowerCase()) ?? m; // a Map: `&constructor;` is not a prototype key
    }),
  );
}

function plainText(nodes: readonly MdInline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
        case 'code':
          return n.v;
        case 'strong':
        case 'em':
        case 'del':
        case 'link':
          return plainText(n.c);
        case 'image':
          return n.alt;
        default:
          return '';
      }
    })
    .join('');
}

/** A word that is a URL or a bare domain: `https://dash.org/x`, `dash.org`, `www.dash.org/path`. */
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^\s/?#@]*@)?((?:[^\s/?#@:.]+\.)+(?:\p{L}{2,63}|xn--[a-z0-9-]+))\.?(?::\d{1,5})?(?:[/?#]\S*)?$/iu;
/** Brackets, quotes and sentence punctuation around a word in prose. */
const WRAP = /^[([{<"'\u00AB\u2018\u201C]+|[)\]}>"'\u00BB\u2019\u201D.,;:!?]+$/gu;
const hostKey = (h: string) => h.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

/**
 * The target's real host, to show next to a link (`dash.org (→ evil.example)`), or null. Shown when a word of the link text is a
 * URL or domain naming another host (`[dash.org](https://evil.example)`, `[Visit dash.org](...)`), and always for an
 * internationalised target host, in its punycode form, since its letters can imitate another name.
 */
export function linkRealHost(text: string, href: string | null): string | null {
  if (!href) return null;
  let target: string;
  try {
    target = new URL(href).hostname;
  } catch {
    return null;
  }
  if (target.split('.').some((label) => label.startsWith('xn--'))) return target;
  for (const word of text.split(/\s+/)) {
    const m = URL_LIKE.exec(word.replace(WRAP, ''));
    if (!m) continue;
    try {
      if (hostKey(new URL(`http://${m[1]}`).hostname) !== hostKey(target)) return target;
    } catch {
      /* not a host after all */
    }
  }
  return null;
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
        const href = safeHref(t.href);
        const realHost = linkRealHost(plainText(c), href);
        out.push({ t: 'link', href, c, ...(realHost ? { realHost } : {}) });
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
  const text = stripBidi(src.length > MAX_INPUT ? src.slice(0, MAX_INPUT) : src).replace(/^((?:[ \t]*>){8})(?:[ \t]*>)+/gm, '$1');
  if (tooCostly(text)) return parsePlain(text);
  try {
    return blocks(Lexer.lex(text, { gfm: true, breaks: true }), 0);
  } catch (e) {
    if (e instanceof RangeError) return parsePlain(text);
    throw e;
  }
}

/** Plain-text comments (`fmt` 0): paragraphs split on blank lines, line breaks kept, no markup at all. */
export function parsePlain(src: string): MdBlock[] {
  return stripBidi(src)
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
