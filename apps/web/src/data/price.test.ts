// The family price rule (design/PRICE.md): the exact pair and a positive finite amount, or no price; labels by age; no fallback.
import { describe, expect, it } from 'vitest';
import { parseRegistry, profileRegistry } from '../config/registry.ts';
import { COINBASE_SPOT, EXPIRE_MS, fetchSpot, formatUsd, formatUtc, parseSpot, STALE_MS, usdView } from './price.ts';

const spot = (amount: unknown, base = 'DASH', currency = 'USD') => ({ data: { amount, base, currency } });
const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('parseSpot', () => {
  it('takes a DASH-USD amount', () => expect(parseSpot(spot('48.74'))).toBe(48.74));
  it('refuses another pair', () => {
    expect(parseSpot(spot('48.74', 'BTC'))).toBeNull();
    expect(parseSpot(spot('48.74', 'DASH', 'USDT'))).toBeNull();
  });
  it('refuses zero, negative, non-finite and non-numeric amounts', () => {
    for (const a of ['0', '0.0', '-1', 'NaN', 'Infinity', '1e400', '', 'abc', 48.74, null]) expect(parseSpot(spot(a))).toBeNull();
  });
  it('refuses other shapes', () => {
    expect(parseSpot({ dash: { usd: 30 } })).toBeNull();
    expect(parseSpot(null)).toBeNull();
  });
});

describe('fetchSpot', () => {
  it('returns the rate with its source and this browser’s fetch time', async () => {
    expect(await fetchSpot(COINBASE_SPOT, () => 1234, answer(spot('50.5')))).toEqual({ rate: 50.5, source: 'Coinbase', fetchedAt: 1234 });
  });
  it('fails on an HTTP error or a bad body (no fallback)', async () => {
    await expect(fetchSpot(COINBASE_SPOT, Date.now, answer(spot('50'), 503))).rejects.toThrow('HTTP 503');
    await expect(fetchSpot(COINBASE_SPOT, Date.now, answer(spot('50', 'DASH', 'EUR')))).rejects.toThrow('DASH-USD');
  });
  it('fails when the request times out', async () => {
    const hang = ((_: string, init: RequestInit) =>
      new Promise((_, reject) => {
        const fail = () => reject(init.signal!.reason);
        if (init.signal!.aborted) fail();
        else init.signal!.addEventListener('abort', fail);
      })) as unknown as typeof fetch;
    const abortNow = (() => {
      const real = AbortSignal.timeout;
      AbortSignal.timeout = () => AbortSignal.abort(new DOMException('timed out', 'TimeoutError'));
      return () => (AbortSignal.timeout = real);
    })();
    try {
      await expect(fetchSpot(COINBASE_SPOT, Date.now, hang)).rejects.toThrow('timed out');
    } finally {
      abortNow();
    }
  });
});

describe('usdView', () => {
  const quote = { rate: 48.74, source: 'Coinbase', fetchedAt: 1_000_000 };
  it('shows nothing before a first good quote', () => expect(usdView({ quote: null, failedAt: 5 }, 0).kind).toBe('none'));
  it('is fresh, then stale after 10 minutes, then unavailable after an hour', () => {
    expect(usdView({ quote, failedAt: null }, quote.fetchedAt + STALE_MS)).toMatchObject({ kind: 'shown', stale: false, failed: false });
    expect(usdView({ quote, failedAt: null }, quote.fetchedAt + STALE_MS + 1)).toMatchObject({ kind: 'shown', stale: true });
    expect(usdView({ quote, failedAt: null }, quote.fetchedAt + EXPIRE_MS + 1).kind).toBe('unavailable');
  });
  it('keeps the last good quote and its own time after a failed refresh', () => {
    expect(usdView({ quote, failedAt: quote.fetchedAt + 300_000 }, quote.fetchedAt + 300_001)).toMatchObject({ kind: 'shown', fetchedAt: quote.fetchedAt, failed: true });
  });
});

describe('formatting', () => {
  it('rounds USD to cents and names the UTC fetch time unambiguously', () => {
    expect(formatUsd(6828.2637816 * 48.74)).toBe('$332,809.58');
    expect(formatUtc(Date.UTC(2026, 10, 5, 14, 22, 59))).toBe('5 Nov 2026, 14:22 UTC');
  });
});

describe('saved settings', () => {
  it('move the old default price feed to Coinbase, and keep a custom one', () => {
    const saved = { ...profileRegistry('mainnet'), priceFeed: { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=dash&vs_currencies=usd' } };
    expect(parseRegistry(saved).registry?.priceFeed).toEqual(COINBASE_SPOT);
    const custom = { ...profileRegistry('mainnet'), priceFeed: { name: 'mine', url: 'https://price.example/spot' } };
    expect(parseRegistry(custom).registry?.priceFeed).toEqual({ name: 'mine', url: 'https://price.example/spot' });
  });
});
