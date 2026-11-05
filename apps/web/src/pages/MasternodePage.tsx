// /masternodes/<proTxHash>: one masternode's votes on the active proposals, as a work queue. Every active proposal is listed at once
// (from the snapshot the app already holds); this masternode's vote fills into each row as the bridge answers. Each row has the way
// to vote that fits: the keyring's own vote panel when the keyring holds this masternode, offline signing with its voting address
// filled in otherwise. Radar links here (and to /masternodes?proTx=, which redirects here).
import { Slug } from '../ui/Slug.tsx';
import { Fragment, useId, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { useTitle } from '../app/title.ts';
import type { Cycle, Proposal } from '../data/types.ts';
import { formatDash, formatDate, formatDuration, formatInt, shortHash } from '../lib/format.ts';
import { perPayment, votingDeadlineTime, type GovParams } from '../lib/governance.ts';
import { countNames, proposalHref, type Row } from '../lib/view.ts';
import { Link } from '../ui/Link.tsx';
import { openSignIn } from '../ui/SignIn.tsx';
import { OUTCOME_LABEL } from '../ui/vote/common.tsx';
import { useMasternodeVotes, type VoteCell } from '../ui/vote/useMasternodeVotes.ts';
import { OfflineSign, VoteComposer } from '../ui/VotePanel.tsx';
import { useKeyring } from '../voting/KeyringContext.tsx';
import { OwnerTitle } from '../ui/OwnerPage.tsx';
import { NetworkProbeNotice, useOtherNetwork, useProbe } from '../app/otherNetwork.tsx';
import { makeBridge } from '../data/bridgeFactory.ts';
import '../voting/voting.css';

/** "17 Nov" (the year only when it isn't this one) */
function shortDate(s: number): string {
  const full = formatDate(s);
  return new Date(s * 1000).getUTCFullYear() === new Date().getUTCFullYear() ? full.replace(/ \d{4}$/, '') : full;
}

const isProTx = (s: string): boolean => /^[0-9a-f]{64}$/i.test(s);

/**
 * Radar's origin when this page load came from there to this masternode's page: Radar links here with the ProTx, and its referrer
 * policy sends its origin. Read from the page load itself, so moving around in the app later doesn't make it up.
 */
function cameFromRadar(proTx: string): string | null {
  try {
    const radar = window.dashhq?.href('radar', '/');
    if (!radar || !document.referrer) return null;
    const entry = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.name ?? location.href;
    if (new URL(entry).pathname.toLowerCase() !== `/masternodes/${proTx}`) return null;
    return new URL(document.referrer).origin === new URL(radar).origin ? radar : null;
  } catch {
    return null;
  }
}

export function MasternodePage() {
  const { proTx: raw = '' } = useParams();
  const proTx = raw.toLowerCase();
  useTitle(isProTx(proTx) ? `Masternode ${shortHash(proTx, 6)}` : 'Masternode not found');
  if (!isProTx(proTx)) {
    return (
      <section className="page-narrow">
        <h1 className="dh-page-header__title">Not a masternode</h1>
        <p>
          A masternode's address here is its 64-character ProTx hash. <Link to="/masternodes">My masternodes</Link>
        </p>
      </section>
    );
  }
  // a new masternode starts from nothing: no rows, open panel or address of the previous one
  return <MasternodeVotes key={proTx} proTx={proTx} />;
}

/** The voting deadline that decides this proposal's next payment (null: no payment left, or the cycle is not known yet). */
function decidesBy(row: Row, cycle: Cycle | null, params: GovParams): number | null {
  if (!cycle || row.lameDuck) return null;
  // a proposal that starts paying at a later superblock is decided by that superblock's deadline
  return row.startsLater ? Math.round(row.startsLater.firstTime - (cycle.superblockHeight - cycle.votingDeadlineHeight) * params.blockSeconds) : votingDeadlineTime(cycle, params);
}

function VoteChip({ cell, stalled }: { cell: VoteCell | undefined; stalled: boolean }) {
  if (stalled && (!cell || cell.kind === 'waiting')) return <span className="muted">—</span>;
  if (!cell || cell.kind === 'waiting') {
    return (
      <span className="mnv-reading" aria-label="Reading this masternode's vote">
        <span className="skel-line" aria-hidden="true" />
      </span>
    );
  }
  if (cell.kind === 'unread') return <span className="vout vout-none dh-badge" title={cell.error}>Couldn't read</span>;
  if (cell.kind === 'none') return <span className="vout vout-none dh-badge">Not voted</span>;
  return (
    <span className="mnv-vote">
      <span className={`vout vout-${cell.outcome} dh-badge`}>{OUTCOME_LABEL[cell.outcome]}</span>
      <span className="small muted">{formatDate(cell.time)}</span>
    </span>
  );
}

function MasternodeVotes({ proTx }: { proTx: string }) {
  const { activeRows, gov, params, registry, source } = useApp();
  const k = useKeyring();
  const rows = useMemo(() => [...activeRows.shown, ...activeRows.lameDucks].map((c) => c.item), [activeRows]);
  const failed = useMemo(() => new Set([...activeRows.shown, ...activeRows.lameDucks].filter((c) => c.check.status === 'failed').map((c) => c.item.p.value.govHash)), [activeRows]);
  const proposals = useMemo(() => rows.map((r) => r.p.value), [rows]);
  const names = useMemo(() => countNames(proposals), [proposals]);
  const v = useMasternodeVotes(proTx, proposals);
  const [open, setOpen] = useState<string | null>(null);
  const cycle = gov.cycle.data?.value ?? null;
  const now = source.now();
  const network = registry.coreNetwork === 'testnet' ? 'Testnet' : 'Mainnet';
  const radar = window.dashhq?.href('radar', '/mn/' + proTx, { network: registry.coreNetwork });
  const mn = v.lookup.kind === 'found' ? v.lookup.mn : null;
  const owned = k.status === 'open' && k.mns.owned.some((m) => m.valid && m.proTxHash.toLowerCase() === proTx);
  // the bridge's list could not be read: the rows say so instead of waiting forever
  const stalled = v.lookup.kind === 'error' || v.lookup.kind === 'no-bridge';
  const counts = useMemo(() => {
    const c = { yes: 0, no: 0, abstain: 0, none: 0, unread: 0 };
    for (const p of proposals) {
      const cell = v.cells.get(p.govHash);
      if (cell?.kind === 'voted') c[cell.outcome === 1 ? 'yes' : cell.outcome === 2 ? 'no' : 'abstain']++;
      else if (cell?.kind === 'none') c.none++;
      else if (cell?.kind === 'unread') c.unread++;
    }
    return c;
  }, [proposals, v.cells]);
  const deadline = cycle ? votingDeadlineTime(cycle, params) : null;
  const read = proposals.length - v.pending;
  const fromRadar = useMemo(() => cameFromRadar(proTx), [proTx]);
  // not in this network's list: is it in the other network's?
  const other = useOtherNetwork();
  const absent = v.lookup.kind === 'absent';
  const elsewhere = useProbe(absent ? other : null, async (o) => {
    const d = o.source.bridgeDescriptor();
    if (!d) throw new Error('no governance bridge');
    return (await makeBridge(d).mnlist()).masternodes.some((m) => m.proTxHash.toLowerCase() === proTx);
  }, `${proTx}:${absent}`);
  // Radar's record on the network the masternode is on: none to link while that is unknown
  const radarHere = !absent ? radar : elsewhere === 'found' && other ? window.dashhq?.href('radar', '/mn/' + proTx, { network: other.registry.coreNetwork }) : null;

  return (
    <section className="mnv-page" aria-labelledby="mnv-title" data-testid="mn-page">
      <p className="crumbs dh-crumbs" data-testid="mn-crumbs">
        {fromRadar && radar ? (
          <a href={radar}>‹ Back to Radar</a>
        ) : owned ? (
          <Link to="/masternodes">‹ My masternodes</Link>
        ) : (
          <Link to="/">‹ Active proposals</Link>
        )}
      </p>
      <header className="mnv-head dh-page-header">
        <h1 className="dh-page-header__title" id="mnv-title">Masternode votes</h1>
        <p className="mnv-id">
          <dashhq-hash value={proTx} full="" label="ProTx hash" {...(radarHere ? { href: radarHere } : {})}>
            {proTx}
          </dashhq-hash>
        </p>
        <p className="mnv-facts small" data-testid="mn-facts">
          {mn ? (
            <>
              <span>{mn.type === 'evo' ? 'Evonode: each vote counts 4 times' : 'Regular masternode: each vote counts once'}</span>
              <span>{mn.valid ? 'Can vote' : 'PoSe-banned: its votes are not counted'}</span>
              <span>
                Voting address <dashhq-hash value={mn.votingAddress} label="voting address">{mn.votingAddress}</dashhq-hash>
              </span>
            </>
          ) : v.lookup.kind === 'loading' ? (
            <span className="muted">Finding it in the {network} masternode list…</span>
          ) : null}
          {radarHere && (
            <span>
              <a href={radarHere}>Its record in Radar{absent && elsewhere === 'found' && other ? ` (${other.label})` : ''} →</a>
            </span>
          )}
        </p>
      </header>

      {v.lookup.kind === 'absent' && (
        <div data-testid="mn-absent">
          <NetworkProbeNotice
            thing="masternode"
            idLabel="ProTx hash"
            probe={elsewhere}
            other={other}
            absent={`Governance reads the governance bridge's masternode list, at block ${formatInt(v.lookup.height)}; it may have been removed.`}
            list={{ path: '/', label: `Browse ${network} proposals` }}
          />
        </div>
      )}
      {v.lookup.kind === 'no-bridge' && (
        <p className="notice-box dh-notice dh-notice--info small">No governance bridge is configured in Settings, so this masternode's votes can't be read here.</p>
      )}
      {v.lookup.kind === 'error' && (
        <div className="read-error" role="alert" data-testid="mn-lookup-error">
          <p>
            <b>Couldn't find this masternode just now:</b> {v.lookup.message}.
          </p>
          <p className="small muted">The proposals below are unaffected; only this masternode's votes are missing.</p>
          <button type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={v.retryLookup}>
            Try again
          </button>
        </div>
      )}

      {v.lookup.kind !== 'absent' && (
        <section className="mnv-list" aria-labelledby="mnv-list-title">
          <header className="mnv-list-head">
            <h2 id="mnv-list-title">Its votes on the {proposals.length ? formatInt(proposals.length) : ''} active proposals</h2>
            <p className="small muted" aria-live="polite" data-testid="mn-progress">
              {!mn
                ? 'As the governance bridge reports them.'
                : v.pending > 0
                  ? `Reading its votes from the governance bridge: ${formatInt(read)} of ${formatInt(proposals.length)} read.`
                  : `As the governance bridge reports them: ${[
                      counts.none ? `not voted on ${formatInt(counts.none)}` : '',
                      counts.yes ? `${formatInt(counts.yes)} yes` : '',
                      counts.no ? `${formatInt(counts.no)} no` : '',
                      counts.abstain ? `${formatInt(counts.abstain)} abstain` : '',
                    ]
                      .filter(Boolean)
                      .join(', ')}.`}
              {deadline !== null && deadline > now && <> Votes for the next payout close in {formatDuration(deadline - now)}, on {formatDate(deadline)}.</>}
            </p>
            {counts.unread > 0 && v.pending === 0 && (
              <p className="small" data-testid="mn-unread">
                {formatInt(counts.unread)} couldn't be read just now.{' '}
                <button type="button" className="linkish dh-btn dh-btn--link" onClick={v.retryUnread}>
                  Try again
                </button>
              </p>
            )}
          </header>
          {gov.active.loading && !rows.length ? (
            <p className="dh-loading">
              Reading the active proposals…
            </p>
          ) : !rows.length ? (
            <div className="empty-box dh-empty">
              <p>
                <b>No active proposals.</b>
              </p>
              <p className="small">New proposals show up here as soon as they are submitted.</p>
            </div>
          ) : (
            <table className="mnv-table dh-table dh-table--cards">
              <thead>
                <tr>
                  <th scope="col">Proposal</th>
                  <th scope="col" className="r">
                    Requests
                  </th>
                  <th scope="col">Standing</th>
                  <th scope="col">This masternode</th>
                  <th scope="col">Decided by</th>
                  <th scope="col">
                    <span className="visually-hidden">Vote</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <MnVoteRow
                    key={row.p.value.govHash}
                    row={row}
                    passed={row.content.ok && !failed.has(row.p.value.govHash)}
                    href={proposalHref(row.p.value, names)}
                    cell={v.cells.get(row.p.value.govHash)}
                    decides={decidesBy(row, cycle, params)}
                    shared={deadline}
                    now={now}
                    per={perPayment(params)}
                    open={open === row.p.value.govHash}
                    onToggle={() => setOpen((o) => (o === row.p.value.govHash ? null : row.p.value.govHash))}
                    canVote={(owned || !!mn?.valid) && !row.lameDuck}
                    stalled={stalled}
                    owned={owned}
                    proTx={proTx}
                    votingAddress={mn?.votingAddress ?? ''}
                  />
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {mn && !owned && <WaysToVoteLine />}
    </section>
  );
}

function WaysToVoteLine() {
  const k = useKeyring();
  return (
    <p className="mnv-ways small muted" data-testid="mn-ways">
      {k.status === 'signed-out' ? (
        <>
          <b>Is this your masternode?</b> Each row's <i>Vote</i> opens the proposal as this masternode: sign offline in Dash Core or with a hardware wallet, or
          paste its voting key for that tab only. Neither needs an account. To keep its key for next time,{' '}
          <button type="button" className="linkish dh-btn dh-btn--link" onClick={openSignIn}>
            sign in
          </button>{' '}
          and add it (<Link to="/masternodes">ways to vote</Link>).
        </>
      ) : k.status === 'open' ? (
        <>
          <b>Is this your masternode?</b> <Link to="/masternodes">Add its voting key</Link> to vote from your keyring, or use any row's <i>Vote</i> to sign offline.
        </>
      ) : (
        <>
          <b>Is this your masternode?</b> <Link to="/masternodes">Unlock your keyring</Link> to vote from it, or use any row's <i>Vote</i> to sign offline.
        </>
      )}
    </p>
  );
}

interface RowProps {
  row: Row;
  /** its fields match its hash and no check failed: the owner's title may show */
  passed: boolean;
  href: string;
  cell: VoteCell | undefined;
  decides: number | null;
  /** The next payout's voting deadline, which most rows share. */
  shared: number | null;
  now: number;
  per: string;
  open: boolean;
  onToggle(): void;
  canVote: boolean;
  stalled: boolean;
  owned: boolean;
  proTx: string;
  votingAddress: string;
}

function MnVoteRow({ row, passed, href, cell, decides, shared, now, per, open, onToggle, canVote, stalled, owned, proTx, votingAddress }: RowProps) {
  const p: Proposal = row.p.value;
  const panelId = useId();
  const sched = row.schedule;
  const status = row.lameDuck
    ? 'No payments left'
    : !row.tally
      ? 'No votes yet'
      : row.state?.passing
        ? `Passing by ${formatInt(row.state.margin)}`
        : row.state
          ? `Needs ${formatInt(row.state.needed)} more`
          : '';
  const tone = row.lameDuck || !row.state ? '' : row.state.light;
  // most rows share the next payout's deadline (said once above the table): those say it briefly, the others in full
  const common = decides !== null && decides === shared;
  const decideText =
    decides === null ? (row.lameDuck ? 'nothing left to decide' : '…') : decides <= now ? 'closed for the next payout' : common ? shortDate(decides) : `${shortDate(decides)} (${formatDuration(decides - now)})`;
  return (
    <Fragment>
      <tr className={`mnv-row${open ? ' mnv-row-open' : ''}`} data-testid="mn-vote-row" data-govhash={p.govHash}>
        <td role="rowheader" data-label="Proposal" className="dh-rc-title">
          <Link to={`${href}?mn=${proTx}`}><Slug name={p.name} /></Link>
          {passed && <OwnerTitle p={p} />}
        </td>
        <td className="r num" data-label="Requests">
          {formatDash(p.paymentAmount)} <span className="muted small">{sched?.oneTime ? 'once' : per}</span>
        </td>
        <td data-label="Standing">
          {status && (
            <span className={`mnv-status${tone ? ` mnv-${tone}` : ''}`}>
              <span className="dot" aria-hidden="true" />
              {status}
            </span>
          )}
          {row.startsLater && <span className="small muted"> · starts later</span>}
        </td>
        <td className="mnv-cell-vote dh-rc-end" data-label="This masternode" data-testid="mn-vote">
          <VoteChip cell={cell} stalled={stalled} />
        </td>
        <td className={`small mnv-decides${common ? ' mnv-common' : ''}`} data-label="Decided by">
          {decideText}
        </td>
        <td className="mnv-action dh-rc-actions" data-label="Vote">
          {canVote &&
            (owned ? (
              <button type="button" className="btn dh-btn btn-s dh-btn--sm" aria-expanded={open} aria-controls={panelId} onClick={onToggle} data-testid="mn-vote-action">
                {open ? 'Close' : 'Vote'}
                <span className="visually-hidden"> on {p.name}</span>
              </button>
            ) : (
              // the proposal's own vote block, as this masternode: offline signing filled in, or its voting key for this tab
              <Link className="btn dh-btn btn-s dh-btn--sm" to={`${href}?mn=${proTx}#vote`} data-testid="mn-vote-action">
                Vote
                <span className="visually-hidden"> on {p.name}</span>
              </Link>
            ))}
        </td>
      </tr>
      {open && owned && (
        <tr className="mnv-panel-row">
          <td data-label="Voting options" className="dh-rc-actions" colSpan={6} id={panelId}>
            <div className="mnv-panel" data-testid="mn-vote-panel">
              <VoteComposer proposals={[p]} onlyMn={proTx} />
              <OfflineSign proposal={p} address={votingAddress} />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
