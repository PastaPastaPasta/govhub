import type { ReactNode } from 'react';
// The landing summary: when the next payout is, how much of the budget is promised, and what it takes to pass. The strip shows
// each proposal in the next budget as a segment of the treasury.
import { Link } from './Link.tsx';
import { ChainShield } from './trust/ChainShield.tsx';
import { UsdValue } from './UsdValue.tsx';
import { useApp } from '../app/context.tsx';
import { formatDash, formatDashAmount, formatDate, formatDuration, formatInt, formatPercent, dashUnit } from '../lib/format.ts';
import { fundingThreshold, superblockCadence, votingDeadlineTime } from '../lib/governance.ts';
import { budgetView, countNames, proposalHref } from '../lib/view.ts';

function BudgetTitle({ children, id, lede }: { children: ReactNode; id?: string; lede?: ReactNode }) {
  return <div className="dh-page-header__row">
    <div className="dh-page-header__text"><h1 id={id} className="dh-page-header__title">{children}</h1>{lede && <p className="dh-page-header__lede">{lede}</p>}</div>
    <div className="dh-page-header__actions"><Link to="/create" className="dh-btn dh-btn--secondary">New proposal</Link></div>
  </div>;
}

export function BudgetHeader() {
  const { gov, source, params, activeRows, reload } = useApp();
  const cycle = gov.cycle.data;
  const now = source.now();

  // No backend for this profile: the banner above says so, and there is no cycle to show.
  if (source.notice) return <header className="dh-page-header"><BudgetTitle>Proposals</BudgetTitle></header>;
  if (gov.cycle.loading && !cycle) {
    return (
      <section className="budget gov-hero dh-page-header dh-loading" aria-busy="true" aria-label="Budget">
        <BudgetTitle>Loading the budget…</BudgetTitle>
      </section>
    );
  }
  if (!cycle) {
    return (
      <section className="budget gov-hero dh-page-header" aria-label="Budget">
        <BudgetTitle>Active proposals</BudgetTitle>
        {gov.cycle.error ? (
          <>
            <p className="dh-page-header__lede">The budget could not be loaded right now.</p>
            <p className="muted small">
              {gov.cycle.error}{' '}
              <button type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={reload}>
                Try again
              </button>
            </p>
          </>
        ) : (
          <>
            <p className="dh-page-header__lede">No budget has been published yet.</p>
            <p className="muted small">One is published for every payout. Add a governance data service in Settings to see live numbers.</p>
          </>
        )}
      </section>
    );
  }

  const c = cycle.value;
  const untilSb = c.estTime - now;
  const deadline = votingDeadlineTime(c, params);
  const untilDeadline = deadline - now;
  // Proposals that failed verification are not in the strip; the allocation is the cycle document's own figure.
  const { funded, fundedSum, allocated, active, later } = budgetView(
    activeRows.shown.map((r) => r.item),
    c,
  );
  const laterS = later === 1 ? 's' : '';
  // names are counted over the lame ducks too: the cards link by hash when a name is shared with one
  const names = countNames([...activeRows.shown, ...activeRows.lameDucks].map((r) => r.item.p.value));
  const allocatedFrac = c.budget ? Math.min(1, allocated / c.budget) : 0;
  const available = Math.max(0, c.budget - allocated);
  const threshold = fundingThreshold(c.validWeighted, params);
  const height = gov.height.data?.value;
  // which proposals are in the budget comes from their tallies: no count (and no per-proposal strip) until both reads have answered,
  // and none at all when the proposals or their votes couldn't be read
  const counting = gov.talliesLoading;
  const noList = !!gov.active.error && !gov.active.data;
  const unknown = !counting && (gov.talliesFailed || noList);
  const noCount = counting || unknown;
  // proposals due now whose votes a failed read left unknown: the count is then a lower bound
  const unreadDue = activeRows.shown.filter((r) => !r.item.lameDuck && !r.item.startsLater && gov.untallied.has(r.item.p.value.govHash)).length;

  return (
    <section className="budget gov-hero dh-page-header" aria-labelledby="budget-title">
      <BudgetTitle id="budget-title" lede={untilDeadline > 0 ? <>
        Voting closes in <b>{formatDuration(untilDeadline)}</b>, on {formatDate(deadline)}.
      </> : 'Voting for this payout has closed.'}>
        {untilSb > 0 ? <>
          Next payout in <span className="num budget-countdown">{formatDuration(untilSb)}</span>
        </> : 'The next payout is due any moment'}
      </BudgetTitle>

      <div className="budget-panel">
      {/* The segments are links for the pointer only; an image role around them would be an interactive control nested in an image
          (axe nested-interactive), so assistive technology gets this sentence and the strip is hidden from it. */}
      <p className="visually-hidden">{`Allocated ${formatDash(allocated)} of ${formatDash(c.budget)} (${formatPercent(allocatedFrac)})${noCount ? '' : ` across ${funded.length} proposals`}`}</p>
      <div className="strip" aria-hidden="true">
        {!noCount && funded.map((r) => (
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
        {noCount ? (
          <span className="strip-other" style={{ flexGrow: allocated }} title={`${formatDash(allocated)} allocated`} />
        ) : (
          allocated > fundedSum && <span className="strip-other" style={{ flexGrow: allocated - fundedSum }} title={`${formatDash(allocated - fundedSum)} allocated to proposals not listed here`} />
        )}
        <span className="strip-free" style={{ flexGrow: Math.max(0, c.budget - Math.max(allocated, noCount ? 0 : fundedSum)) }} />
      </div>

      <dl className="budget-facts">
        <div className="gov-stat gov-stat--blue">
          <dt>Allocated</dt>
          <dd>
            <span className="num">{formatDashAmount(allocated)}</span> <small>of {formatDash(c.budget)}</small>
            <UsdValue duffs={c.budget} what="Budget" />
          </dd>
        </div>
        <div className={`gov-stat gov-stat--${available > 0 ? 'good' : 'warn'}`}>
          <dt>Still available</dt>
          <dd>
            <span className="num">{formatDashAmount(available)}</span> <small>{dashUnit()}</small>
          </dd>
        </div>
        <div className="gov-stat gov-stat--blue">
          <dt>In the budget</dt>
          <dd data-testid="budget-in">
            {counting ? (
              <span className="muted">
                <span className="spinner" aria-hidden="true" /> counting the votes…
              </span>
            ) : unknown ? (
              <span className="muted small">not known: the {noList ? 'proposals' : 'votes'} couldn’t be read</span>
            ) : (
              <>
                {unreadDue > 0 && <span className="muted">at least </span>}
                <span className="num">{formatInt(funded.length)}</span> <small>of {formatInt(active)} proposals</small>
                {later > 0 && <span className="gov-stat-note">Plus {formatInt(later)} that start{laterS} later</span>}
              </>
            )}
          </dd>
        </div>
        <div className="gov-stat">
          <dt>To pass</dt>
          <dd>
            <span className="num">{formatInt(threshold)}</span> <small>net yes votes</small><span className="gov-stat-note">Feed estimate, 10% of weight</span>
          </dd>
        </div>
      </dl>
      <div className="budget-foot">
        {unknown && <button type="button" className="dh-btn dh-btn--link" onClick={reload} data-testid="budget-retry">Try reading the budget again</button>}
        <div className="budget-line-links">
          <Link to="/treasury" data-testid="budget-treasury" className="dh-link dh-link--go">What the budget pays for</Link>
        </div>
        <div className="chain-context" data-testid="chain-context"><ChainShield /></div>
        <Link to="/create" className="budget-new dh-btn dh-btn--secondary dh-btn--sm">New proposal</Link>
        <details className="learn dh-disclosure">
        <summary>How funding works</summary>
        <p className="strip-legend small muted">
          <span className="legend-item">
            <span className="key key-seg" /> each blue segment is a proposal in the next budget
          </span>
          <span className="legend-item">
            <span className="key key-free" /> still available
          </span>
          {allocated > fundedSum && <span className="legend-item">
            <span className="key key-other" /> other allocation, not listed here
          </span>}
          <span className="legend-item">
            <span className="key key-notch" /> on each proposal, the pass line: {formatInt(threshold)} net yes votes
          </span>
        </p>
        <p className="small">
          The treasury pays out {superblockCadence(params)}, in a special block (a superblock; this one is block {formatInt(c.superblockHeight)}
          {height ? `, the chain is at ${formatInt(height)}` : ''}). A proposal is paid if its yes votes minus its no votes reach 10% of all masternode
          weight ({formatInt(threshold)} of {formatInt(c.validWeighted)} reported by the feed; evonodes count 4 times). Proposal pages use the masternode-list read when available, which can differ from this estimate. Passing proposals are paid best first until the budget of{' '}
          {formatDash(c.budget)} runs out. Votes count until {formatDate(deadline)}, a few days before the payout.
        </p>
        </details>
      </div>
      </div>
    </section>
  );
}
