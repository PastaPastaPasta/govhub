// Display formatting. Pure; locale is a parameter so tests are stable.

export const DUFFS_PER_DASH = 100_000_000;

const nf = (locale: string, min: number, max: number) =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max });

/** Duffs to a DASH string without unit: 2 decimals for amounts >= 1, up to 8 below that, trailing zeros trimmed. */
export function formatDashAmount(duffs: number, locale = 'en-US'): string {
  const dash = duffs / DUFFS_PER_DASH;
  if (dash === 0) return '0';
  if (Math.abs(dash) >= 1000) return nf(locale, 0, 0).format(Math.round(dash));
  if (Math.abs(dash) >= 1) return nf(locale, 0, 2).format(dash);
  return nf(locale, 0, 8).format(dash);
}

export function formatDash(duffs: number, locale = 'en-US'): string {
  return `${formatDashAmount(duffs, locale)} DASH`;
}

export function formatInt(n: number, locale = 'en-US'): string {
  return nf(locale, 0, 0).format(n);
}

export function formatSigned(n: number, locale = 'en-US'): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatInt(Math.abs(n), locale)}`;
}

export function formatPercent(fraction: number, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(fraction);
}

/** "XdWkmF…sa62": keeps the network-identifying prefix and enough tail to compare. */
export function shortAddress(addr: string, head = 6, tail = 4): string {
  return addr.length <= head + tail + 1 ? addr : `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function shortHash(hex: string, n = 8): string {
  return hex.length <= n * 2 + 1 ? hex : `${hex.slice(0, n)}…${hex.slice(-n)}`;
}

/** Days with one decimal below 10, whole days above; hours below one day. Negative = in the past. */
export function formatDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 3600) return `${Math.max(1, Math.round(abs / 60))} min`;
  if (abs < 86400) {
    const h = Math.round(abs / 3600);
    return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  const d = abs / 86400;
  const v = d < 10 ? Math.round(d * 10) / 10 : Math.round(d);
  return `${v} ${v === 1 ? 'day' : 'days'}`;
}

/** "in 6.2 days" / "3 hours ago". */
export function formatRelative(targetS: number, nowS: number): string {
  const delta = targetS - nowS;
  return delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(delta)} ago`;
}

export function formatDate(unixS: number, locale = 'en-US', timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(unixS * 1000);
}

/** "Jan 2027": for an estimate too rough for a day. */
export function formatMonth(unixS: number, locale = 'en-US', timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', ...(timeZone ? { timeZone } : {}) }).format(unixS * 1000);
}

export function formatDateTime(unixS: number, locale = 'en-US', timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone, timeZoneName: 'short' } : {}),
  }).format(unixS * 1000);
}

/** 1 duff = 1,000 Platform credits. */
export const CREDITS_PER_DUFF = 1000;

/** Platform credits as DASH. `approx` rounds to two significant digits for fee estimates ("about 0.00056 DASH"). */
export function formatCredits(credits: number | bigint, approx = false, locale = 'en-US'): string {
  const duffs = Number(credits) / CREDITS_PER_DUFF;
  if (!approx || duffs === 0) return formatDash(Math.round(duffs), locale);
  return `${nf(locale, 0, 8).format(Number((duffs / DUFFS_PER_DASH).toPrecision(2)))} DASH`;
}

/** "3 hours ago" for a Platform millisecond timestamp. */
export const formatAgoMs = (ms: number, nowS: number): string => (Math.abs(ms / 1000 - nowS) < 90 ? 'just now' : formatRelative(Math.floor(ms / 1000), nowS));

/**
 * A thrown value as text fit to show the user. evo-sdk throws WASM error objects that are not `Error`s (their `message` is a getter on
 * the prototype): String() of those is "[object Object]".
 */
export const errText = (e: unknown): string => {
  const m = e && typeof e === 'object' && 'message' in e ? (e as { message: unknown }).message : undefined;
  return typeof m === 'string' && m ? m : String(e);
};

/** Hostname of a proposal URL for display, or null when it is not an http(s) URL. */
export function urlHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : null;
  } catch {
    return null;
  }
}
