// The family's DASH price rule (design/PRICE.md): Coinbase DASH/USD spot, fetched by this browser, shown as an approximate current
// valuation with its source and fetch time. Stale after 10 minutes, gone after an hour, never on Testnet. No fallback provider and no
// hard-coded rate: without a good quote there is no dollar figure.
import type { NamedUrl } from '../config/registry.ts';

export const COINBASE_SPOT: NamedUrl = { name: 'Coinbase', url: 'https://api.coinbase.com/v2/prices/DASH-USD/spot' };

export const REFRESH_MS = 5 * 60_000;
export const STALE_MS = 10 * 60_000;
export const EXPIRE_MS = 60 * 60_000;
const TIMEOUT_MS = 8_000;

export interface UsdQuote {
  /** USD per DASH, full precision (only the display rounds). */
  rate: number;
  /** Who quoted it ("Coinbase"). */
  source: string;
  /** When this browser received it (ms): the endpoint carries no quote time. */
  fetchedAt: number;
}

/** What the app holds: the last good quote, and when a refresh after it failed (null: the latest attempt succeeded). */
export interface UsdState {
  quote: UsdQuote | null;
  failedAt: number | null;
}

/** `{"data":{"amount":"48.74","base":"DASH","currency":"USD"}}`: the exact pair and a finite positive amount, or null. */
export function parseSpot(raw: unknown): number | null {
  const data = raw && typeof raw === 'object' ? (raw as { data?: unknown }).data : undefined;
  if (!data || typeof data !== 'object') return null;
  const { amount, base, currency } = data as Record<string, unknown>;
  if (base !== 'DASH' || currency !== 'USD' || typeof amount !== 'string' || !/^\d+(\.\d+)?$/.test(amount.trim())) return null;
  const rate = Number(amount);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export async function fetchSpot(feed: NamedUrl, now: () => number = Date.now, f: typeof fetch = fetch): Promise<UsdQuote> {
  const res = await f(feed.url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${feed.name} answered HTTP ${res.status}`);
  const rate = parseSpot(await res.json());
  if (rate === null) throw new Error(`${feed.name} did not answer with a DASH-USD price`);
  return { rate, source: feed.name, fetchedAt: now() };
}

export type UsdView =
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'shown'; rate: number; source: string; fetchedAt: number; stale: boolean; failed: boolean };

/** What to show at `nowMs`: the valuation with its labels, "USD price unavailable" past an hour, nothing before any good quote. */
export function usdView(s: UsdState, nowMs: number): UsdView {
  if (!s.quote) return { kind: 'none' };
  const age = nowMs - s.quote.fetchedAt;
  if (age > EXPIRE_MS) return { kind: 'unavailable' };
  return { kind: 'shown', rate: s.quote.rate, source: s.quote.source, fetchedAt: s.quote.fetchedAt, stale: age > STALE_MS, failed: s.failedAt !== null };
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "$332,332.18": a price itself, to the cent. */
export const formatUsd = (usd: number): string => USD.format(usd);

const SIG3 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 3 });
/**
 * An approximate valuation, as the family writes one: three significant figures in full ("$309,000", "$18,200", "$487"), to the cent
 * under $10, and from a million "$1.23 million". Anything more precise would claim more than a spot price times an amount knows.
 */
export function formatUsdApprox(usd: number): string {
  if (usd < 10) return USD.format(usd);
  const rounded = Number(usd.toPrecision(3));
  if (rounded >= 1e6) return `$${(rounded / 1e6).toLocaleString('en-US', { maximumSignificantDigits: 3 })} million`;
  return SIG3.format(rounded);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "5 Nov 2026, 14:22 UTC" */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}
