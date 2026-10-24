// A faithful TypeScript port of the quirks of Dash Core's JSON parser (src/univalue/lib/univalue_read.cpp: getJsonToken L54,
// UniValue::read L262; src/univalue/include/univalue_utffilter.h; lookup univalue.cpp:156,188) as used on proposal data. We need parity, not RFC 8259 correctness, because the question we
// answer is "did Core accept this proposal?".
//
// Quirks that matter (all verified against `dash-cli gobject check`, see test/fixtures/check.regtest.json):
//  * ParseProposalJSON ignores the boolean returned by UniValue::read(). A document that fails to parse half way
//    (truncated, or trailing garbage after the closing brace) still yields whatever object was built so far.
//  * Objects are stored as parallel key / value arrays WITHOUT de-duplication; lookups return the FIRST match
//    (JS JSON.parse keeps the LAST), so duplicate keys must not be resolved with JSON.parse.
//  * Numbers are kept as their lexeme; integer accessors use std::from_chars (no "1.0", no "1e3").
//  * Strings are byte strings. UTF-8 validation is lax (see JSONUTF8StringFilter) - we keep raw bytes and represent
//    them as "binary strings" (one JS char per byte) so lengths are byte lengths.

export type JVal =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  | { t: 'num'; s: string }
  | { t: 'str'; s: string } // binary string: each UTF-16 unit is one byte 0..255
  | { t: 'arr'; values: JVal[] }
  | { t: 'obj'; keys: string[]; values: JVal[] };

export interface CoreJsonResult {
  /** The value UniValue::read() returned. Core ignores it for proposals, so do not use it to reject. */
  wellFormed: boolean;
  /** The (possibly partial) root. May be undefined when nothing could be parsed. */
  root: JVal | undefined;
}

// (a plain object rather than an enum: enums are not supported by Node's built-in type stripping)
const Tok = {
  ERR: -1,
  NONE: 0,
  OBJ_OPEN: 1,
  OBJ_CLOSE: 2,
  ARR_OPEN: 3,
  ARR_CLOSE: 4,
  COLON: 5,
  COMMA: 6,
  NULL: 7,
  TRUE: 8,
  FALSE: 9,
  NUMBER: 10,
  STRING: 11,
} as const;
type Tok = (typeof Tok)[keyof typeof Tok];

const MAX_JSON_DEPTH = 512;
const isDigit = (c: number | undefined): boolean => c !== undefined && c >= 0x30 && c <= 0x39;
const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

interface Lexed {
  tok: Tok;
  val: string;
  next: number;
}

/** Port of JSONUTF8StringFilter: validates UTF-8 and collates \u surrogate pairs, but produces bytes. */
class Utf8Filter {
  out: number[] = [];
  private valid = true;
  private codepoint = 0;
  private state = 0;
  private surpair = 0;

  pushByte(ch: number): void {
    if (this.state === 0) {
      if (ch < 0x80) this.out.push(ch);
      else if (ch < 0xc0) this.valid = false;
      else if (ch < 0xe0) {
        this.codepoint = (ch & 0x1f) << 6;
        this.state = 6;
      } else if (ch < 0xf0) {
        this.codepoint = (ch & 0x0f) << 12;
        this.state = 12;
      } else if (ch < 0xf8) {
        this.codepoint = (ch & 0x07) << 18;
        this.state = 18;
      } else this.valid = false;
    } else {
      if ((ch & 0xc0) !== 0x80) this.valid = false;
      this.state -= 6;
      this.codepoint |= (ch & 0x3f) << this.state;
      if (this.state === 0) this.pushCodepoint(this.codepoint);
    }
  }

  pushCodepoint(cp: number): void {
    if (this.state) this.valid = false;
    if (cp >= 0xd800 && cp < 0xdc00) {
      if (this.surpair) this.valid = false;
      else this.surpair = cp;
    } else if (cp >= 0xdc00 && cp < 0xe000) {
      if (this.surpair) {
        this.append(0x10000 | ((this.surpair - 0xd800) << 10) | (cp - 0xdc00));
        this.surpair = 0;
      } else this.valid = false;
    } else if (this.surpair) this.valid = false;
    else this.append(cp);
  }

  private append(cp: number): void {
    if (cp <= 0x7f) this.out.push(cp);
    else if (cp <= 0x7ff) this.out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp <= 0xffff) this.out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else if (cp <= 0x1fffff) this.out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }

  finalize(): boolean {
    if (this.state || this.surpair) this.valid = false;
    return this.valid;
  }
}

const startsWith = (raw: Uint8Array, at: number, word: string): boolean => {
  if (at + word.length > raw.length) return false;
  for (let i = 0; i < word.length; i++) if (raw[at + i] !== word.charCodeAt(i)) return false;
  return true;
};

function binary(bytes: number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.slice(i, i + 4096));
  return s;
}

/** getJsonToken(), univalue_read.cpp:54-250. */
function lex(raw: Uint8Array, start: number): Lexed {
  let p = start;
  const end = raw.length;
  while (p < end && isSpace(raw[p]!)) p++;
  if (p >= end) return { tok: Tok.NONE, val: '', next: p };
  const c = raw[p]!;
  switch (c) {
    case 0x7b: return { tok: Tok.OBJ_OPEN, val: '', next: p + 1 };
    case 0x7d: return { tok: Tok.OBJ_CLOSE, val: '', next: p + 1 };
    case 0x5b: return { tok: Tok.ARR_OPEN, val: '', next: p + 1 };
    case 0x5d: return { tok: Tok.ARR_CLOSE, val: '', next: p + 1 };
    case 0x3a: return { tok: Tok.COLON, val: '', next: p + 1 };
    case 0x2c: return { tok: Tok.COMMA, val: '', next: p + 1 };
    case 0x6e: // n
    case 0x74: // t
    case 0x66: // f
      if (startsWith(raw, p, 'null')) return { tok: Tok.NULL, val: '', next: p + 4 };
      if (startsWith(raw, p, 'true')) return { tok: Tok.TRUE, val: '', next: p + 4 };
      if (startsWith(raw, p, 'false')) return { tok: Tok.FALSE, val: '', next: p + 5 };
      return { tok: Tok.ERR, val: '', next: p };
    case 0x22: {
      p++;
      const w = new Utf8Filter();
      for (;;) {
        if (p >= end || raw[p]! < 0x20) return { tok: Tok.ERR, val: '', next: p };
        const ch = raw[p]!;
        if (ch === 0x5c) {
          p++;
          if (p >= end) return { tok: Tok.ERR, val: '', next: p };
          switch (raw[p]) {
            case 0x22: w.pushByte(0x22); break;
            case 0x5c: w.pushByte(0x5c); break;
            case 0x2f: w.pushByte(0x2f); break;
            case 0x62: w.pushByte(0x08); break;
            case 0x66: w.pushByte(0x0c); break;
            case 0x6e: w.pushByte(0x0a); break;
            case 0x72: w.pushByte(0x0d); break;
            case 0x74: w.pushByte(0x09); break;
            case 0x75: {
              // Core requires 4 hex digits AND at least one more byte after them (raw + 1 + 4 >= end => error).
              if (p + 1 + 4 >= end) return { tok: Tok.ERR, val: '', next: p };
              let cp = 0;
              for (let i = 1; i <= 4; i++) {
                const h = raw[p + i]!;
                let d: number;
                if (isDigit(h)) d = h - 0x30;
                else if (h >= 0x61 && h <= 0x66) d = h - 0x61 + 10;
                else if (h >= 0x41 && h <= 0x46) d = h - 0x41 + 10;
                else return { tok: Tok.ERR, val: '', next: p };
                cp = 16 * cp + d;
              }
              w.pushCodepoint(cp);
              p += 4;
              break;
            }
            default:
              return { tok: Tok.ERR, val: '', next: p };
          }
          p++;
        } else if (ch === 0x22) {
          p++;
          break;
        } else {
          w.pushByte(ch);
          p++;
        }
      }
      if (!w.finalize()) return { tok: Tok.ERR, val: '', next: p };
      return { tok: Tok.STRING, val: binary(w.out), next: p };
    }
    default:
      if (c === 0x2d || isDigit(c)) {
        const first = p;
        let firstDigit = first;
        if (!isDigit(raw[firstDigit])) firstDigit++;
        if (raw[firstDigit] === 0x30 && isDigit(raw[firstDigit + 1])) return { tok: Tok.ERR, val: '', next: p };
        let num = String.fromCharCode(raw[p]!);
        p++;
        if (raw[first] === 0x2d && p < end && !isDigit(raw[p])) return { tok: Tok.ERR, val: '', next: p };
        while (p < end && isDigit(raw[p])) num += String.fromCharCode(raw[p++]!);
        if (p < end && raw[p] === 0x2e) {
          num += '.';
          p++;
          if (p >= end || !isDigit(raw[p])) return { tok: Tok.ERR, val: '', next: p };
          while (p < end && isDigit(raw[p])) num += String.fromCharCode(raw[p++]!);
        }
        if (p < end && (raw[p] === 0x65 || raw[p] === 0x45)) {
          num += String.fromCharCode(raw[p++]!);
          if (p < end && (raw[p] === 0x2d || raw[p] === 0x2b)) num += String.fromCharCode(raw[p++]!);
          if (p >= end || !isDigit(raw[p])) return { tok: Tok.ERR, val: '', next: p };
          while (p < end && isDigit(raw[p])) num += String.fromCharCode(raw[p++]!);
        }
        return { tok: Tok.NUMBER, val: num, next: p };
      }
      return { tok: Tok.ERR, val: '', next: p };
  }
}

const EXP_OBJ_NAME = 1;
const EXP_COLON = 2;
const EXP_ARR_VALUE = 4;
const EXP_VALUE = 8;
const EXP_NOT_VALUE = 16;

/**
 * Port of UniValue::read() (univalue_read.cpp:262-445). Returns whatever was built before the first error.
 * Containers are attached to their parent when OPENED (like Core), so a failure inside a nested container leaves a
 * partial container behind, and a key may exist without a value (keys.length > values.length).
 */
export function parseCoreJson(raw: Uint8Array): CoreJsonResult {
  let root: JVal | undefined;
  let expect = 0;
  const stack: Array<Extract<JVal, { t: 'obj' | 'arr' }>> = [];
  let pos = 0;
  let tok: Tok = Tok.NONE;
  let lastTok: Tok = Tok.NONE;

  const fail = (): CoreJsonResult => ({ wellFormed: false, root });

  do {
    lastTok = tok;
    const lx = lex(raw, pos);
    tok = lx.tok;
    if (tok === Tok.NONE || tok === Tok.ERR) return fail();
    pos = lx.next;

    const isValueOpen = tok === Tok.NULL || tok === Tok.TRUE || tok === Tok.FALSE || tok === Tok.NUMBER || tok === Tok.STRING || tok === Tok.OBJ_OPEN || tok === Tok.ARR_OPEN;

    if (expect & EXP_VALUE) {
      if (!isValueOpen) return fail();
      expect &= ~EXP_VALUE;
    } else if (expect & EXP_ARR_VALUE) {
      if (!(isValueOpen || tok === Tok.ARR_CLOSE)) return fail();
      expect &= ~EXP_ARR_VALUE;
    } else if (expect & EXP_OBJ_NAME) {
      if (!(tok === Tok.OBJ_CLOSE || tok === Tok.STRING)) return fail();
    } else if (expect & EXP_COLON) {
      if (tok !== Tok.COLON) return fail();
      expect &= ~EXP_COLON;
    } else if (!(expect & EXP_COLON) && tok === Tok.COLON) {
      return fail();
    }

    if (expect & EXP_NOT_VALUE) {
      if (isValueOpen) return fail();
      expect &= ~EXP_NOT_VALUE;
    }

    switch (tok) {
      case Tok.OBJ_OPEN:
      case Tok.ARR_OPEN: {
        const node: JVal = tok === Tok.OBJ_OPEN ? { t: 'obj', keys: [], values: [] } : { t: 'arr', values: [] };
        if (stack.length === 0) root = node;
        else stack[stack.length - 1]!.values.push(node);
        stack.push(node);
        if (stack.length > MAX_JSON_DEPTH) return fail();
        expect |= tok === Tok.OBJ_OPEN ? EXP_OBJ_NAME : EXP_ARR_VALUE;
        break;
      }
      case Tok.OBJ_CLOSE:
      case Tok.ARR_CLOSE: {
        if (stack.length === 0 || lastTok === Tok.COMMA) return fail();
        const top = stack[stack.length - 1]!;
        if ((tok === Tok.OBJ_CLOSE ? 'obj' : 'arr') !== top.t) return fail();
        stack.pop();
        expect &= ~EXP_OBJ_NAME;
        expect |= EXP_NOT_VALUE;
        break;
      }
      case Tok.COLON: {
        if (stack.length === 0) return fail();
        if (stack[stack.length - 1]!.t !== 'obj') return fail();
        expect |= EXP_VALUE;
        break;
      }
      case Tok.COMMA: {
        if (stack.length === 0 || lastTok === Tok.COMMA || lastTok === Tok.ARR_OPEN) return fail();
        expect |= stack[stack.length - 1]!.t === 'obj' ? EXP_OBJ_NAME : EXP_ARR_VALUE;
        break;
      }
      case Tok.NULL:
      case Tok.TRUE:
      case Tok.FALSE:
      case Tok.NUMBER: {
        const v: JVal = tok === Tok.NULL ? { t: 'null' } : tok === Tok.TRUE ? { t: 'bool', v: true } : tok === Tok.FALSE ? { t: 'bool', v: false } : { t: 'num', s: lx.val };
        if (stack.length === 0) {
          root = v;
          break;
        }
        stack[stack.length - 1]!.values.push(v);
        expect |= EXP_NOT_VALUE;
        break;
      }
      case Tok.STRING: {
        if (expect & EXP_OBJ_NAME) {
          const top = stack[stack.length - 1]! as Extract<JVal, { t: 'obj' }>;
          top.keys.push(lx.val);
          expect &= ~EXP_OBJ_NAME;
          expect |= EXP_COLON;
        } else {
          const v: JVal = { t: 'str', s: lx.val };
          if (stack.length === 0) {
            root = v;
            break;
          }
          stack[stack.length - 1]!.values.push(v);
        }
        expect |= EXP_NOT_VALUE;
        break;
      }
      default:
        return fail();
    }
  } while (stack.length > 0);

  // "Check that nothing follows the initial construct"
  const trailing = lex(raw, pos);
  if (trailing.tok !== Tok.NONE) return fail();
  return { wellFormed: true, root };
}

/** UniValue::operator[](key) on an object: first match; undefined when absent or the value is missing (keys > values). */
export function lookup(obj: Extract<JVal, { t: 'obj' }>, key: string): JVal | undefined {
  const i = obj.keys.indexOf(key);
  if (i < 0) return undefined;
  return obj.values[i]; // may be undefined if the parse stopped between a key and its value (Core: out_of_range => "not found")
}

/** std::from_chars<int64_t> over the lexeme: `-?[0-9]+` within range, nothing else. */
export function numToInt64(s: string): bigint | undefined {
  if (!/^-?[0-9]+$/.test(s)) return undefined;
  const v = BigInt(s);
  if (v < -(1n << 63n) || v >= 1n << 63n) return undefined;
  return v;
}

/** ParseDouble(): finite number or undefined. */
export function numToDouble(s: string): number | undefined {
  if (s === '-' || s.length === 0) return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
}
