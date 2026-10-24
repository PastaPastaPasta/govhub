import { useMemo, useState } from 'react';
import { urlClaimIdentity } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { BudgetHeader } from '../ui/BudgetHeader.tsx';
import { FailedProposalsToggle } from '../ui/HiddenToggle.tsx';
import { ProposalCard } from '../ui/ProposalCard.tsx';
import { useReveal } from '../ui/hooks.ts';
import { useCommentCounts } from '../ui/useCommentCounts.ts';
import { countNames, proposalHref } from '../lib/view.ts';

export function ActivePage() {
  const { gov, activeRows, registry } = useApp();
  const [showFailed, setShowFailed] = useState(false);
  const all = useMemo(() => [...activeRows.shown, ...activeRows.failed], [activeRows]);
  const rows = showFailed ? all : activeRows.shown;
  const names = useMemo(() => countNames(all.map((r) => r.item.p.value)), [all]);
  const { count, sentinel, more } = useReveal(rows.length, 12);
  const shown = useMemo(() => rows.slice(0, count), [rows, count]);
  const counts = useCommentCounts(useMemo(() => shown.map((r) => r.item.p.value.govHash), [shown]));
  const failed = activeRows.failed.length;

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
            {shown.map(({ item: r, check }) => (
              <ProposalCard
                key={r.p.value.govHash}
                row={r}
                check={check}
                href={proposalHref(r.p.value, names)}
                comments={counts.get(r.p.value.govHash)}
                urlOwner={r.content.ok ? urlClaimIdentity(r.p.value.url, r.p.value.name, registry.forum.claimPortals) : null}
              />
            ))}
          </div>
        )}
        <div ref={sentinel} className="sentinel" aria-hidden="true" />
        {more && <p className="muted small center">Scroll for more</p>}
        {!more && failed > 0 && <FailedProposalsToggle count={failed} shown={showFailed} onToggle={() => setShowFailed((v) => !v)} />}
      </section>
    </>
  );
}
