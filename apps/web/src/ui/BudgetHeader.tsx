import { ChainShield } from './trust/ChainShield.tsx';
// The landing summary: when the next payout is, how much of the budget is promised, and what it takes to pass. The strip shows
// each proposal in the next budget as a segment of the treasury.
import { Link } from './Link.tsx';
import { UsdValue } from './UsdValue.tsx';
import { useApp } from '../app/context.tsx';
import { formatDash, formatDashAmount, formatDate, formatDuration, formatInt, formatPercent, dashUnit } from '../lib/format.ts';
import { fundingThreshold, superblockCadence, votingDeadlineTime } from '../lib/governance.ts';
import { budgetView, countNames, proposalHref } from '../lib/view.ts';

export function BudgetHeader() {
  const { gov, source, params, activeRows, reload } = useApp();
  const cycle = gov.cycle.data;
  const now = source.now();

  // No backend for this profile: the banner above says so, and there is no cycle to show.
  if (source.notice) return null;
  if (gov.cycle.loading && !cycle) {
    return (
      <section className="budget dh-page-header dh-loading" aria-busy="true" aria-label="Budget">
        <h1 className="dh-page-header__title">Loading the budget…</h1>
      </section>
    );
  }
  if (!cycle) {
    return (
      <section className="budget dh-page-header" aria-label="Budget">
        <h1 className="dh-page-header__title">Active proposals</h1><p className="dh-page-header__lede">No budget has been published yet.</p>
        <p className="muted small">{gov.cycle.error ? `Platform read failed: ${gov.cycle.error}` : 'The bridge publishes one for every payout. Add a bridge in Settings to see live numbers.'}</p>
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
    <section className="budget dh-page-header" aria-labelledby="budget-title">
      <h1 id="budget-title" className="dh-page-header__title">
        {untilSb > 0 ? (
          <>
            Next payout in <span className="num">{formatDuration(untilSb)}</span>
          </>
        ) : (
          'The next payout is due any moment'
        )}
      </h1>
      <p className="dh-page-header__lede">
        {untilDeadline > 0 ? (
          <>
            Masternodes can vote for another <b>{formatDuration(untilDeadline)}</b>, until {formatDate(deadline)}.
          </>
        ) : (
          'Voting for this payout has closed.'
        )}
      </p>

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

      <p className="budget-compact">
        <b>{formatDashAmount(available)} {dashUnit()}</b> still available;{' '}
        {counting ? (
          'counting which proposals are in the budget…'
        ) : unknown ? (
          <>
            {noList ? 'the proposals' : 'the votes'} couldn’t be read just now, so which proposals are in the budget isn’t known.{' '}
            <button type="button" className="linkish dh-btn dh-btn--link" onClick={reload} data-testid="budget-retry">
              Try again
            </button>
          </>
        ) : (
          <>
            {unreadDue > 0 && 'at least '}
            <b>{formatInt(funded.length)}</b> of {formatInt(active)} proposals in the budget
            {unreadDue > 0 && ` (the votes of ${formatInt(unreadDue)} weren’t read)`}
            {later > 0 && `; plus ${formatInt(later)} that start${laterS} paying later`}
          </>
        )}
      </p>
      <dl className="budget-facts">
        <div>
          <dt>Allocated</dt>
          <dd>
            <span className="num">{formatDashAmount(allocated)}</span> of {formatDash(c.budget)}
            <UsdValue duffs={c.budget} what="Budget" />
          </dd>
        </div>
        <div>
          <dt>Still available</dt>
          <dd>
            <span className="num">{formatDashAmount(available)}</span> {dashUnit()}
          </dd>
        </div>
        <div>
          <dt>In the budget</dt>
          <dd data-testid="budget-in">
            {counting ? (
              <span className="muted">
                <span className="spinner" aria-hidden="true" /> counting the votes…
              </span>
            ) : unknown ? (
              <span className="muted">not known: the {noList ? 'proposals' : 'votes'} couldn’t be read</span>
            ) : (
              <>
                {unreadDue > 0 && <span className="muted">at least </span>}
                <span className="num">{formatInt(funded.length)}</span> of {formatInt(active)} proposals
                {later > 0 && <span className="muted"> (plus {formatInt(later)} that start{laterS} paying at a later superblock)</span>}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>To pass</dt>
          <dd>
            <span className="num">{formatInt(threshold)}</span> net yes votes
          </dd>
        </div>
      </dl>
      <p className="budget-more">
        <Link to="/treasury" data-testid="budget-treasury" className="dh-link dh-link--go">
          What this budget pays for, and how it compares
        </Link>
      </p>
      <div className="chain-context dh-page-header__meta"><span>Chain check</span><ChainShield /></div>
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
