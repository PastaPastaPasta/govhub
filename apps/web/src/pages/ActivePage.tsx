import type { Profile } from '@govhub/forum';
import { useRouteTitle } from '../app/title.ts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { urlClaimIdentity } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { Link } from '../ui/Link.tsx';
import { BudgetHeader } from '../ui/BudgetHeader.tsx';
import { FailedProposalsToggle } from '../ui/HiddenToggle.tsx';
import { LameDuckSection } from '../ui/LameDuck.tsx';
import { PendingProposals } from '../proposal/Pending.tsx';
import { ProposalCard } from '../ui/ProposalCard.tsx';
import { ProposalTabs } from '../ui/ProposalTabs.tsx';
import { useReveal } from '../ui/hooks.ts';
import { useCommentCounts } from '../ui/useCommentCounts.ts';
import { useDpnsNames } from '../ui/useDpnsNames.ts';
import { countNames, proposalHref, type Checked, type Row } from '../lib/view.ts';
import { onlyUnreached, unfinishedReason } from '../lib/netError.ts';
import { ownerPageOf, useOwnerPages } from '../lib/ownerPages.ts';
import { OwnerWordsNote } from '../ui/OwnerPage.tsx';
import { SlowRead } from '../ui/SlowRead.tsx';
import { ACTIVE_SORT_LABEL, ACTIVE_SORT_NOTE, ACTIVE_SORTS, compareActive, isPassing, matches, proposalFields, readActive, STATUS_LABEL, STATUSES, statusOk, writeActive, type Status } from '../lib/listQuery.ts';
import { authorLabel } from '../lib/social.ts';
import { ChipChoice, ChipToggle, NoMatches, ResultCount, SearchField, SortSelect, useQueryState } from '../ui/ListControls.tsx';
import { useUnvoted } from '../ui/useUnvoted.ts';

const SORT_OPTIONS = ACTIVE_SORTS.map((value) => ({ value, text: ACTIVE_SORT_LABEL[value] }));

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

type Sort = 'order' | 'new' | 'amount' | 'close';
const SORTS: Array<{ id: Sort; label: string; note: string }> = [
  { id: 'order', label: 'Payout order', note: 'Best-supported first: the order the treasury pays them in, as reported.' },
  { id: 'close', label: 'Closest to the line', note: 'Closest to the passing line first, either side: where a few votes decide.' },
  { id: 'new', label: 'Newest', note: 'Newest first, by when they were submitted.' },
  { id: 'amount', label: 'Largest request', note: 'Largest payment first.' },
];
const sortOf = (v: string | null): Sort => (SORTS.some((x) => x.id === v) ? (v as Sort) : 'order');

/** The list in another order; payout order is the bridge's own (already the list's). Stable, so ties keep payout order. */
function sorted(rows: readonly Checked<Row>[], by: Sort): Checked<Row>[] {
  if (by === 'order') return [...rows];
  const key = ({ item: r }: Checked<Row>): number => {
    switch (by) {
      case 'new':
        return -r.p.value.time;
      case 'amount':
        return -r.p.value.paymentAmount;
      case 'close':
        return r.absYes !== null && r.threshold ? Math.abs(r.absYes - r.threshold.value) : Infinity;
    }
  };
  return [...rows].sort((a, b) => key(a) - key(b));
}

/** One line for the background checks that could not finish (instead of a mark on every row), with a way to run them again. */
function UncheckedNote({ rows }: { rows: readonly Checked<Row>[] }) {
  const { checks } = useApp();
  // only the network failures (each card shows any other reason itself), with the reason of the rows counted
  const unfinished = rows.flatMap((r) => {
    const why = r.check.status === 'inconclusive' ? unfinishedReason(r.check.reason) : null;
    return why && onlyUnreached(why) ? [{ p: r.item.p.value, why }] : [];
  });
  if (!unfinished.length) return null;
  const reasons = new Set(unfinished.map((u) => u.why));
  const why = reasons.size === 1 ? unfinished[0]!.why : "this browser couldn't reach the network just now";
  return (
    <p className="list-note dh-notice dh-notice--warn small" data-testid="unchecked-note">
      {unfinished.length === rows.length ? 'These proposals' : `${unfinished.length} of these proposals`} couldn't be checked against the chain: {why}. Their amounts and
      votes are shown as reported.{' '}
      <button type="button" className="linkish dh-btn dh-btn--link" onClick={() => checks.retryUnfinished(unfinished.map((u) => u.p))} data-testid="unchecked-retry">
        Try again
      </button>
    </p>
  );
}

export function ActivePage() {
  useRouteTitle('/');
  const { gov, activeRows, registry } = useApp();
  const { moderation } = useForum();
  const [showFailed, setShowFailed] = useState(false);
  // null: closed, but opened by itself when only finished proposals match a filter
  const [lameDucksOpen, setLameDucksOpen] = useState<boolean | null>(null);
  const [query, setQuery] = useQueryState(readActive, writeActive);
  const all = useMemo(() => [...activeRows.shown, ...activeRows.failed], [activeRows]);
  const listed = showFailed ? all : activeRows.shown;
  const ownerPages = useOwnerPages();
  const everyRow = useMemo(() => [...all, ...activeRows.lameDucks], [all, activeRows.lameDucks]);
  const names = useMemo(() => countNames(everyRow.map((r) => r.item.p.value)), [everyRow]);
  // owners of every listed proposal (not only the revealed cards): a search finds proposals by their owner's name
  const owners = useMemo(
    () => new Map(everyRow.map(({ item: r }) => [r.p.value.govHash, r.content.ok ? urlClaimIdentity(r.p.value.url, r.p.value.name, registry.forum.claimPortals) : null])),
    [everyRow, registry.forum.claimPortals],
  );
  const ownerIds = useMemo(() => [...owners.values()].filter((x): x is string => !!x), [owners]);
  const profiles = useProfiles(ownerIds);
  const ownerNames = useDpnsNames(ownerIds);
  const shownOwner = useCallback(
    (govHash: string) => {
      const owner = owners.get(govHash) ?? null;
      return owner && !moderation.index.identityHidden(owner) ? owner : null; // on a block list: no name, as on the proposal page
    },
    [owners, moderation],
  );

  const hashes = useMemo(() => everyRow.map((r) => r.item.p.value.govHash), [everyRow]);
  const unvoted = useUnvoted(query.unvoted, hashes);
  const unvotedOn = query.unvoted && unvoted.available;
  const filtering = !!query.q.trim() || query.status !== 'all' || unvotedOn;
  const view = useMemo(() => {
    const keep = ({ item: r, check }: Checked<Row>) => {
      if (unvotedOn && unvoted.voted?.has(r.p.value.govHash)) return false;
      const owner = shownOwner(r.p.value.govHash);
      const label = owner ? authorLabel(owner, profiles.get(owner), ownerNames.get(owner)) : null;
      // the title the card shows: only for a proposal that matches its hash and passed its checks
      const title = r.content.ok && check.status !== 'failed' ? ownerPageOf(ownerPages, r.p.value)?.title : null;
      return matches(query.q, proposalFields(r.p.value, [label?.dpns, label?.name, title]));
    };
    const sort = compareActive(query.sort);
    const ordered = (xs: Checked<Row>[]) => (query.sort === 'rank' ? xs : xs.sort((a, b) => sort(a.item, b.item)));
    const matching = listed.filter(keep);
    const passing = matching.filter((x) => isPassing(x.item)).length;
    return {
      counts: { all: matching.length, passing, failing: matching.length - passing } satisfies Record<Status, number>,
      rows: ordered(matching.filter((x) => statusOk(x.item, query.status))),
      // finished proposals are neither passing nor not passing in any way that matters: a status filter leaves them out
      lameDucks: query.status === 'all' ? ordered(activeRows.lameDucks.filter(keep)) : [],
    };
  }, [listed, activeRows.lameDucks, query, unvotedOn, unvoted.voted, shownOwner, profiles, ownerNames, ownerPages]);
  const { rows, lameDucks } = view;
  const clear = () => setQuery({ q: '', status: 'all', unvoted: false });
  const duckOpen = lameDucksOpen ?? (filtering && rows.length === 0);

  // 12 rows first; the rest in one go once the reader scrolls (rows are tall, so small steps would stall the observer)
  const { count, sentinel, more } = useReveal(rows.length, 40, undefined, 12);
  const shown = useMemo(() => rows.slice(0, count), [rows, count]);
  // the lame ducks are few and listed once the reader opens them; their comment counts are read with the rest
  const cards = useMemo(() => [...shown, ...lameDucks], [shown, lameDucks]);
  const counts = useCommentCounts(useMemo(() => cards.map((r) => r.item.p.value.govHash), [cards]));
  const failed = activeRows.failed.length;
  function card({ item: r, check }: Checked<Row>) {
    const owner = owners.get(r.p.value.govHash) ?? null;
    const named = shownOwner(r.p.value.govHash);
    return (
      <ProposalCard
        key={r.p.value.govHash}
        row={r}
        check={check}
        href={proposalHref(r.p.value, names)}
        comments={counts.get(r.p.value.govHash)}
        urlOwner={owner}
        ownerProfile={named ? profiles.get(named) : undefined}
        ownerDpns={named ? ownerNames.get(named) : undefined}
      />
    );
  }

  return (
    <>
      <BudgetHeader />
      <section aria-label="Active proposals" className="list-section">
        <div className="list-head">
          <div className="dh-section__head gov-section-head">
            <h2 className="dh-section__title">Proposals <OwnerWordsNote proposals={cards.map((r) => r.item.p.value)} /></h2>
            <p className="small muted" data-testid="list-order-note">{ACTIVE_SORT_NOTE[query.sort]}</p>
            <Link to="/treasury" className="dh-link dh-link--go">Treasury history</Link>
          </div>
          <ProposalTabs />
        </div>
        <PendingProposals />
        {everyRow.length > 0 && (
          <div className="list-tools" role="search" aria-label="Active proposals">
            <SearchField label="Search active proposals" placeholder="Search by name, owner or address" value={query.q} onChange={(q, replace) => setQuery({ q }, { replace })} />
            <div className="list-tools-row">
              <ChipChoice
                name="status"
                label="Funding status"
                value={query.status}
                onChange={(status) => setQuery({ status })}
                options={STATUSES.map((value) => ({
                  value,
                  text: (
                    <>
                      {STATUS_LABEL[value]} <span className="count">{view.counts[value]}</span>
                    </>
                  ),
                }))}
              />
              {unvoted.available && (
                <ChipToggle checked={query.unvoted} onChange={(v) => setQuery({ unvoted: v })} title="Only proposals none of your masternodes has voted on" testId="filter-unvoted">
                  Not voted yet
                </ChipToggle>
              )}
              <SortSelect value={query.sort} options={SORT_OPTIONS} onChange={(sort) => setQuery({ sort })} />
            </div>
            {unvotedOn && unvoted.loading && (
              <p className="small muted" role="status">
                <span className="spinner" aria-hidden="true" /> Reading your masternodes' votes…
              </p>
            )}
            {unvotedOn && unvoted.error && <p className="small error">Your votes couldn't be read, so every proposal is listed: {unvoted.error}</p>}
            <ResultCount active={filtering} shown={rows.length} total={listed.length} what="proposals" onClear={rows.length + lameDucks.length ? clear : undefined} />
          </div>
        )}
        <UncheckedNote rows={everyRow} />
        {(gov.active.loading || gov.talliesLoading || gov.cycle.loading) && <SlowRead />}
        {gov.active.loading && all.length === 0 ? (
          <div className="plist" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="prow prow-skeleton" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          !filtering ? (
            // an unread list is not an empty one: the banner above says the read failed
            gov.active.error && !gov.active.data ? null : <p className="empty dh-empty">No active proposals right now.</p>
          ) : lameDucks.length === 0 ? (
            <NoMatches query={query.q} onClear={clear} />
          ) : null
        ) : (
          <div className="plist plist-proposals">
            <div className="plist-columns" aria-hidden="true"><span>Proposal</span><span>Requests</span><span>Standing</span><span>Votes</span></div>
            {shown.map(card)}
          </div>
        )}
        <div ref={sentinel} className="sentinel" aria-hidden="true" />
        {more && <p className="muted small center">Scroll for more</p>}
        {!more && (
          <LameDuckSection count={lameDucks.length} open={duckOpen} onToggle={() => setLameDucksOpen(!duckOpen)}>
            {lameDucks.map(card)}
          </LameDuckSection>
        )}
        {!more && failed > 0 && <FailedProposalsToggle count={failed} shown={showFailed} onToggle={() => setShowFailed((v) => !v)} />}
      </section>
    </>
  );
}
