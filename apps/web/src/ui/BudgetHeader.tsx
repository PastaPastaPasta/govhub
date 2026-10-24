// DashCentral budget header: next superblock ETA, voting deadline, budget total vs allocated,
// active proposal count. The budget strip shows each proposal in the next budget as a segment.
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { formatDash, formatDashAmount, formatDateTime, formatDuration, formatInt, formatPercent } from '../lib/format.ts';
import { fundingThreshold, votingDeadlineTime } from '../lib/governance.ts';
import { budgetView, countNames, proposalHref } from '../lib/view.ts';
import { ProvMark } from './Provenance.tsx';

export function BudgetHeader() {
  const { gov, source, params, activeRows } = useApp();
  const cycle = gov.cycle.data;
  const now = source.now();

  // No backend for this profile: the banner above says so, and there is no cycle to show.
  if (source.notice) return null;
  if (gov.cycle.loading && !cycle) {
    return (
      <section className="budget budget-loading" aria-busy="true" aria-label="Budget">
        <p className="budget-line muted">Loading the budget cycle…</p>
      </section>
    );
  }
  if (!cycle) {
    return (
      <section className="budget" aria-label="Budget">
        <p className="budget-line">No budget cycle has been published yet.</p>
        <p className="muted small">{gov.cycle.error ? `Platform read failed: ${gov.cycle.error}` : 'The bridge publishes a cycle document for every superblock. Add a bridge in Settings to see live numbers.'}</p>
      </section>
    );
  }

  const c = cycle.value;
  const untilSb = c.estTime - now;
  const deadline = votingDeadlineTime(c, params);
  const untilDeadline = deadline - now;
  // Proposals that failed verification are not counted: not allocated, not in the budget, not active.
  const { funded, fundedSum, allocated, active } = budgetView(
    activeRows.shown.map((r) => r.item),
    activeRows.failed.map((r) => r.item),
    c,
  );
  const names = countNames(activeRows.shown.map((r) => r.item.p.value));
  const allocatedFrac = c.budget ? Math.min(1, allocated / c.budget) : 0;
  const height = gov.height.data;
  const blocksLeft = height ? c.superblockHeight - height.value : null;

  return (
    <section className="budget" aria-labelledby="budget-title">
      <h2 id="budget-title" className="budget-line">
        Superblock <span className="num">{formatInt(c.superblockHeight)}</span> pays{' '}
        {untilSb > 0 ? (
          <>
            in <span className="num">{formatDuration(untilSb)}</span>
          </>
        ) : (
          <>any moment now</>
        )}
        <ProvMark prov={cycle.prov} />
      </h2>
      <p className="budget-sub">
        {untilDeadline > 0 ? (
          <>
            Voting closes in <b>{formatDuration(untilDeadline)}</b>, around {formatDateTime(deadline)} (block {formatInt(c.votingDeadlineHeight)}).
          </>
        ) : (
          <>Voting for this superblock has closed (block {formatInt(c.votingDeadlineHeight)}).</>
        )}{' '}
        {blocksLeft !== null && blocksLeft > 0 && (
          <>
            {formatInt(blocksLeft)} blocks to go at height {formatInt(height!.value)} <ProvMark prov={height!.prov} />
          </>
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

      <dl className="budget-facts">
        <div>
          <dt>Allocated</dt>
          <dd>
            <span className="num">{formatDashAmount(allocated)}</span> of {formatDash(c.budget)} <span className="muted">({formatPercent(allocatedFrac)})</span>
            {gov.usd && (
              <span className="muted">
                {' '}
                about ${formatInt(Math.round((c.budget / 1e8) * gov.usd.value))} total <ProvMark prov={gov.usd.prov} />
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Still available</dt>
          <dd>
            <span className="num">{formatDashAmount(Math.max(0, c.budget - allocated))}</span> DASH
          </dd>
        </div>
        <div>
          <dt>In the next budget</dt>
          <dd>
            <span className="num">{formatInt(funded.length)}</span> of {formatInt(active)} active proposals
          </dd>
        </div>
        <div>
          <dt>Passing threshold</dt>
          <dd>
            <span className="num">{formatInt(fundingThreshold(c.validWeighted, params))}</span> net yes{' '}
            <span className="muted">(10% of {formatInt(c.validWeighted)} weighted MNs)</span>
          </dd>
        </div>
      </dl>
    </section>
  );
}
