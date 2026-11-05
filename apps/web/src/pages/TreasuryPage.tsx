// /treasury: what the Dash treasury funds, readable in half a minute. This cycle's budget, what is asked of it and what has the
// votes; what it pays for, grouped by where each proposal stands and ordered by size (proposals carry no category, so none is
// guessed); the next payout; and how it compares with the superblocks before it, read from the chain. Every figure says what it
// rests on, and no total is shown while its parts are still being read.
import { superblockPaymentsLimit } from '@govhub/verify';
import { useMemo, type ReactNode } from 'react';
import { useRouteTitle } from '../app/title.ts';
import { useApp } from '../app/context.tsx';
import type { Cycle, Proposal } from '../data/types.ts';
import { dashUnit, formatDash, formatDashAmount, formatDate, formatInt } from '../lib/format.ts';
import { superblockCadence, votingDeadlineTime } from '../lib/governance.ts';
import { ledgerEntry, ledgerSummary, type LedgerEntry } from '../lib/ledger.ts';
import { ownerPageOf, useOwnerPages, type OwnerPage } from '../lib/ownerPages.ts';
import { share, treasuryView, type GroupId, type TreasuryGroup } from '../lib/treasury.ts';
import { countNames, proposalHref, type Row } from '../lib/view.ts';
import { Link } from '../ui/Link.tsx';
import { purposeOf } from '../ui/OwnerPage.tsx';
import { ChainProof, ProofTag, ReportedProof } from '../ui/ProofTag.tsx';
import { ProposalTabs } from '../ui/ProposalTabs.tsx';
import { readableName, Slug } from '../ui/Slug.tsx';
import { UsdValue } from '../ui/UsdValue.tsx';
import { useLedger, LEDGER_STEP } from '../ui/useLedger.ts';

const DashValue = ({ duffs }: { duffs: number | bigint }) => (
  <>
    {formatDashAmount(Number(duffs))} <small>{dashUnit()}</small>
  </>
);

const GROUP: Record<GroupId, { title: string; desc: string }> = {
  funded: { title: 'In the next budget', desc: 'Enough votes, and room in the budget: these are paid at the next payout if the votes hold.' },
  over: { title: 'Passing, but over the budget', desc: 'Enough votes, but the budget runs out before them: proposals are paid best-supported first.' },
  short: { title: 'Short of votes', desc: 'Not paid unless more masternodes vote yes before voting closes.' },
  later: { title: 'Starting at a later payout', desc: 'Not up for this payout: their first payment is a later superblock.' },
};

export function TreasuryPage() {
  useRouteTitle('/treasury');
  const { gov, source, params, activeRows } = useApp();
  const cycle = gov.cycle.data?.value ?? null;
  const network = source.coreNetwork;
  const view = useMemo(() => treasuryView(activeRows.shown.map((r) => r.item)), [activeRows.shown]);
  const names = useMemo(() => countNames([...activeRows.shown, ...activeRows.lameDucks].map((r) => r.item.p.value)), [activeRows]);
  const cadence = superblockCadence(params);
  const lede = `The Dash treasury pays the proposals masternodes vote for, ${cadence}, in a superblock. Here is what this one can pay, what it pays for, and how that compares with the ones before.`;

  if (source.notice) return null;
  return (
    <section className="list-section treasury" aria-labelledby="treasury-title" data-testid="treasury">
      <div className="list-head">
        <ProposalTabs />
      </div>
      <header className="dh-page-header">
        <h1 className="dh-page-header__title" id="treasury-title">
          What the treasury funds
        </h1>
        <p className="dh-page-header__lede">{lede}</p>
      </header>
      {!cycle ? (
        gov.cycle.loading ? (
          <p className="muted" aria-busy="true">
            <span className="spinner" aria-hidden="true" /> Reading this cycle’s budget…
          </p>
        ) : (
          <p className="notice-box dh-notice dh-notice--warn small">The budget cycle couldn’t be read{gov.cycle.error ? `: ${gov.cycle.error}` : ''}.</p>
        )
      ) : (
        <>
          <CycleStats cycle={cycle} requested={view.requested} passing={view.passing} funded={view.groups.funded} counting={gov.talliesLoading || gov.active.loading} />
          <PaysFor view={view} counting={gov.talliesLoading || gov.active.loading} budget={cycle.budget} names={names} />
        </>
      )}
      <Compared allocated={cycle?.allocated ?? null} network={network} />
    </section>
  );
}

function CycleStats({ cycle, requested, passing, funded, counting }: { cycle: Cycle; requested: number; passing: number; funded: TreasuryGroup; counting: boolean }) {
  const { source, params } = useApp();
  const now = source.now();
  // the most this superblock can pay is a consensus rule of its height: computed here, and checked against the bridge's figure
  const limit = useMemo(() => {
    try {
      return Number(superblockPaymentsLimit(cycle.superblockHeight, source.coreNetwork));
    } catch {
      return null;
    }
  }, [cycle.superblockHeight, source.coreNetwork]);
  const deadline = votingDeadlineTime(cycle, params);
  const hold = (v: ReactNode) => (counting ? <span className="muted">counting…</span> : v);
  return (
    <div className="dh-stats tr-stats" data-testid="treasury-stats">
      <div className="dh-stat dh-stat--key">
        <span className="dh-stat__label">This payout can pay</span>
        <span className="dh-stat__value" data-testid="tr-budget">
          <DashValue duffs={cycle.budget} />
        </span>
        <span className="dh-stat__note">
          <UsdValue duffs={cycle.budget} what="About" />{' '}
          {limit === cycle.budget ? (
            <ProofTag state="reported" title={`The most superblock ${formatInt(cycle.superblockHeight)} can pay, by Dash's consensus rules: worked out in this browser from its height`}>
              Consensus limit
            </ProofTag>
          ) : (
            <ReportedProof what={limit === null ? 'Bridge’s figure' : `Bridge’s figure; consensus says ${formatDash(limit)}`} />
          )}
        </span>
      </div>
      <div className="dh-stat">
        <span className="dh-stat__label">Asked for</span>
        <span className="dh-stat__value" data-testid="tr-requested">{hold(<DashValue duffs={requested} />)}</span>
        <span className="dh-stat__note">
          {counting ? 'by the proposals due at this payout' : `${share(requested, cycle.budget)} of what it can pay, by the proposals due at this payout`}{' '}
          <ProofTag state="reported" title="The proposals Governance lists, read from Platform; each one's fields match the hash the network votes on">
            Platform records
          </ProofTag>
        </span>
      </div>
      <div className="dh-stat">
        <span className="dh-stat__label">Has the votes</span>
        <span className="dh-stat__value" data-testid="tr-passing">{hold(<DashValue duffs={passing} />)}</span>
        <span className="dh-stat__note">
          {counting ? 'asked by proposals with enough yes votes' : `asked by proposals with enough yes votes; ${formatDash(funded.sum)} of it fits the budget`} <ReportedProof what="Bridge’s tally" />
        </span>
      </div>
      <div className="dh-stat">
        <span className="dh-stat__label">Next payout</span>
        <span className="dh-stat__value" data-testid="tr-next">{formatDate(cycle.estTime)}</span>
        <span className="dh-stat__note">
          superblock {formatInt(cycle.superblockHeight)}, an estimate from block times; {deadline > now ? `votes count until ${formatDate(deadline)}` : 'voting for it has closed'}
        </span>
      </div>
    </div>
  );
}

function PaysFor({ view, counting, budget, names }: { view: ReturnType<typeof treasuryView>; counting: boolean; budget: number; names: ReadonlyMap<string, number> }) {
  const pages = useOwnerPages();
  const { checks } = useApp();
  return (
    <section className="dh-section tr-pays" aria-labelledby="tr-pays-title">
      <div className="dh-section__head">
        <h2 className="dh-section__title" id="tr-pays-title">
          What it pays for
        </h2>
        <p className="dh-section__desc">
          Grouped by where each proposal stands, largest first; proposals carry no category on the network, so none is guessed here. Titles and summaries in quotes
          are the owners’ own words from their pages: nobody has checked them. Standings are the bridge’s tally <ReportedProof what="Bridge’s tally" />; each proposal’s page recounts its own.
        </p>
      </div>
      {counting ? (
        <p className="muted" aria-busy="true" data-testid="tr-counting">
          <span className="spinner" aria-hidden="true" /> Counting the votes, to group the proposals…
        </p>
      ) : (
        <>
          <BudgetBar funded={view.groups.funded} over={view.groups.over} budget={budget} />
          {(['funded', 'over', 'short', 'later'] as const).map((id) =>
            view.groups[id].rows.length ? <Group key={id} group={view.groups[id]} budget={budget} pages={pages} names={names} failed={(p) => checks.state(p).status === 'failed'} /> : null,
          )}
        </>
      )}
    </section>
  );
}

/** The budget as one bar: each proposal in it, largest first, then what is left; what passes but doesn't fit is said in words. */
function BudgetBar({ funded, over, budget }: { funded: TreasuryGroup; over: TreasuryGroup; budget: number }) {
  const left = Math.max(0, budget - funded.sum);
  return (
    <figure className="tr-budget" aria-labelledby="tr-budget-cap">
      <div className="tr-budget-bar" aria-hidden="true">
        {funded.rows.map((r) => (
          <span key={r.p.value.govHash} className="tr-seg" style={{ flexGrow: r.p.value.paymentAmount }} title={`${r.p.value.name}: ${formatDash(r.p.value.paymentAmount)}`} />
        ))}
        <span className="tr-seg-free" style={{ flexGrow: left }} />
      </div>
      <figcaption id="tr-budget-cap" className="small">
        <span className="tr-key tr-key-seg" aria-hidden="true" /> {formatInt(funded.rows.length)} proposal{funded.rows.length === 1 ? '' : 's'} in the next budget,{' '}
        <b>{formatDash(funded.sum)}</b> ({share(funded.sum, budget)}) · <span className="tr-key tr-key-free" aria-hidden="true" /> {formatDash(left)} left
        {over.rows.length > 0 && <> · {formatInt(over.rows.length)} more pass but don’t fit ({formatDash(over.sum)})</>}
        {funded.rows[0] && funded.rows.length > 1 && (
          <>
            . The largest is {share(funded.rows[0].p.value.paymentAmount, funded.sum)} of what goes out.
          </>
        )}
      </figcaption>
    </figure>
  );
}

function Group({ group, budget, pages, names, failed }: { group: TreasuryGroup; budget: number; pages: ReadonlyMap<string, OwnerPage>; names: ReadonlyMap<string, number>; failed(p: Proposal): boolean }) {
  const g = GROUP[group.id];
  const body = (
    <table className="dh-table dh-table--cards tr-table">
      <caption className="visually-hidden">{g.title}</caption>
      <thead>
        <tr>
          <th scope="col">Proposal</th>
          <th scope="col" className="r">
            Asks
          </th>
          <th scope="col">Of what this payout can pay</th>
          <th scope="col">Standing</th>
        </tr>
      </thead>
      <tbody>
        {group.rows.map((r) => (
          <TreasuryRow key={r.p.value.govHash} r={r} budget={budget} page={r.content.ok && !failed(r.p.value) ? ownerPageOf(pages, r.p.value) : null} href={proposalHref(r.p.value, names)} />
        ))}
      </tbody>
    </table>
  );
  const head = (
    <>
      <span className="tr-group-title">{g.title}</span>{' '}
      <span className="tr-group-sum small">
        {formatInt(group.rows.length)} proposal{group.rows.length === 1 ? '' : 's'} · {formatDash(group.sum)}
        {group.id !== 'later' && ` · ${share(group.sum, budget)} of the budget`}
      </span>
    </>
  );
  // the ones being paid are the story; the rest are a tap away
  return group.id === 'funded' ? (
    <section className="tr-group" aria-labelledby={`tr-${group.id}`} data-testid={`tr-group-${group.id}`}>
      <h3 id={`tr-${group.id}`} className="tr-group-head">
        {head}
      </h3>
      <p className="small muted tr-group-desc">{g.desc}</p>
      {body}
    </section>
  ) : (
    <details className="tr-group dh-panel dh-panel--flush" data-testid={`tr-group-${group.id}`}>
      <summary className="tr-group-head">
        <span className="sb-chevron" aria-hidden="true" />
        {head}
      </summary>
      <p className="small muted tr-group-desc">{g.desc}</p>
      {body}
    </details>
  );
}

function standing(r: Row): { text: string; tone: 'pass' | 'warn' | 'fail' | '' } {
  if (!r.tally) return { text: 'No votes yet', tone: '' };
  if (!r.state) return { text: 'Waiting for the budget cycle', tone: '' };
  return r.state.passing ? { text: `Passing by ${formatInt(r.state.margin)}`, tone: r.state.light === 'warn' ? 'warn' : 'pass' } : { text: `Needs ${formatInt(r.state.needed)} more`, tone: r.state.light };
}

function TreasuryRow({ r, budget, page, href }: { r: Row; budget: number; page: OwnerPage | null; href: string }) {
  const p = r.p.value;
  const purpose = page ? purposeOf(page) : null;
  const st = standing(r);
  const pct = budget > 0 ? Math.min(100, (p.paymentAmount / budget) * 100) : 0;
  return (
    <tr data-testid="tr-row">
      <td role="rowheader" data-label="Proposal" className="dh-rc-title tr-name">
        <Link to={href}>{page?.title ? <bdi>“{page.title}”</bdi> : readableName(p.name)}</Link>
        <span className="tr-slug small">
          <Slug name={p.name} />
          {page && <span className="muted"> · owner’s page on {page.host}</span>}
        </span>
        {purpose && (
          <span className="tr-purpose small" title={purpose}>
            <bdi>{purpose}</bdi>
          </span>
        )}
      </td>
      <td data-label="Asks" className="r num tr-ask">
        {formatDash(p.paymentAmount)}
      </td>
      <td data-label="Of this payout" className="tr-share">
        <span className="tr-share-bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
        <span className="small">{share(p.paymentAmount, budget)}</span>
      </td>
      <td data-label="Standing" className="dh-rc-end">
        <span className={`outcome${st.tone ? ` outcome-${st.tone}` : ''}`}>
          <span className="dot" aria-hidden="true" />
          {st.text}
        </span>
      </td>
    </tr>
  );
}

// ---- compared with the superblocks before ---------------------------------------------------------------------------------------

const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
const yearFmt = new Intl.DateTimeFormat('en-GB', { year: '2-digit', timeZone: 'UTC' });
const hourFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });

function Compared({ allocated, network }: { allocated: number | null; network: 'mainnet' | 'testnet' }) {
  const ledger = useLedger();
  const entries = useMemo(
    () => (ledger.slots ?? []).map((s) => ({ state: s.state, entry: s.state === 'read' ? ledgerEntry(s.read, [], network) : null })),
    [ledger.slots, network],
  );
  const sum = ledgerSummary(entries);
  const span = network === 'testnet' ? `the last ${LEDGER_STEP.testnet} superblocks (a day; Testnet pays hourly)` : `the last ${LEDGER_STEP.mainnet} superblocks (a year)`;
  return (
    <section className="dh-section dh-section--rule tr-compare" aria-labelledby="tr-compare-title" data-testid="tr-compare">
      <div className="dh-section__head">
        <h2 className="dh-section__title" id="tr-compare-title">
          Compared with {span}
        </h2>
        <p className="dh-section__desc">
          What each superblock actually paid, read from the chain in this browser. <Link to="/past">Every payment, superblock by superblock →</Link>
        </p>
      </div>
      {ledger.unavailable ? (
        <p className="notice-box dh-notice dh-notice--info small">{ledger.unavailable}</p>
      ) : !ledger.slots ? (
        <p className="muted small">
          <span className="spinner" aria-hidden="true" /> Finding the last superblock…
        </p>
      ) : sum.kind === 'reading' ? (
        <div role="status" data-testid="tr-compare-progress">
          <p className="small">
            <span className="spinner" aria-hidden="true" /> Reading superblocks from the chain: <b>{formatInt(sum.settled)}</b> of {formatInt(sum.of)} so far. The comparison
            appears once all are in.
          </p>
          <progress className="ledger-progress" max={sum.of} value={sum.settled} aria-label="Superblocks read" />
        </div>
      ) : !sum.counted ? (
        <p className="notice-box dh-notice dh-notice--warn small">No superblock could be read just now. <button type="button" className="linkish dh-btn dh-btn--link" onClick={ledger.retry}>Try again</button></p>
      ) : (
        <PaidChart entries={entries.flatMap((e) => (e.entry ? [e.entry] : []))} sum={sum} allocated={allocated} network={network} onRetry={ledger.retry} over={network === 'testnet' ? `the last ${LEDGER_STEP.testnet} superblocks` : `the last ${LEDGER_STEP.mainnet} superblocks`} />
      )}
    </section>
  );
}

function PaidChart({ entries, sum, allocated, network, onRetry, over }: { entries: LedgerEntry[]; sum: Extract<ReturnType<typeof ledgerSummary>, { kind: 'done' }>; allocated: number | null; network: 'mainnet' | 'testnet'; onRetry(): void; over: string }) {
  const avg = Number(sum.paid) / sum.counted;
  const cols = [...entries].reverse(); // oldest first, left to right
  const top = Math.max(...cols.map((e) => Number(e.limit)), allocated ?? 0, 1);
  // Testnet's hourly superblocks are labelled every fourth hour; a month's label adds its year at the start and in January
  const label = (t: number, i: number): ReactNode => {
    const at = t * 1000;
    if (network === 'testnet') return i % 4 === 0 ? hourFmt.format(at) : null;
    const month = monthFmt.format(at);
    return (
      <>
        {month}
        {(i === 0 || month === 'Jan') && <span className="tr-yr"> ’{yearFmt.format(at)}</span>}
      </>
    );
  };
  const usedAvg = cols.reduce((a, e) => a + (e.total !== null && e.limit > 0n ? Number(e.total) / Number(e.limit) : 0), 0) / Math.max(1, cols.filter((e) => e.total !== null).length);
  const left = [sum.failed ? `${formatInt(sum.failed)} couldn’t be read` : '', sum.unknown ? `${formatInt(sum.unknown)} with a total that isn’t known` : ''].filter(Boolean).join(' and ');
  const diff = allocated !== null && avg > 0 ? (allocated - avg) / avg : null;
  return (
    <>
      <p className="tr-compare-line" data-testid="tr-compare-line">
        {left ? `In the ${formatInt(sum.counted)} of ${formatInt(sum.of)} superblocks read` : `Over ${over}`}, the treasury paid <b>{formatDash(Math.round(avg))}</b> on
        average, {Math.round(usedAvg * 100)}% of what each could pay.{' '}
        {diff !== null && (
          <>
            This payout’s budget so far, <b>{formatDash(allocated!)}</b>, is{' '}
            {Math.abs(diff) < 0.05 ? 'about the same' : `${Math.round(Math.abs(diff) * 100)}% ${diff < 0 ? 'less' : 'more'}`}
            {Math.abs(diff) < 0.05 ? '.' : ' than that.'}
          </>
        )}{' '}
        <ChainProof weak={sum.weak} /> {allocated !== null && <ReportedProof what="Next payout: bridge’s figure" />}
        {left && (
          <>
            {' '}
            <span className="small">
              {left}, so {sum.failed + sum.unknown === 1 ? 'it is' : 'they are'} left out.{' '}
              {sum.failed > 0 && (
                <button type="button" className="linkish dh-btn dh-btn--link" onClick={onRetry}>
                  Read again
                </button>
              )}
            </span>
          </>
        )}
      </p>
      <figure className="tr-chart" aria-labelledby="tr-chart-cap" data-testid="tr-chart">
        <div className="tr-legend small" aria-hidden="true">
          <span>
            <span className="tr-key tr-key-paid" /> Paid, read from the chain
          </span>
          <span>
            <span className="tr-key tr-key-cap" /> The most it could pay
          </span>
          {allocated !== null && (
            <span>
              <span className="tr-key tr-key-next" /> This payout, allocated (not paid yet)
            </span>
          )}
        </div>
        <div className="tr-cols" aria-hidden="true">
          {cols.map((e, i) => {
            const paid = e.total !== null ? Number(e.total) : null;
            const tip = `${formatDate(e.read.time)}: ${paid !== null ? `${formatDash(paid)} paid, ${share(paid, Number(e.limit))} of the ${formatDash(Number(e.limit))} it could pay` : 'total not known'}`;
            return (
              <div key={e.read.height} className="tr-col" title={tip}>
                <span className="tr-track" style={{ height: `${(Number(e.limit) / top) * 100}%` }}>
                  {i === cols.length - 1 && paid !== null && <span className="tr-val">{formatDashAmount(paid)}</span>}
                  {paid !== null && <span className="tr-bar" style={{ height: `${Number(e.limit) > 0 ? Math.min(100, (paid / Number(e.limit)) * 100) : 0}%` }} />}
                </span>
                <span className="tr-x">{label(e.read.time, i)}</span>
              </div>
            );
          })}
          {allocated !== null && (
            <div className="tr-col tr-col-next" title={`This payout: ${formatDash(allocated)} allocated so far, as the bridge reports it; not paid yet`}>
              <span className="tr-val">{formatDashAmount(allocated)}</span>
              <span className="tr-next" style={{ height: `${(allocated / top) * 100}%` }} />
              <span className="tr-x">Next</span>
            </div>
          )}
        </div>
        <figcaption id="tr-chart-cap" className="visually-hidden">
          What each superblock paid, oldest first{allocated !== null ? ', then what this payout has allocated so far' : ''}. The same figures are in the table below.
        </figcaption>
        <details className="tr-table-view small">
          <summary>As a table</summary>
          <table className="dh-table dh-table--compact">
            <thead>
              <tr>
                <th scope="col">Superblock</th>
                <th scope="col" className="r">
                  Paid
                </th>
                <th scope="col" className="r">
                  Could pay
                </th>
              </tr>
            </thead>
            <tbody>
              {[...cols].reverse().map((e) => (
                <tr key={e.read.height}>
                  <td data-label="Superblock">
                    {formatDate(e.read.time)} <span className="muted">({formatInt(e.read.height)})</span>
                  </td>
                  <td data-label="Paid" className="r num">
                    {e.total !== null ? formatDash(Number(e.total)) : 'not known'}
                  </td>
                  <td data-label="Could pay" className="r num">
                    {formatDash(Number(e.limit))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </figure>
    </>
  );
}
