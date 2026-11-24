// @vitest-environment happy-dom
// The budget's USD value as an estimate, with its source as a tag beside it: the time today, the date otherwise, "Stale" past ten
// minutes, a failed refresh said in the tag, nothing before a first quote.
import { describe, expect, it, vi } from 'vitest';
import type { UsdState } from '../data/price.ts';
import { render } from '../test/render.tsx';

const NOW = Date.UTC(2026, 10, 6, 2, 0);
const hold = vi.hoisted(() => ({ usd: null as unknown, now: 0 }));
vi.mock('../app/context.tsx', () => ({ useApp: () => ({ gov: { usd: hold.usd } }) }));
vi.mock('./vote/common.tsx', () => ({ useNow: () => hold.now || NOW }));
const { UsdValue } = await import('./UsdValue.tsx');

const at = async (usd: UsdState) => {
  hold.usd = usd;
  const r = await render(<UsdValue duffs={6828.26e8} />);
  const out = { value: r.el.querySelector('.usd-value')?.textContent ?? null, tag: r.el.querySelector('.usd-source') };
  await r.unmount();
  return out;
};
const quote = (minutesAgo: number) => ({ rate: 45.1, source: 'Coinbase', fetchedAt: NOW - minutesAgo * 60_000 });

describe('UsdValue', () => {
  it('shows an estimate with its source and time beside it', async () => {
    const { value, tag } = await at({ quote: quote(9), failedAt: null });
    expect(value).toBe('≈ $308,000');
    expect(tag!.className).toBe('usd-source muted');
    expect(tag!.textContent).toBe('Coinbase price, 01:51 UTC (Coinbase price fetched by this browser on 6 Nov 2026, 01:51 UTC)');
  });
  it('dates a price fetched before midnight', async () => {
    hold.now = Date.UTC(2026, 10, 6, 0, 5);
    const { tag } = await at({ quote: { ...quote(0), fetchedAt: Date.UTC(2026, 10, 5, 23, 58) }, failedAt: null });
    hold.now = 0;
    expect(tag!.textContent).toMatch(/^Coinbase price, 5 Nov 2026, 23:58 UTC \(/);
  });
  it('turns the tag into a warning when stale or when a refresh failed', async () => {
    const stale = await at({ quote: quote(11), failedAt: null });
    expect(stale.tag!.className).toBe('usd-source muted error');
    expect(stale.tag!.textContent).toMatch(/^Stale \(/);
    const failed = await at({ quote: quote(6), failedAt: NOW - 60_000 });
    expect(failed.tag!.className).toBe('usd-source muted error');
    expect(failed.tag!.textContent).toMatch(/^Coinbase price, 01:54 UTC, refresh failed/);
  });
  it('shows nothing before a first good quote', async () => {
    expect((await at({ quote: null, failedAt: null })).value).toBeNull();
  });
});
