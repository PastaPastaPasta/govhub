// A DASH amount's approximate current value in USD, the family way (design/PRICE.md): "≈ $309,000", three significant figures, with
// its source beside it as a tag rather than in the sentence ("Coinbase price, 01:51 UTC"; the full fetch time in its title and to
// screen readers). The tag turns to a warning when the price is stale (10 minutes) or the latest refresh failed; after an hour the
// value gives way to "USD price unavailable", and there is nothing at all before a first good quote or off Mainnet.
import { useApp } from '../app/context.tsx';
import { formatUsdApprox, formatUtc, usdView } from '../data/price.ts';
import { useNow } from './vote/common.tsx';

export function UsdValue({ duffs, what }: { duffs: number; what?: string }) {
  const { gov } = useApp();
  const now = useNow(30_000, !!gov.usd.quote);
  const v = usdView(gov.usd, now);
  if (v.kind === 'none') return null;
  if (v.kind === 'unavailable') return <span className="usd muted small" data-testid="usd">USD price unavailable</span>;
  const flags = [v.stale ? 'stale' : '', v.failed ? 'refresh failed' : ''].filter(Boolean);
  const when = formatUtc(v.fetchedAt);
  const time = when.replace(/^.*, /, '');
  return (
    <span className="usd small" data-testid="usd">
      <span className="usd-value">
        {what ? `${what} ` : ''}≈ {formatUsdApprox((duffs / 1e8) * v.rate)}
      </span>
      <span
        className={`dh-src${flags.length ? ' dh-src--warn' : ''}`}
        title={`An approximate current valuation, not a chain fact: DASH/USD spot fetched by this browser from ${v.source} on ${when}.`}
        data-testid="usd-source"
      >
        {v.source} price, {time}
        {flags.length > 0 && `, ${flags.join(', ')}`}
        <span className="visually-hidden"> (fetched by this browser on {when})</span>
      </span>
    </span>
  );
}
