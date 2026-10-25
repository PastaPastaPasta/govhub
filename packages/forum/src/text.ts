// Invisible and direction-changing characters in user text (comments, display names). Rendered text never carries bidi
// controls (they can reverse a filename or a name on screen), names never carry any invisible character (they can make
// one name look like another), and a body made only of invisible characters counts as empty.

/** Bidi embeddings, overrides, isolates and marks (ALM, LRM, RLM, LRE..RLO, LRI..PDI). */
export const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export const stripBidi = (s: string): string => s.replace(BIDI_CONTROLS, '');

/** Format (Cf: zero-width, bidi, tags, soft hyphen) and control (Cc) characters, plus letters that render as blank. */
/** Letters and marks that render as nothing (combining grapheme joiner, Hangul and Khmer fillers, Mongolian separator, braille blank). */
const BLANK_LETTERS = '\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u2800\\u3164\\uFFA0';
const INVISIBLE_CLASS = `[\\p{Cf}\\p{Cc}${BLANK_LETTERS}]`;
const INVISIBLE = new RegExp(INVISIBLE_CLASS, 'gu');
const BLANK = new RegExp(`[\\p{Cf}\\p{Cc}\\p{Z}\\s${BLANK_LETTERS}\\uFE00-\\uFE0F]`, 'gu');

/** True when nothing visible is left: whitespace, zero-width, bidi and other format characters only. */
export const isBlank = (s: string): boolean => s.replace(BLANK, '') === '';

const ZWJ = '\u200D';
const PICTO = /\p{Extended_Pictographic}/u;
/** Keeps a zero-width joiner between two pictographs (family and profession emoji); drops every other invisible character. */
const stripInvisible = (s: string): string =>
  s.replace(INVISIBLE, (ch: string, at: number) => {
    if (ch !== ZWJ) return '';
    const before = s.slice(0, at).replace(/[\uFE0F\p{Emoji_Modifier}]+$/u, ''); // a variation selector or skin tone after the emoji
    const prev = String.fromCodePoint(before.codePointAt(before.length - 1) ?? 0);
    const prevHigh = before.length >= 2 ? String.fromCodePoint(before.codePointAt(before.length - 2) ?? 0) : '';
    const next = String.fromCodePoint(s.codePointAt(at + 1) ?? 0);
    return (PICTO.test(prev) || PICTO.test(prevHigh)) && PICTO.test(next) ? ch : '';
  });

/** A display name as it may be shown: invisible characters removed (emoji joiners kept), runs of whitespace collapsed. */
export const cleanName = (s: string): string => stripInvisible(s).replace(/\s+/g, ' ').trim();

/** Words and marks the UI itself puts next to names (the owner chip, badges): a name must not imitate them. */
const BADGE_WORDS = /(?<![a-z])(?:owner|verified|moderator|moderation|official|admin|masternode)(?![a-z])/i;
const CHECK_MARKS = /[\u221A\u2611\u2713\u2714\u2705\u{1F5F8}\u{1F5F9}\u2BBD]/u;
/** Cyrillic and Greek letters (and digits and symbols) that look like Latin ones, folded before the badge-word check. */
const CONFUSABLE_FROM = [...'\u0430\u0435\u043E\u0440\u0441\u0443\u0445\u0456\u0458\u0455\u0501\u0261\u043A\u043C\u043D\u0442\u0432\u0438\u03BF\u03BD\u03B1\u03B5\u03B9\u03BA\u03C1\u03C4\u03C5\u03C703457@$'];
const CONFUSABLE_TO = 'aeopcyxijsdgkmhtbuovaeikptuxoeastas';
const CONFUSABLE = new Map(CONFUSABLE_FROM.map((c, i) => [c, CONFUSABLE_TO[i]!]));
/** Lower case, NFKC, combining marks dropped (o\u0332wner is owner), look-alikes folded, separators as spaces. */
const skeleton = (s: string): string =>
  [...cleanName(s).normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC').toLowerCase()]
    .map((c) => CONFUSABLE.get(c) ?? c)
    .join('')
    .replace(/[_\-.\s]+/g, ' ');
const LATIN = /\p{Script=Latin}/u;
const LOOKALIKE_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;

/**
 * The name reads like a govhub label or badge or a DPNS name: badge words (after NFKC and folding look-alike letters and digits,
 * so "0wner", "Verifi\u0435d" and full-width letters count), check marks, a ".dash" ending, or Latin mixed with Cyrillic or Greek.
 */
export const badgeLike = (name: string): boolean => {
  const n = cleanName(name).normalize('NFKC');
  const sk = skeleton(n); // a 1 can stand for an i or an l
  return BADGE_WORDS.test(sk.replace(/1/g, 'i')) || BADGE_WORDS.test(sk.replace(/1/g, 'l')) || CHECK_MARKS.test(n) || /\.dash$/i.test(n) || (LATIN.test(n) && LOOKALIKE_SCRIPT.test(n));
};

/** Why a display name is refused by the profile editor, or null. Names already on Platform are cleaned at render time. */
export function nameProblem(name: string): string | null {
  const t = name.trim();
  if (stripInvisible(t) !== t) return "A name can't contain invisible or text-direction characters.";
  if (!cleanName(t)) return 'Enter a name.';
  const n = t.normalize('NFKC');
  if (/\.dash$/i.test(n)) return 'A name can\'t end in ".dash": that reads as a DPNS username, which govhub shows only when Platform proves it.';
  if (LATIN.test(n) && LOOKALIKE_SCRIPT.test(n)) return "A name can't mix Latin letters with Cyrillic or Greek ones: they can imitate each other.";
  if (badgeLike(t)) return 'A name can\'t contain badge text such as "owner", "verified" or \u2713: govhub adds those labels itself.';
  return null;
}
