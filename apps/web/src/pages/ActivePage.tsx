import type { Profile } from '@govhub/forum';
import { useEffect, useMemo, useState } from 'react';
import { urlClaimIdentity } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { BudgetHeader } from '../ui/BudgetHeader.tsx';
import { FailedProposalsToggle } from '../ui/HiddenToggle.tsx';
import { ProposalCard } from '../ui/ProposalCard.tsx';
import { ProposalTabs } from '../ui/ProposalTabs.tsx';
import { useReveal } from '../ui/hooks.ts';
import { useCommentCounts } from '../ui/useCommentCounts.ts';
import { countNames, proposalHref } from '../lib/view.ts';

/** Display names of these identities (self-chosen profiles), for the owners named in proposal URLs. */
function useProfiles(ids: readonly string[]): ReadonlyMap<string, Profile> {
  const { forum } = useForum();
  const [map, setMap] = useState<ReadonlyMap<string, Profile>>(new Map());
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    forum.reader.profiles(key.split(',')).then((m) => live && setMap(m), () => {});
    return () => {
      live = false;
    };
  }, [forum, key]);
  return map;
}

export function ActivePage() {
  const { gov, activeRows, registry } = useApp();
  const [showFailed, setShowFailed] = useState(false);
  const all = useMemo(() => [...activeRows.shown, ...activeRows.failed], [activeRows]);
  const rows = showFailed ? all : activeRows.shown;
  const names = useMemo(() => countNames(all.map((r) => r.item.p.value)), [all]);
  // 12 rows first; the rest in one go once the reader scrolls (rows are tall, so small steps would stall the observer)
  const { count, sentinel, more } = useReveal(rows.length, 40, undefined, 12);
  const shown = useMemo(() => rows.slice(0, count), [rows, count]);
  const counts = useCommentCounts(useMemo(() => shown.map((r) => r.item.p.value.govHash), [shown]));
  const owners = useMemo(
    () => new Map(shown.map(({ item: r }) => [r.p.value.govHash, r.content.ok ? urlClaimIdentity(r.p.value.url, r.p.value.name, registry.forum.claimPortals) : null])),
    [shown, registry.forum.claimPortals],
  );
  const profiles = useProfiles([...owners.values()].filter((x): x is string => !!x));
  const failed = activeRows.failed.length;

  return (
    <>
      <BudgetHeader />
      <section aria-labelledby="active-title" className="list-section">
        <div className="list-head">
          <h1 id="active-title" className="visually-hidden">
            Active proposals
          </h1>
          <ProposalTabs />
          <p className="small muted">Best-supported first: the order the treasury pays them in.</p>
        </div>
        {gov.active.loading && rows.length === 0 ? (
          <div className="plist" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="prow prow-skeleton" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="empty">No active proposals right now.</p>
        ) : (
          <div className="plist">
            {shown.map(({ item: r, check }) => {
              const owner = owners.get(r.p.value.govHash) ?? null;
              return (
                <ProposalCard
                  key={r.p.value.govHash}
                  row={r}
                  check={check}
                  href={proposalHref(r.p.value, names)}
                  comments={counts.get(r.p.value.govHash)}
                  urlOwner={owner}
                  ownerProfile={owner ? profiles.get(owner) : undefined}
                />
              );
            })}
          </div>
        )}
        <div ref={sentinel} className="sentinel" aria-hidden="true" />
        {more && <p className="muted small center">Scroll for more</p>}
        {!more && failed > 0 && <FailedProposalsToggle count={failed} shown={showFailed} onToggle={() => setShowFailed((v) => !v)} />}
      </section>
    </>
  );
}
