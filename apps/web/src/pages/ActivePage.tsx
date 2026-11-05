import type { Profile } from '@govhub/forum';
import { useRouteTitle } from '../app/title.ts';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Proposal } from '../data/types.ts';
import { formatInt } from '../lib/format.ts';
import { urlClaimIdentity } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { BudgetHeader } from '../ui/BudgetHeader.tsx';
import { FailedProposalsToggle } from '../ui/HiddenToggle.tsx';
import { LameDuckSection } from '../ui/LameDuck.tsx';
import { ProposalCard } from '../ui/ProposalCard.tsx';
import { ProposalTabs } from '../ui/ProposalTabs.tsx';
import { useReveal } from '../ui/hooks.ts';
import { useCommentCounts } from '../ui/useCommentCounts.ts';
import { countNames, proposalHref, type Checked, type Row } from '../lib/view.ts';
import { onlyUnreached, unfinishedReason } from '../lib/netError.ts';

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

/** A search over what a proposal is known by: its name, its payee address, its website. */
function matches(p: Proposal, needle: string): boolean {
  return p.name.toLowerCase().includes(needle) || p.paymentAddress.toLowerCase().startsWith(needle) || p.url.toLowerCase().includes(needle);
}

type Sort = 'order' | 'new' | 'amount' | 'close';
const SORTS: Array<{ id: Sort; label: string; note: string }> = [
  { id: 'order', label: 'Payout order', note: 'Best-supported first: the order the treasury pays them in, as reported. Each proposal’s page checks its own figures in your browser.' },
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
  const [showFailed, setShowFailed] = useState(false);
  const [showLameDucks, setShowLameDucks] = useState(false);
  const all = useMemo(() => [...activeRows.shown, ...activeRows.failed], [activeRows]);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const sort = sortOf(params.get('sort'));
  const setSort = (v: Sort) => {
    const next = new URLSearchParams(params);
    if (v === 'order') next.delete('sort');
    else next.set('sort', v);
    setParams(next, { replace: true });
  };
  const needle = q.trim().toLowerCase();
  const setQ = (v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set('q', v);
    else next.delete('q');
    setParams(next, { replace: true });
  };
  const listed = showFailed ? all : activeRows.shown;
  const rows = useMemo(() => sorted(needle ? listed.filter((r) => matches(r.item.p.value, needle)) : listed, sort), [listed, needle, sort]);
  // a search also finds the lame ducks, listed with the rest instead of behind their toggle
  const lameDucks = useMemo(() => (needle ? activeRows.lameDucks.filter((r) => matches(r.item.p.value, needle)) : activeRows.lameDucks), [activeRows.lameDucks, needle]);
  const names = useMemo(() => countNames([...all, ...activeRows.lameDucks].map((r) => r.item.p.value)), [all, activeRows.lameDucks]);
  // 12 rows first; the rest in one go once the reader scrolls (rows are tall, so small steps would stall the observer). Search results all show.
  const { count, sentinel, more: moreToReveal } = useReveal(rows.length, 40, undefined, 12);
  const more = moreToReveal && !needle;
  const shown = useMemo(() => (needle ? rows : rows.slice(0, count)), [rows, count, needle]);
  // the lame ducks are few and listed once the reader opens them; their comment counts and owners are read with the rest
  const cards = useMemo(() => [...shown, ...lameDucks], [shown, lameDucks]);
  const counts = useCommentCounts(useMemo(() => cards.map((r) => r.item.p.value.govHash), [cards]));
  const owners = useMemo(
    () => new Map(cards.map(({ item: r }) => [r.p.value.govHash, r.content.ok ? urlClaimIdentity(r.p.value.url, r.p.value.name, registry.forum.claimPortals) : null])),
    [cards, registry.forum.claimPortals],
  );
  const profiles = useProfiles([...owners.values()].filter((x): x is string => !!x));
  const failed = activeRows.failed.length;
  function card({ item: r, check }: Checked<Row>) {
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
  }

  return (
    <>
      <BudgetHeader />
      <section aria-label="Active proposals" className="list-section">
        <div className="list-head">
          <ProposalTabs />
          <p className="small muted" data-testid="list-order-note">{SORTS.find((x) => x.id === sort)!.note}</p>
          <div className="list-tools">
            <label className="contests-search proposal-search dh-field__label">
              <span className="visually-hidden">Find a proposal by name, title, payee address or website</span>
              <input className="dh-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a proposal" autoComplete="off" spellCheck={false} data-testid="proposal-search" />
            </label>
            <label className="list-sort dh-field__label">
              <span>Sort</span>
              <select className="dh-input dh-select" value={sort} onChange={(e) => setSort(sortOf(e.target.value))} data-testid="proposal-sort">
                {SORTS.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {needle && (
            <p className="small muted proposal-search-count" role="status" data-testid="proposal-search-count">
              {rows.length + lameDucks.length === 0
                ? `No active proposal matches “${q.trim()}”.`
                : `${formatInt(rows.length + lameDucks.length)} of ${formatInt(listed.length + activeRows.lameDucks.length)} active proposals match “${q.trim()}”.`}
            </p>
          )}
        </div>
        <UncheckedNote rows={[...all, ...activeRows.lameDucks]} />
        {gov.active.loading && rows.length === 0 ? (
          <div className="plist" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="prow prow-skeleton" />
            ))}
          </div>
        ) : rows.length === 0 && !needle ? (
          <p className="empty dh-empty">No active proposals right now.</p>
        ) : rows.length + lameDucks.length === 0 ? null : (
          <div className="plist">
            {shown.map(card)}
            {needle && lameDucks.map(card)}
          </div>
        )}
        <div ref={sentinel} className="sentinel" aria-hidden="true" />
        {more && <p className="muted small center">Scroll for more</p>}
        {!more && !needle && (
          <LameDuckSection count={lameDucks.length} open={showLameDucks} onToggle={() => setShowLameDucks((v) => !v)}>
            {lameDucks.map(card)}
          </LameDuckSection>
        )}
        {!more && failed > 0 && <FailedProposalsToggle count={failed} shown={showFailed} onToggle={() => setShowFailed((v) => !v)} />}
      </section>
    </>
  );
}
