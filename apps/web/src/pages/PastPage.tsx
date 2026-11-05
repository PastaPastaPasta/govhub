// Past: what the treasury paid and how each ended proposal turned out.
//
// "Payments" (default) is the ledger: superblock by superblock, newest first, the treasury payments read from each superblock's
// coinbase in the verified chain (lib/ledger.ts), named when Governance has the proposal on record. "Proposals" lists the ended
// proposals Platform holds (newest end first, keyset-paged on endEpoch: repo.ts pastPage) with their outcome from those superblocks.
import { Slug } from '../ui/Slug.tsx';
import { OwnerTitle } from '../ui/OwnerPage.tsx';
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRouteTitle } from '../app/title.ts';
import { Link } from '../ui/Link.tsx';
import { useApp } from '../app/context.tsx';
import type { Proposal, Sourced, Tally } from '../data/types.ts';
import { dashUnit, errText, formatDash, formatDashAmount, formatDate, formatInt, formatSigned } from '../lib/format.ts';
import { absoluteYes, perPayment } from '../lib/governance.ts';
import { ledgerEntry, ledgerSummary, outcomeOf, type LedgerEntry, type LedgerLine, type LedgerSummary, type Outcome, type SuperblockRead } from '../lib/ledger.ts';
import { countNames, partitionByCheck, proposalHref } from '../lib/view.ts';
import { contentFailure, isFailed } from '../verify/checks.ts';
import { FailedNote, FailedProposalsToggle } from '../ui/HiddenToggle.tsx';
import { useReveal } from '../ui/hooks.ts';
import { ProposalTabs } from '../ui/ProposalTabs.tsx';
import { useLedger, type Ledger, type SuperblockSlot } from '../ui/useLedger.ts';
import { ChainProof } from '../ui/ProofTag.tsx';

/** Ended proposals on Platform, every page (there are tens, not thousands), with their published tallies. */
function usePastProposals() {
  const { source } = useApp();
  const [items, setItems] = useState<Sourced<Proposal>[]>([]);
  const [tallies, setTallies] = useState(new Map<string, Sourced<Tally>>());
  const [state, setState] = useState<{ loading: boolean; error?: string }>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let on = true;
    setItems([]);
    setTallies(new Map());
    setState({ loading: true });
    (async () => {
      let cursor: string | undefined;
      const all: Sourced<Proposal>[] = [];
      for (let page = 0; page < 20; page++) {
        const r = await source.pastPage(cursor);
        all.push(...r.items);
        if (on) setItems([...all]);
        if (!r.next) break;
        cursor = r.next;
      }
      if (on) setState({ loading: false });
      if (all.length) {
        const t = await source.tallies(all.map((i) => i.value.govHash));
        if (on) setTallies(t);
      }
    })().catch((e) => on && setState({ loading: false, error: errText(e) }));
    return () => {
      on = false;
    };
  }, [source, attempt]);
  return { items, tallies, ...state, retry: () => setAttempt((n) => n + 1) };
}

type View = 'payments' | 'proposals';

export function PastPage() {
  useRouteTitle('/past');
  const { gov, checks } = useApp();
  const [search, setSearch] = useSearchParams();
  const view: View = search.get('view') === 'proposals' ? 'proposals' : 'payments';
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
    if (v === 'payments') sp.delete('view');
    else sp.set('view', v);
    setSearch(sp, { replace: true });
  };

  return (
    <section aria-labelledby="past-title" className="list-section past-page">
      <div className="list-head">
        <ProposalTabs />
      </div>
      <header className="past-head dh-page-header">
        <h1 className="dh-page-header__title" id="past-title">Past proposals</h1>
        <p className="dh-page-header__lede">What the Dash treasury paid, superblock by superblock, read from the chain in this browser, and how each ended proposal turned out.</p>
        <div className="dh-seg" role="group" aria-label="Show">
          <button className="dh-btn" type="button" aria-pressed={view === 'payments'} onClick={() => setView('payments')} data-testid="view-payments">
            Payments by superblock
          </button>
          <button className="dh-btn" type="button" aria-pressed={view === 'proposals'} onClick={() => setView('proposals')} data-testid="view-proposals">
            Proposals<span className="dh-count">{!past.loading && past.items.length ? formatInt(past.items.length) : ''}</span>
          </button>
        </div>
      </header>
      {view === 'payments' ? <LedgerView ledger={ledger} known={known} past={past.items} /> : <ProposalsView past={past} ledger={ledger} known={known} />}
    </section>
  );
}

// ---- payments ---------------------------------------------------------------------------------------------------------------

/** A stat value with its unit set smaller (DESIGN.md §6, stats). */
const DashValue = ({ duffs }: { duffs: bigint }) => (
  <>
    {formatDashAmount(Number(duffs))} <small>{dashUnit()}</small>
  </>
);

function LedgerView({ ledger, known, past }: { ledger: Ledger; known: Proposal[]; past: Sourced<Proposal>[] }) {
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
  const reading = sum.kind === 'reading' ? sum.of - sum.settled : 0;
  const failed = sum.kind === 'done' ? sum.failed : 0;
  // Governance's records hold the proposals that ended since its bridge began archiving, and the active ones: others show their payee
  const recordsFrom = past.length ? Math.min(...past.map((p) => p.value.endEpoch)) : null;
  const perSb = network === 'testnet' ? 'superblock (hourly on Testnet)' : 'superblock (about monthly)';
  return (
    <div className="ledger" data-testid="ledger">
      <LedgerStats sum={sum} perSb={perSb} />
      <p className="small muted ledger-note" data-testid="ledger-status">
        Each payment is read from its superblock in the chain this browser verified; the first visit downloads and checks each block, later visits
        reuse them. Names come from the proposals Governance has on record: the active ones{recordsFrom ? <> and those that ended since {formatDate(recordsFrom)}</> : null}.
        A payment to any other proposal shows the address it went to.
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
          <button type="button" className="btn dh-btn" onClick={ledger.loadMore} disabled={reading > 0} data-testid="ledger-more">
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
      <div className="ledger-stats ledger-stats-reading" role="status" data-testid="ledger-progress">
        <p className="ledger-progress-line">
          <span className="spinner" aria-hidden="true" /> Reading superblocks from the chain: <b>{formatInt(sum.settled)}</b> of {formatInt(sum.of)} so far.
        </p>
        <p className="small muted">The totals appear once all {formatInt(sum.of)} are in, so no figure here is a partial one.</p>
        <progress className="ledger-progress" max={sum.of} value={sum.settled} aria-label="Superblocks read" />
      </div>
    );
  }
  const left = [sum.failed ? `${formatInt(sum.failed)} couldn't be read` : '', sum.unknown ? `${formatInt(sum.unknown)} with a total that isn't known` : ''].filter(Boolean).join(' and ');
  const range = sum.oldest && sum.newest ? `, ${formatDate(sum.oldest)} to ${formatDate(sum.newest)}` : '';
  const scope = left ? `in ${formatInt(sum.counted)} of the ${formatInt(sum.of)} superblocks${range}; ${left}, so ${sum.failed + sum.unknown === 1 ? 'it is' : 'they are'} left out` : `in ${formatInt(sum.counted)} superblock${sum.counted === 1 ? '' : 's'}${range}`;
  if (!sum.counted) {
    return (
      <p className="notice-box dh-notice dh-notice--warn small" data-testid="ledger-total">
        No superblock total could be read just now ({left}).
      </p>
    );
  }
  return (
    <div className="dh-stats ledger-stats" aria-live="polite">
      <div className="dh-stat dh-stat--key">
        <span className="dh-stat__label">Paid by the treasury{left ? ' (partial)' : ''}</span>
        <span className="dh-stat__value" data-testid="ledger-total">
          {left ? <small>at least </small> : null}
          <DashValue duffs={sum.paid} />
        </span>
        <span className="dh-stat__note" data-testid="ledger-scope">
          {scope}. <ChainProof weak={sum.weak} />
        </span>
      </div>
      <div className="dh-stat">
        <span className="dh-stat__label">On average</span>
        <span className="dh-stat__value">
          <DashValue duffs={sum.paid / BigInt(sum.counted)} />
        </span>
        <span className="dh-stat__note">per {perSb}{left ? ', of those read' : ''}</span>
      </div>
      <div className="dh-stat">
        <span className="dh-stat__label">Payments</span>
        <span className="dh-stat__value">{formatInt(sum.payments)}</span>
        <span className="dh-stat__note">to proposals' payees</span>
      </div>
    </div>
  );
}

/** One superblock: its date and total always in view; the payments open for the newest, a click away for the rest. */
function SuperblockPanel({ slot, entry, names, open }: { slot: SuperblockSlot; entry: LedgerEntry | null; names: ReadonlyMap<string, number>; open: boolean }) {
  const headId = `sb-${slot.height}`;
  return (
    <details className="dh-panel dh-panel--flush sb" aria-labelledby={headId} data-testid="superblock" data-height={slot.height} open={open}>
      <summary className="sb-head">
        <h2 id={headId} className="sb-date">
          <span className="sb-chevron" aria-hidden="true" />
          {entry ? (
            formatDate(entry.read.time)
          ) : slot.state === 'error' ? (
            'Not read'
          ) : (
            <span className="sb-reading small muted">
              <span className="spinner" aria-hidden="true" /> Reading this superblock from the chain…
            </span>
          )}
        </h2>
        <span className="sb-height small muted">superblock {formatInt(slot.height)}</span>
        {entry && <SbTotal entry={entry} />}
      </summary>
      {slot.state === 'error' && <p className="sb-error small">Couldn't read this superblock: {slot.error}.</p>}
      {entry && <SbLines entry={entry} names={names} />}
    </details>
  );
}

function SbTotal({ entry }: { entry: LedgerEntry }) {
  const share = entry.total !== null && entry.limit > 0n ? Number((entry.total * 1000n) / entry.limit) / 10 : null;
  return (
    <p className="sb-total">
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
    </p>
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
                  <Link to={proposalHref(l.proposal as Proposal, names)}><Slug name={l.proposal.name} /></Link>
                  <OwnerTitle p={l.proposal} />
                </>
              ) : l.candidates.length ? (
                <span>
                  One of{' '}
                  {l.candidates.map((c, i) => (
                    <span key={c.govHash}>
                      {i > 0 && ' or '}
                      <Link to={proposalHref(c as Proposal, names)}><Slug name={c.name} /></Link>
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
                        not on record; same payee as <Link to={proposalHref(l.samePayee as Proposal, names)}><Slug name={l.samePayee.name} /></Link>
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

function OutcomeCell({ o, reading }: { o: Outcome | null; reading: boolean }) {
  if (!o || (o.kind === 'unknown' && reading)) return <span className="muted">{reading ? 'reading…' : '—'}</span>;
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
      <span className="small muted"> · {detail}</span>
    </span>
  );
}

function ProposalsView({ past, ledger, known }: { past: ReturnType<typeof usePastProposals>; ledger: Ledger; known: Proposal[] }) {
  const { checks, params, source } = useApp();
  const [showFailed, setShowFailed] = useState(false);
  const checksVersion = useSyncExternalStore(checks.subscribe, checks.getVersion);
  const parts = useMemo(
    () => partitionByCheck(past.items, (i) => checks.state(i.value)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [past.items, checks, checksVersion],
  );
  const rows = showFailed ? [...parts.shown, ...parts.failed] : parts.shown;
  const { count, sentinel } = useReveal(rows.length, 20, () => {});
  const names = useMemo(() => countNames(past.items.map((i) => i.value)), [past.items]);
  useEffect(() => checks.ensure(past.items.slice(0, count + 12).map((i) => i.value)), [checks, past.items, count]);
  const reads = useMemo(() => (ledger.slots ?? []).flatMap((s): SuperblockRead[] => (s.state === 'read' ? [s.read] : [])), [ledger.slots]);
  const reading = !!ledger.slots?.some((s) => s.state === 'reading');
  const cover = useMemo(() => {
    const oldest = reads.length ? Math.min(...reads.map((r) => r.time)) : null;
    // an unread superblock's time, estimated from a read one: enough to know which windows it falls in
    const ref = reads[0];
    const unread = ref ? (ledger.slots ?? []).filter((s) => s.state !== 'read').map((s) => ref.time + (s.height - ref.height) * params.blockSeconds) : [];
    return { oldest, unread };
  }, [reads, ledger.slots, params.blockSeconds]);
  const outcomes = useMemo(
    () => (ledger.unavailable ? new Map<string, Outcome>() : new Map(past.items.map((i) => [i.value.govHash, outcomeOf(i.value, reads, source.coreNetwork, cover, known)]))),
    [ledger.unavailable, past.items, reads, source.coreNetwork, cover, known],
  );
  const per = perPayment(params);

  return (
    <>
      {past.error && (
        <p className="error">
          Platform could not be read: {past.error}{' '}
          <button type="button" className="linkish dh-btn dh-btn--link" onClick={past.retry}>
            Try again
          </button>
        </p>
      )}
      {!past.loading && !past.error && past.items.length === 0 && (
        <p className="empty dh-empty">
          No past proposals published yet. Proposals move here once their last payment date has passed. <Link to="/">See the active ones</Link>
        </p>
      )}
      {rows.length > 0 && (
        <table className="past dh-table dh-table--cards">
          <thead>
            <tr>
              <th scope="col">Proposal</th>
              <th scope="col">Ran</th>
              <th scope="col" className="r">
                Requested
              </th>
              <th scope="col">Outcome</th>
              <th scope="col" className="r">
                Received
              </th>
              <th scope="col" className="r">
                Net yes
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, count).map(({ item: it, check }) => {
              const p = it.value;
              const t = past.tallies.get(p.govHash);
              const reason = isFailed(check) ? check.reason : null;
              const o = outcomes.get(p.govHash) ?? null;
              return (
                <tr key={p.govHash} className={reason ? 'row-invalid' : undefined} data-check={check.status} data-testid="past-row">
                  <td role="rowheader" data-label="Proposal" className="dh-rc-title">
                    <Link to={proposalHref(p, names)}><Slug name={p.name} /></Link>
                    {!reason && <OwnerTitle p={p} />}
                    {reason && <FailedNote reason={reason} />}
                  </td>
                  <td data-label="Ran ">
                    {formatDate(p.startEpoch)} – {formatDate(p.endEpoch)}
                  </td>
                  <td className="r" data-label="Requested ">
                    {formatDash(p.paymentAmount)} <span className="muted small">{per}</span>
                  </td>
                  <td data-label="Outcome" className="dh-rc-end" data-testid="past-outcome">
                    <OutcomeCell o={o} reading={reading} />
                  </td>
                  <td className={`r${o && o.paid ? '' : ' past-none'}`} data-label="Received">
                    {o && o.paid ? `${o.partial ? 'at least ' : ''}${formatDash(Number(o.total))}` : o && !reading ? '—' : '…'}
                  </td>
                  <td className="r" data-label="Net yes">
                    {t ? (
                      formatSigned(absoluteYes(t.value))
                    ) : past.tallies.size || !past.loading ? (
                      <span className="muted nowrap" title="No vote tally was published on Platform for this proposal: it ended before Governance's bridge was recording votes">
                        not recorded
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
      {past.loading && <p className="muted small center">Loading…</p>}
      {!past.loading && rows.length > 0 && (
        <p className="muted small center">
          That's all {formatInt(parts.shown.length)} past proposals Governance has on record. Outcomes come from the superblocks on the Payments view.
        </p>
      )}
      {!past.loading && parts.failed.length > 0 && <FailedProposalsToggle count={parts.failed.length} shown={showFailed} onToggle={() => setShowFailed((v) => !v)} />}
    </>
  );
}
