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
const HAS_INVISIBLE = new RegExp(INVISIBLE_CLASS, 'u');
const BLANK = new RegExp(`[\\p{Cf}\\p{Cc}\\p{Z}\\s${BLANK_LETTERS}\\uFE00-\\uFE0F]`, 'gu');

/** True when nothing visible is left: whitespace, zero-width, bidi and other format characters only. */
export const isBlank = (s: string): boolean => s.replace(BLANK, '') === '';

/** A display name as it may be shown: invisible characters removed, runs of whitespace collapsed. */
export const cleanName = (s: string): string => s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();

/** Words and marks the UI itself puts next to names (the owner chip, badges): a name must not imitate them. */
const BADGE_WORDS = /\b(?:owner|verified|moderator|moderation|official|admin|masternode)\b/i;
const CHECK_MARKS = /[\u2611\u2713\u2714\u2705\u{1F5F8}\u{1F5F9}\u{2BBD}]/u;

/** The name contains text that reads like a govhub label or badge (compared after NFKC, so full-width letters count). */
export const badgeLike = (name: string): boolean => {
  const n = cleanName(name).normalize('NFKC');
  return BADGE_WORDS.test(n) || CHECK_MARKS.test(n);
};

/** Why a display name is refused by the profile editor, or null. Names already on Platform are cleaned at render time. */
export function nameProblem(name: string): string | null {
  const t = name.trim();
  if (HAS_INVISIBLE.test(t)) return "A name can't contain invisible or text-direction characters.";
  if (!cleanName(t)) return 'Enter a name.';
  if (badgeLike(t)) return 'A name can\'t contain badge text such as "owner", "verified" or \u2713: govhub adds those labels itself.';
  return null;
}
