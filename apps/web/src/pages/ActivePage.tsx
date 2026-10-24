import { useMemo } from 'react';
import { urlClaimIdentity } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { BudgetHeader } from '../ui/BudgetHeader.tsx';
import { ProposalCard } from '../ui/ProposalCard.tsx';
import { useReveal } from '../ui/hooks.ts';
import { useCommentCounts } from '../ui/useCommentCounts.ts';
import { byRank, countNames, deriveRow, proposalHref } from '../lib/view.ts';

export function ActivePage() {
  const { gov, source, params, registry } = useApp();
  const now = source.now();
  const rows = useMemo(() => {
    const ps = gov.active.data ?? [];
    return ps.map((p) => deriveRow(p, gov.tallies, gov.bridgeTallies, gov.cycle.data ?? null, params, now)).sort(byRank);
  }, [gov.active.data, gov.tallies, gov.bridgeTallies, gov.cycle.data, params, now]);
  const names = useMemo(() => countNames(rows.map((r) => r.p.value)), [rows]);
  const { count, sentinel, more } = useReveal(rows.length, 12);
  const shown = useMemo(() => rows.slice(0, count), [rows, count]);
  const counts = useCommentCounts(useMemo(() => shown.map((r) => r.p.value.govHash), [shown]));

  return (
    <>
      <BudgetHeader />
      <section aria-labelledby="active-title" className="list-section">
        <div className="list-head">
          <h1 id="active-title">Active proposals</h1>
          <p className="muted">Sorted by rank: net yes votes, the order Core funds them in.</p>
        </div>
        {gov.active.loading && rows.length === 0 ? (
          <div className="grid" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="card card-skeleton" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="empty">No active proposals to show.</p>
        ) : (
          <div className="grid">
            {shown.map((r) => (
              <ProposalCard
                key={r.p.value.govHash}
                row={r}
                href={proposalHref(r.p.value, names)}
                comments={counts.get(r.p.value.govHash)}
                urlOwner={r.content.ok ? urlClaimIdentity(r.p.value.url, r.p.value.name, registry.forum.claimPortals) : null}
              />
            ))}
          </div>
        )}
        <div ref={sentinel} className="sentinel" aria-hidden="true" />
        {more && <p className="muted small center">Scroll for more</p>}
      </section>
    </>
  );
}
