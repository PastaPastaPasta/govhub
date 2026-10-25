// The landing summary: when the next payout is, how much of the budget is promised, and what it takes to pass. The strip shows
// each proposal in the next budget as a segment of the treasury.
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { formatDash, formatDashAmount, formatDate, formatDuration, formatInt, formatPercent } from '../lib/format.ts';
import { fundingThreshold, superblockCadence, votingDeadlineTime } from '../lib/governance.ts';
import { budgetView, countNames, proposalHref } from '../lib/view.ts';

export function BudgetHeader() {
  const { gov, source, params, activeRows } = useApp();
  const cycle = gov.cycle.data;
  const now = source.now();

  // No backend for this profile: the banner above says so, and there is no cycle to show.
  if (source.notice) return null;
  if (gov.cycle.loading && !cycle) {
    return (
      <section className="budget budget-loading" aria-busy="true" aria-label="Budget">
        <p className="budget-line muted">Loading the budget…</p>
      </section>
    );
  }
  if (!cycle) {
    return (
      <section className="budget" aria-label="Budget">
        <p className="budget-line">No budget has been published yet.</p>
        <p className="muted small">{gov.cycle.error ? `Platform read failed: ${gov.cycle.error}` : 'The bridge publishes one for every payout. Add a bridge in Settings to see live numbers.'}</p>
      </section>
    );
  }

  const c = cycle.value;
  const untilSb = c.estTime - now;
  const deadline = votingDeadlineTime(c, params);
  const untilDeadline = deadline - now;
  // Proposals that failed verification are not in the strip; the allocation is the cycle document's own figure.
  const { funded, fundedSum, allocated, active } = budgetView(
    activeRows.shown.map((r) => r.item),
    c,
  );
  const names = countNames(activeRows.shown.map((r) => r.item.p.value));
  const allocatedFrac = c.budget ? Math.min(1, allocated / c.budget) : 0;
  const available = Math.max(0, c.budget - allocated);
  const threshold = fundingThreshold(c.validWeighted, params);
  const height = gov.height.data?.value;

  return (
    <section className="budget" aria-labelledby="budget-title">
      <h2 id="budget-title" className="budget-line">
        {untilSb > 0 ? (
          <>
            Next payout in <span className="num">{formatDuration(untilSb)}</span>
          </>
        ) : (
          'The next payout is due any moment'
        )}
      </h2>
      <p className="budget-sub">
        {untilDeadline > 0 ? (
          <>
            Masternodes can vote for another <b>{formatDuration(untilDeadline)}</b>, until {formatDate(deadline)}.
          </>
        ) : (
          'Voting for this payout has closed.'
        )}
      </p>

      <div className="strip" role="img" aria-label={`Allocated ${formatDash(allocated)} of ${formatDash(c.budget)} (${formatPercent(allocatedFrac)}) across ${funded.length} proposals`}>
        {funded.map((r) => (
          <Link
            key={r.p.value.govHash}
            to={proposalHref(r.p.value, names)}
            className="strip-seg"
            style={{ flexGrow: r.p.value.paymentAmount }}
            title={`${r.p.value.name}: ${formatDash(r.p.value.paymentAmount)}`}
            aria-hidden="true"
            tabIndex={-1}
          />
        ))}
        {/* Allocation the cycle reports beyond the proposals listed here (e.g. not yet published). */}
        {allocated > fundedSum && <span className="strip-other" style={{ flexGrow: allocated - fundedSum }} title={`${formatDash(allocated - fundedSum)} allocated to proposals not listed here`} />}
        <span className="strip-free" style={{ flexGrow: Math.max(0, c.budget - Math.max(allocated, fundedSum)) }} />
      </div>

      <p className="budget-compact">
        <b>{formatDashAmount(available)} DASH</b> still available; <b>{formatInt(funded.length)}</b> of {formatInt(active)} proposals in the budget
      </p>
      <dl className="budget-facts">
        <div>
          <dt>Allocated</dt>
          <dd>
            <span className="num">{formatDashAmount(allocated)}</span> of {formatDash(c.budget)}
            {gov.usd && <span className="muted"> (about ${formatInt(Math.round((c.budget / 1e8) * gov.usd.value))})</span>}
          </dd>
        </div>
        <div>
          <dt>Still available</dt>
          <dd>
            <span className="num">{formatDashAmount(available)}</span> DASH
          </dd>
        </div>
        <div>
          <dt>In the budget</dt>
          <dd>
            <span className="num">{formatInt(funded.length)}</span> of {formatInt(active)} proposals
          </dd>
        </div>
        <div>
          <dt>To pass</dt>
          <dd>
            <span className="num">{formatInt(threshold)}</span> net yes votes
          </dd>
        </div>
      </dl>
      <details className="learn">
        <summary>How funding works</summary>
        <p className="strip-legend small muted">
          <span className="legend-item">
            <span className="key key-seg" /> each blue segment is a proposal in the next budget
          </span>
          <span className="legend-item">
            <span className="key key-free" /> still available
          </span>
        </p>
        <p className="small">
          The treasury pays out {superblockCadence(params)}, in a special block (a superblock; this one is block {formatInt(c.superblockHeight)}
          {height ? `, the chain is at ${formatInt(height)}` : ''}). A proposal is paid if its yes votes minus its no votes reach 10% of all masternode
          weight ({formatInt(threshold)} of {formatInt(c.validWeighted)}; evonodes count 4 times). Passing proposals are paid best first until the budget of{' '}
          {formatDash(c.budget)} runs out. Votes count until {formatDate(deadline)}, a few days before the payout.
        </p>
      </details>
    </section>
  );
}
