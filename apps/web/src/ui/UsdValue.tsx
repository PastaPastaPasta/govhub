// A DASH amount's approximate current value in USD, the family way (design/PRICE.md): "≈ $309,000", with its source beside it as a
// tag rather than in the sentence ("Coinbase price, 01:51 UTC", the date added when it isn't today; the full fetch time in its title
// and to screen readers). Past 10 minutes the tag is a warning, "Stale"; a failed refresh says so in the tag. After an hour the value
// gives way to "USD price unavailable", and there is nothing at all before a first good quote or off Mainnet.
import { useApp } from '../app/context.tsx';
import { formatUsdEstimate, formatUtc, usdView } from '../data/price.ts';
import { useNow } from './vote/common.tsx';

const dayOf = (ms: number): string => formatUtc(ms).slice(0, -11);

/** `what`: what is valued, when the line doesn't already say it ("Budget ≈ $308,000"). */
export function UsdValue({ duffs, what }: { duffs: number; what?: string }) {
  const { gov } = useApp();
  const now = useNow(30_000, !!gov.usd.quote);
  const v = usdView(gov.usd, now);
  if (v.kind === 'none') return null;
  if (v.kind === 'unavailable') return <span className="usd muted small" data-testid="usd">USD price unavailable</span>;
  const when = formatUtc(v.fetchedAt);
  // "01:51 UTC" today, "5 Nov 2026, 01:51 UTC" otherwise
  const time = dayOf(v.fetchedAt) === dayOf(now) ? when.slice(-9) : when;
  const failed = v.failed ? ', refresh failed' : '';
  const label = v.stale ? `Stale${failed}` : `${v.source} price, ${time}${failed}`;
  return (
    <span className="usd small dh-meta" data-testid="usd">
      <span className="usd-value">
        {what ? `${what} ` : ''}
        {formatUsdEstimate((duffs / 1e8) * v.rate)}
      </span>
      <span
        className={`usd-source muted${v.stale || v.failed ? ' error' : ''}`}
        title={`An approximate current valuation, not a chain fact: DASH/USD spot fetched by this browser from ${v.source} on ${when}.`}
        data-testid="usd-source"
      >
        {label}
        <span className="visually-hidden"> ({v.source} price fetched by this browser on {when})</span>
      </span>
    </span>
  );
}
