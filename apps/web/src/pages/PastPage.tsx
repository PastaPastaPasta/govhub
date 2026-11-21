// Past: what the treasury paid and how each ended proposal turned out.
//
// "Payments" is the ledger: superblock by superblock, newest first, the treasury payments read from each superblock's
// coinbase in the verified chain (lib/ledger.ts), named when Governance has the proposal on record. "Proposals" lists the ended
// proposals Platform holds (newest end first, keyset-paged on endEpoch: repo.ts pastPage) with their outcome from those superblocks.
import { Slug } from '../ui/Slug.tsx';
import { OwnerWordsNote, ProposalLabel } from '../ui/OwnerPage.tsx';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRouteTitle } from '../app/title.ts';
import { Link } from '../ui/Link.tsx';
import { useApp } from '../app/context.tsx';
import type { Proposal, Sourced, Tally } from '../data/types.ts';
import { errText, formatDash, formatDate, formatInt, formatSigned } from '../lib/format.ts';
import { absoluteYes, perPayment } from '../lib/governance.ts';
import { leftOut, ledgerEntry, ledgerSummary, outcomeOf, type LedgerEntry, type LedgerLine, type LedgerSummary, type Outcome, type SuperblockRead } from '../lib/ledger.ts';
import { countNames, partitionByCheck, proposalHref } from '../lib/view.ts';
import { contentFailure, isFailed } from '../verify/checks.ts';
import { FailedNote, FailedProposalsToggle } from '../ui/HiddenToggle.tsx';
import { useReveal } from '../ui/hooks.ts';
import { ProposalTabs } from '../ui/ProposalTabs.tsx';
import { NoMatches, ResultCount, SearchField, SortSelect, useQueryState } from '../ui/ListControls.tsx';
import { comparePast, matches, nextPastSort, proposalFields, readPast, writePast, type Dir, type PastSort } from '../lib/listQuery.ts';
import { useLedger, type Ledger, type SuperblockSlot } from '../ui/useLedger.ts';
import { ChainProof } from '../ui/ProofTag.tsx';
import { DashValue } from '../ui/DashValue.tsx';

/** How many pages of ended proposals are read at most; past that the list says it stops. */
const PAST_PAGES = 20;

/** Ended proposals on Platform, every page (there are tens, not thousands), each page's tallies read as it arrives. */
function usePastProposals() {
  const { source } = useApp();
  const [items, setItems] = useState<Sourced<Proposal>[]>([]);
  const [tallies, setTallies] = useState(new Map<string, Sourced<Tally>>());
  // the list's read and its tallies' read: a tally that wasn't read is never "not recorded"
  const [talliesRead, setTalliesRead] = useState<'loading' | 'ok' | 'failed'>('loading');
  const [state, setState] = useState<{ loading: boolean; error?: string; capped?: boolean }>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const gen = useRef(0);
  useEffect(() => {
    let on = true;
    gen.current++;
    setItems([]);
    setTallies(new Map());
    setTalliesRead('loading');
    setState({ loading: true });
    let pending = 0;
    let failed = false;
    let listDone = false;
    const settled = () => on && listDone && pending === 0 && setTalliesRead(failed ? 'failed' : 'ok');
    const readTallies = (hashes: string[]) => {
      if (!hashes.length) return;
      pending++;
      source
        .tallies(hashes)
        .then(
          (t) => on && setTallies((prev) => new Map([...prev, ...t])),
          () => void (failed = true),
        )
        .finally(() => {
          pending--;
          settled();
        });
    };
    (async () => {
      let cursor: string | undefined;
      const all: Sourced<Proposal>[] = [];
      for (let page = 0; page < PAST_PAGES; page++) {
        const r = await source.pastPage(cursor);
        if (!on) return false;
        all.push(...r.items);
        setItems([...all]);
        readTallies(r.items.map((i) => i.value.govHash));
        if (!r.next) return false;
        cursor = r.next;
      }
      return true;
    })().then(
      (capped) => {
        listDone = true;
        if (on) setState({ loading: false, capped });
        settled();
      },
      (e) => {
        listDone = true;
        failed = true;
        if (on) setState({ loading: false, error: errText(e) });
        settled();
      },
    );
    return () => {
      on = false;
    };
  }, [source, attempt]);
  // a tally read that failed stays failed until it is retried: only the missing tallies are read again, the list stays
  const retryTallies = () => {
    const missing = items.map((i) => i.value.govHash).filter((h) => !tallies.has(h));
    if (!missing.length) return setTalliesRead('ok');
    setTalliesRead('loading');
    const g = gen.current;
    source.tallies(missing).then(
      (t) => g === gen.current && (setTallies((prev) => new Map([...prev, ...t])), setTalliesRead('ok')),
      () => g === gen.current && setTalliesRead('failed'),
    );
  };
  return { items, tallies, talliesRead, ...state, retry: () => setAttempt((n) => n + 1), retryTallies };
}

type View = 'payments' | 'proposals';

/** Phones list past proposals as cards, without column headings: the same orders as a menu. */
const PHONE_SORTS: readonly { value: `${PastSort}:${Dir}`; text: string }[] = [
  { value: 'ended:desc', text: 'Ended, newest first' },
  { value: 'ended:asc', text: 'Ended, oldest first' },
  { value: 'name:asc', text: 'Name, A to Z' },
  { value: 'name:desc', text: 'Name, Z to A' },
  { value: 'amount:desc', text: 'Largest amount' },
  { value: 'amount:asc', text: 'Smallest amount' },
  { value: 'yes:desc', text: 'Most net yes votes' },
  { value: 'yes:asc', text: 'Fewest net yes votes' },
];

export function PastPage() {
  useRouteTitle('/past');
  const { gov, checks } = useApp();
  const [search, setSearch] = useSearchParams();
  const view: View = search.get('view') === 'payments' ? 'payments' : 'proposals';
  const past = usePastProposals();
  const ledger = useLedger();
  const checksVersion = useSyncExternalStore(checks.subscribe, checks.getVersion);
  // every proposal on record that can name a payment: past and active, minus any whose shown fields don't match their hash
  const known = useMemo(
    () => [...past.items, ...(gov.active.data ?? [])].map((s) => s.value).filter((p) => !contentFailure(p) && !isFailed(checks.state(p))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [past.items, gov.active.data, checks, checksVersion],
  );
  const setView = (v: View) => {
    const sp = new URLSearchParams(search);
    if (v === 'proposals') sp.delete('view');
    else sp.set('view', v);
    setSearch(sp, { replace: true });
  };

  return (
    <section aria-labelledby="past-title" className="list-section past-page">
      <div className="list-head">
        <ProposalTabs />
      </div>
      <header className="past-head dh-page-header">
        <div className="past-title-line"><h1 className="dh-page-header__title" id="past-title">Past proposals</h1><OwnerWordsNote proposals={view === 'payments' ? known : past.items.map((i) => i.value)} /></div>
        <p className="dh-page-header__lede">Ended proposals, newest first, with their requested amounts and final reported votes. Payments by superblock are read from the chain in this browser.</p>
        <div className="dh-seg" role="group" aria-label="Show">
          <button className="dh-btn" type="button" aria-pressed={view === 'payments'} onClick={() => setView('payments')} data-testid="view-payments">
            Payments by superblock
          </button>
          <button className="dh-btn" type="button" aria-pressed={view === 'proposals'} onClick={() => setView('proposals')} data-testid="view-proposals">
            Proposals<span className="dh-count">{!past.loading && !past.error && past.items.length ? formatInt(past.items.length) : ''}</span>
          </button>
        </div>
      </header>
      {view === 'payments' ? <LedgerView ledger={ledger} known={known} past={past.items} pastError={past.error ?? null} /> : <ProposalsView past={past} ledger={ledger} known={known} />}
    </section>
  );
}

// ---- payments ---------------------------------------------------------------------------------------------------------------

function LedgerView({ ledger, known, past, pastError }: { ledger: Ledger; known: Proposal[]; past: Sourced<Proposal>[]; pastError: string | null }) {
  const { source, gov, checks } = useApp();
  // the proposals that can name a payment get their background check too: one that fails it stops naming payments
  useEffect(() => checks.ensure(past.map((i) => i.value)), [checks, past]);
  const network = source.coreNetwork;
  const names = useMemo(() => countNames(known), [known]);
  const entries = useMemo(
    () => (ledger.slots ?? []).map((s) => (s.state === 'read' ? { slot: s, entry: ledgerEntry(s.read, known, network) } : { slot: s, entry: null })),
    [ledger.slots, known, network],
  );
  if (ledger.unavailable) return <p className="notice-box dh-notice dh-notice--info small">{ledger.unavailable}</p>;
  if (!ledger.slots) {
    return gov.cycle.error ? (
      <p className="error small">The budget cycle couldn't be read, so Governance doesn't know where the last superblock is: {gov.cycle.error}</p>
    ) : (
      <p className="muted small">
        <span className="spinner" aria-hidden="true" /> Finding the last superblock…
      </p>
    );
  }
  const sum = ledgerSummary(entries.map((e) => ({ state: e.slot.state, entry: e.entry })));
  const failed = sum.kind === 'done' ? sum.failed : 0;
  // Governance's records hold the proposals that ended since its bridge began archiving, and the active ones: others show their payee
  const recordsFrom = past.length ? Math.min(...past.map((p) => p.value.endEpoch)) : null;
  const perSb = network === 'testnet' ? 'superblock (hourly on Testnet)' : 'superblock (about monthly)';
  return (
    <div className="ledger" data-testid="ledger">
      <LedgerStats sum={sum} perSb={perSb} />
      {/* one region that speaks once, when the totals are in: not at every superblock read */}
      <p className="visually-hidden" aria-live="polite" data-testid="ledger-announce">
        {sum.kind === 'done' && sum.counted ? `Totals ready: ${formatDash(Number(sum.paid))} paid in ${formatInt(sum.counted)} superblocks.` : ''}
      </p>
      <p className="small muted ledger-note" data-testid="ledger-status">
        Each payment is read from its superblock in the chain this browser verified; the first visit downloads and checks each block, later visits
        reuse them. Names come from the proposals Governance has on record: the active ones{recordsFrom ? <> and those that ended since {formatDate(recordsFrom)}</> : null}.
        A payment to any other proposal shows the address it went to.
        {pastError && <> The ended proposals couldn’t be read just now ({pastError}), so payments to them show their payee’s address.</>}
        {failed > 0 && (
          <>
            {' '}
            <button type="button" className="linkish dh-btn dh-btn--link" onClick={ledger.retry} data-testid="ledger-retry">
              Read the {failed === 1 ? 'missing superblock' : `${formatInt(failed)} missing superblocks`} again
            </button>
          </>
        )}
      </p>
      {entries.map(({ slot, entry }, i) => (
        <SuperblockPanel key={slot.height} slot={slot} entry={entry} names={names} open={i < 2} />
      ))}
      <div className="ledger-more">
        {ledger.canLoadMore ? (
          <button type="button" className="btn dh-btn" onClick={ledger.loadMore} disabled={sum.kind === 'reading'} data-testid="ledger-more">
            Show {network === 'testnet' ? 'the day' : 'the year'} before
          </button>
        ) : (
          <p className="small muted" data-testid="ledger-end">
            {network === 'testnet'
              ? 'That is two days of Testnet superblocks; Testnet pays one every hour.'
              : 'That is two years of superblocks: as far back as this browser can check blocks cheaply, against the block hashes this build pins. Older payments are on the chain, but checking them here would mean downloading a large share of its headers.'}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The ledger's headline figures. They are the ones people quote, so there are none until every superblock asked for is in: while
 * reading, only how far it got. Once done, anything the totals leave out (a superblock not read, a coinbase that doesn't split) is
 * said beside them.
 */
function LedgerStats({ sum, perSb }: { sum: LedgerSummary; perSb: string }) {
  if (sum.kind === 'reading') {
    return (
      <div className="ledger-stats ledger-stats-reading" data-testid="ledger-progress">
        <p className="ledger-progress-line">
          <span className="spinner" aria-hidden="true" /> Reading superblocks from the chain: <b>{formatInt(sum.settled)}</b> of {formatInt(sum.of)} so far.
        </p>
        <p className="small muted">The totals appear once all {formatInt(sum.of)} are in, so no figure here is a partial one.</p>
        <progress className="ledger-progress" max={sum.of} value={sum.settled} aria-label="Superblocks read" />
      </div>
    );
  }
  const left = leftOut(sum);
  const range = sum.oldest && sum.newest ? `, ${formatDate(sum.oldest)} to ${formatDate(sum.newest)}` : '';
  const scope = left ? `in ${formatInt(sum.counted)} of the ${formatInt(sum.of)} superblocks${range}; ${left.text}, so ${left.verb} left out` : `in ${formatInt(sum.counted)} superblock${sum.counted === 1 ? '' : 's'}${range}`;
  if (!sum.counted) {
    return (
      <p className="notice-box dh-notice dh-notice--warn small" data-testid="ledger-total">
        No superblock total could be read just now ({left?.text}).
      </p>
    );
  }
  return (
    <div className="ledger-stats">
      <p className="ledger-stats-compact">
        <span>Paid by the treasury{left ? ' (partial)' : ''}: <b data-testid="ledger-total">{left ? 'at least ' : ''}<DashValue duffs={sum.paid} /></b> <ChainProof weak={sum.weak} /></span>
        <span>Average: <b><DashValue duffs={sum.paid / BigInt(sum.counted)} /></b> per superblock{left ? ', of those read' : ''}</span>
        <span>Payments{left ? ' (partial)' : ''}: <b>{left ? 'at least ' : ''}{formatInt(sum.payments)}</b></span>
      </p>
      <p className="small muted" data-testid="ledger-scope">{scope}. Average per {perSb}; payments to proposals’ payees.</p>
    </div>
  );
}

/** One superblock: its date and total always in view; the payments open for the newest, a click away for the rest. */
function SuperblockPanel({ slot, entry, names, open }: { slot: SuperblockSlot; entry: LedgerEntry | null; names: ReadonlyMap<string, number>; open: boolean }) {
  const headId = `sb-${slot.height}`;
  return (
    <details className="dh-panel dh-panel--flush sb dh-disclosure" aria-labelledby={headId} data-testid="superblock" data-height={slot.height} open={open}>
      <summary className="sb-head">
        <span className="sb-summary">
        <span id={headId} role="heading" aria-level={2} className="sb-date dh-h3">
          {entry ? (
            formatDate(entry.read.time)
          ) : slot.state === 'error' ? (
            'Not read'
          ) : (
            <span className="sb-reading small muted">
              <span className="spinner" aria-hidden="true" /> Reading this superblock from the chain…
            </span>
          )}
        </span>
        <span className="sb-height small muted">superblock {formatInt(slot.height)}</span>
        {entry && <SbTotal entry={entry} />}
        </span>
      </summary>
      {slot.state === 'error' && <p className="sb-error small">Couldn't read this superblock: {slot.error}.</p>}
      {entry && <SbLines entry={entry} names={names} />}
    </details>
  );
}

function SbTotal({ entry }: { entry: LedgerEntry }) {
  const share = entry.total !== null && entry.limit > 0n ? Number((entry.total * 1000n) / entry.limit) / 10 : null;
  return (
    <span className="sb-total">
      {entry.total !== null ? (
        <>
          <b>{formatDash(Number(entry.total))}</b> paid
          <span className="muted small">
            {' '}
            · {formatInt(entry.lines!.length)} payment{entry.lines!.length === 1 ? '' : 's'} · {share !== null ? `${share}% of the ${formatDash(Number(entry.limit))} it could pay` : ''}
          </span>
        </>
      ) : (
        <span className="muted small">total not known (see below)</span>
      )}
      {entry.read.weak && <span className="small muted"> · consistent, not proven: {entry.read.weak}</span>}
    </span>
  );
}

function payeeLabel(line: LedgerLine): ReactNode {
  return line.payment.address ? (
    <dashhq-hash value={line.payment.address} label="payee address">
      {line.payment.address}
    </dashhq-hash>
  ) : (
    <span className="muted">a non-standard script</span>
  );
}

function SbLines({ entry, names }: { entry: LedgerEntry; names: ReadonlyMap<string, number> }) {
  if (!entry.lines) {
    return (
      <p className="sb-error small muted">
        This superblock's coinbase doesn't split cleanly into the block reward and the treasury's payments, so its total isn't shown rather than guessed.
      </p>
    );
  }
  return (
    <table className="dh-table sb-lines">
      <thead className="visually-hidden">
        <tr>
          <th scope="col">Paid to</th>
          <th scope="col">Amount</th>
        </tr>
      </thead>
      <tbody>
        {entry.lines.map((l) => (
          <tr key={l.payment.index}>
            <td role="rowheader" data-label="Proposal" className="dh-rc-title">
              {l.proposal ? (
                <>
                  <ProposalLabel p={l.proposal} to={proposalHref(l.proposal as Proposal, names)} />
                </>
              ) : l.candidates.length ? (
                <span>
                  One of{' '}
                  {l.candidates.map((c, i) => (
                    <span key={c.govHash}>
                      {i > 0 && ' or '}
                      <Link to={proposalHref(c as Proposal, names)} className="dh-link"><Slug name={c.name} /></Link>
                    </span>
                  ))}
                  <span className="small muted"> (same payee and amount)</span>
                </span>
              ) : (
                <span className="sb-payee">
                  {payeeLabel(l)}
                  <span className="small muted">
                    {l.samePayee ? (
                      <>
                        {' '}
                        not on record; same payee as <Link to={proposalHref(l.samePayee as Proposal, names)} className="dh-link"><Slug name={l.samePayee.name} /></Link>
                      </>
                    ) : (
                      ' not on record'
                    )}
                  </span>
                </span>
              )}
            </td>
            <td data-label="Amount" className="r num">{formatDash(Number(l.payment.amount))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- proposals --------------------------------------------------------------------------------------------------------------

const OUTCOME_TEXT: Record<Outcome['kind'], string> = {
  funded: 'Funded',
  partly: 'Partly funded',
  'not-funded': 'Not funded',
  'no-payout': 'Expired unpaid',
  unknown: 'Not checked',
};

/** An outcome counts over the superblocks read: none is shown until they all are (a partial count would read as the result). */
function OutcomeCell({ o, reading }: { o: Outcome | null; reading: boolean }) {
  if (!o || reading) return <span className="muted">{reading ? 'reading…' : '—'}</span>;
  const tone = o.kind === 'funded' ? 'pass' : o.kind === 'partly' ? 'warn' : o.kind === 'unknown' ? '' : 'fail';
  const why = o.partial === 'earlier' ? 'its window starts before the superblocks read' : o.partial === 'unread' ? 'a superblock in its window could not be read' : '';
  const detail =
    o.kind === 'no-payout'
      ? 'no superblock fell in its payment window'
      : o.kind === 'unknown'
        ? why
        : `paid ${formatInt(o.paid)} of ${formatInt(o.of)}${why ? ` read; ${why}` : ''}${o.shared ? `; ${formatInt(o.shared)} could also be a proposal with the same payee and amount` : ''}`;
  return (
    <span className={`outcome${tone ? ` outcome-${tone}` : ''}`} title={detail}>
      <span className="dot" aria-hidden="true" />
      {OUTCOME_TEXT[o.kind]}
      <span className="small muted outcome-detail"> · {detail}</span>
    </span>
  );
}

function ProposalsView({ past, ledger, known }: { past: ReturnType<typeof usePastProposals>; ledger: Ledger; known: Proposal[] }) {
  const { checks, params, source, gov } = useApp();
  const [showFailed, setShowFailed] = useState(false);
  const [query, setQuery] = useQueryState(readPast, writePast);
  const ordered = useMemo(() => {
    const found = past.items.filter((i) => matches(query.q, proposalFields(i.value)));
    if (query.sort === 'ended' && query.dir === 'desc') return found;
    const yes = (p: Proposal) => {
      const t = past.tallies.get(p.govHash);
      return t ? absoluteYes(t.value) : null;
    };
    const cmp = comparePast(query.sort, query.dir, yes);
    return found.sort((a, b) => cmp(a.value, b.value));
  }, [past.items, past.tallies, query]);
  const checksVersion = useSyncExternalStore(checks.subscribe, checks.getVersion);
  const parts = useMemo(
    () => partitionByCheck(ordered, (i) => checks.state(i.value)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ordered, checks, checksVersion],
  );
  const failedAll = useMemo(
    () => past.items.filter((i) => isFailed(checks.state(i.value))).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [past.items, checks, checksVersion],
  );
  const rows = showFailed ? [...parts.shown, ...parts.failed] : parts.shown;
  const searching = !!query.q.trim();
  const clear = () => setQuery({ q: '' });
  const header = (col: PastSort, text: string, className?: string) => {
    const on = query.sort === col;
    return (
      <th scope="col" className={className} aria-sort={on ? (query.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
        <button type="button" className={`sort-head${on ? ' on' : ''}`} onClick={() => setQuery(nextPastSort(query, col))} data-testid={`sort-${col}`}>
          {text}
          <span className="sort-arrow" aria-hidden="true">
            {on ? (query.dir === 'asc' ? '↑' : '↓') : '↕'}
          </span>
        </button>
      </th>
    );
  };
  const { count, sentinel } = useReveal(rows.length, 20, () => {});
  const names = useMemo(() => countNames(past.items.map((i) => i.value)), [past.items]);
  useEffect(() => checks.ensure(ordered.slice(0, count + 12).map((i) => i.value)), [checks, ordered, count]);
  const reads = useMemo(() => (ledger.slots ?? []).flatMap((s): SuperblockRead[] => (s.state === 'read' ? [s.read] : [])), [ledger.slots]);
  // Outcomes wait for the superblocks: still to be found (the budget cycle names the last one), or still being read. Once one is read,
  // a row waits only for those that may fall in its payment window (half a cycle's slack, a day at least), and the superblocks still
  // being read count as covered, so a row shown early says what it will say once every one is in.
  const cover = useMemo(() => {
    // an unread superblock's time, estimated from a read one: enough to know which windows it falls in
    const ref = reads[0];
    const at = (state: SuperblockSlot['state']) => (ref ? (ledger.slots ?? []).filter((s) => s.state === state).map((s) => ref.time + (s.height - ref.height) * params.blockSeconds) : []);
    const pending = at('reading');
    const oldest = reads.length ? Math.min(...reads.map((r) => r.time), ...pending) : null;
    return { oldest, unread: at('error'), pending };
  }, [reads, ledger.slots, params.blockSeconds]);
  const slack = Math.max((params.superblockCycle * params.blockSeconds) / 2, 86_400);
  const readingFor = (p: Proposal): boolean => {
    if (ledger.unavailable) return false;
    if (!ledger.slots) return !gov.cycle.error;
    if (!ledger.slots.some((s) => s.state === 'reading')) return false;
    return !reads.length || cover.pending.some((t) => t >= p.startEpoch - slack && t <= p.endEpoch + slack);
  };
  const outcomes = useMemo(
    () => (ledger.unavailable ? new Map<string, Outcome>() : new Map(past.items.map((i) => [i.value.govHash, outcomeOf(i.value, reads, source.coreNetwork, cover, known)]))),
    [ledger.unavailable, past.items, reads, source.coreNetwork, cover, known],
  );
  const per = perPayment(params);

  return (
    <>
      {(past.items.length > 0 || searching) && (
        <div className="list-tools" role="search" aria-label="Past proposals">
          <SearchField label="Search past proposals" placeholder="Search by name, URL or address" value={query.q} onChange={(q, replace) => setQuery({ q }, { replace })} />
          <div className="past-phone-sort">
            <SortSelect
              value={`${query.sort}:${query.dir}` as const}
              options={PHONE_SORTS}
              onChange={(v) => {
                const [sort, dir] = v.split(':') as [PastSort, Dir];
                setQuery({ sort, dir });
              }}
            />
          </div>
          {searching && !past.loading && !past.error && <ResultCount shown={rows.length} total={showFailed ? past.items.length : past.items.length - failedAll} what="past proposals" onClear={rows.length ? clear : undefined} />}
        </div>
      )}
      {past.error && (
        <p className="error" role="alert">
          Past proposals could not be loaded right now ({past.error}).{' '}
          <button type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={past.retry} data-testid="past-retry">
            Try again
          </button>
        </p>
      )}
      {!past.error && past.talliesRead === 'failed' && (
        <p className="error" role="alert">
          Their votes could not be loaded right now.{' '}
          <button type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={past.retryTallies} data-testid="past-retry">
            Try again
          </button>
        </p>
      )}
      {!past.loading && !past.error && past.items.length === 0 && (
        <p className="empty dh-empty">
          No past proposals published yet. Proposals move here once their last payment date has passed. <Link to="/" className="dh-link">See the active ones</Link>
        </p>
      )}
      {rows.length > 0 && (
        <table className="past dh-table dh-table--cards">
          <thead>
            <tr>
              {header('name', 'Proposal')}
              {header('ended', 'Ended')}
              {header('amount', 'Requested', 'r')}
              <th scope="col">Outcome</th>
              <th scope="col" className="r">
                Received
              </th>
              {header('yes', 'Net yes', 'r')}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, count).map(({ item: it, check }) => {
              const p = it.value;
              const t = past.tallies.get(p.govHash);
              const reason = isFailed(check) ? check.reason : null;
              const o = outcomes.get(p.govHash) ?? null;
              const reading = readingFor(p);
              return (
                <tr key={p.govHash} className={reason ? 'row-invalid' : undefined} data-check={check.status} data-testid="past-row">
                  <td role="rowheader" data-label="Proposal" className="dh-rc-title">
                    <ProposalLabel p={p} to={proposalHref(p, names)} owner={!reason} />
                    {reason && <FailedNote reason={reason} />}
                  </td>
                  <td data-label="Ended">
                    {formatDate(p.endEpoch)}
                  </td>
                  <td className="r" data-label="Requested ">
                    {formatDash(p.paymentAmount)} <span className="muted small">{per}</span>
                  </td>
                  <td data-label="Outcome" className="dh-rc-end" data-testid="past-outcome">
                    <OutcomeCell o={o} reading={reading} />
                  </td>
                  <td className={`r${o && o.paid && !reading ? '' : ' past-none'}`} data-label="Received">
                    {reading || !o ? '…' : o.paid ? `${o.partial ? 'at least ' : ''}${formatDash(Number(o.total))}` : '—'}
                  </td>
                  <td className="r" data-label="Net yes">
                    {t ? (
                      formatSigned(absoluteYes(t.value))
                    ) : past.talliesRead === 'ok' ? (
                      <span className="muted nowrap" title="No vote tally was published on Platform for this proposal: it ended before the governance data service was recording votes">
                        not recorded
                      </span>
                    ) : past.talliesRead === 'failed' ? (
                      <span className="muted nowrap" title="The tallies couldn't be read just now">
                        not read
                      </span>
                    ) : (
                      <span className="muted" aria-label="Reading the tally">
                        …
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div ref={sentinel} className="sentinel" aria-hidden="true" />
      {searching && !past.loading && !past.error && past.items.length > 0 && rows.length === 0 && <NoMatches query={query.q} onClear={clear} />}
      {past.loading && <p className="muted small center" role="status">Loading…</p>}
      {!past.loading && !past.error && rows.length > 0 && !searching && (
        <p className="muted small center">
          {past.capped
            ? `These are the newest ${formatInt(parts.shown.length)} past proposals Governance has on record: it reads at most ${formatInt(PAST_PAGES)} pages of them, so older ones aren't listed here.`
            : `That's all ${formatInt(parts.shown.length)} past proposals Governance has on record.`}{' '}
          Outcomes come from the superblocks on the Payments view.
        </p>
      )}
      {!past.loading && parts.failed.length > 0 && <FailedProposalsToggle count={parts.failed.length} shown={showFailed} onToggle={() => setShowFailed((v) => !v)} />}
    </>
  );
}
