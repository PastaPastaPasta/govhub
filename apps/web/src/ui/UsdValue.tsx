// A DASH amount's approximate current value in USD, the family way (design/PRICE.md): "≈ $X", the source and fetch time beside it,
// "stale" after 10 minutes, "refresh failed" when the latest refresh did not answer, "USD price unavailable" after an hour, and nothing
// at all before a first good quote or off Mainnet.
import { useApp } from '../app/context.tsx';
import { formatUsd, formatUtc, usdView } from '../data/price.ts';
import { useNow } from './vote/common.tsx';

export function UsdValue({ duffs, what }: { duffs: number; what: string }) {
  const { gov } = useApp();
  const now = useNow(30_000, !!gov.usd.quote);
  const v = usdView(gov.usd, now);
  if (v.kind === 'none') return null;
  if (v.kind === 'unavailable') return <span className="usd muted small" data-testid="usd">USD price unavailable</span>;
  const flags = [v.stale ? 'stale' : '', v.failed ? 'refresh failed' : ''].filter(Boolean);
  const when = formatUtc(v.fetchedAt);
  return (
    <span className="usd small" data-testid="usd">
      <span className="usd-value">
        {what} ≈ {formatUsd((duffs / 1e8) * v.rate)}
      </span>{' '}
      <span className="usd-source muted" title={`An approximate current valuation, not a chain fact: DASH/USD spot fetched by this browser from ${v.source} at ${when}.`}>
        price from {v.source}, <span className="visually-hidden">fetched by this browser </span>
        {when}
        {flags.length > 0 && <b className="usd-flag"> · {flags.join(' · ')}</b>}
      </span>
    </span>
  );
}
