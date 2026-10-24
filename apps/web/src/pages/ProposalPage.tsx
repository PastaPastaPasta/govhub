// /p/h/<govHash> (canonical) and /p/<name> (slug; duplicate names get a chooser).
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { parseProposalData } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import type { Proposal, Provenance, Sourced } from '../data/types.ts';
import { formatDash, formatDate, formatDateTime, formatInt, formatRelative, formatSigned, shortHash, urlHost } from '../lib/format.ts';
import { votingDeadlineTime } from '../lib/governance.ts';
import { deriveRow, weakest } from '../lib/view.ts';
import { BRIDGE_TARGET, PLATFORM_TARGET, tallyProvenance } from '../verify/verdict.ts';
import type { VoteTarget } from '../verify/votes.ts';
import { useAsync, useCollateralCheck } from '../ui/hooks.ts';
import { PassingBar } from '../ui/PassingBar.tsx';
import { paymentText } from '../ui/ProposalCard.tsx';
import { ProvMark } from '../ui/Provenance.tsx';
import { VerificationPanel } from '../ui/VerificationPanel.tsx';
import type { ChainFacts, CollateralVerdict } from '../verify/collateral.ts';
import type { VotesDone } from '../verify/protocol.ts';

export function ProposalByHash() {
  const { hash = '' } = useParams();
  const { source } = useApp();
  const load = useAsync(() => (/^[0-9a-fA-F]{64}$/.test(hash) ? source.proposal(hash.toLowerCase()) : Promise.resolve(null)), [source, hash]);
  if (load.loading) return <Loading />;
  if (load.error) return <p className="error">Platform could not be read: {load.error}</p>;
  if (!load.data) return <NotFound what={`a proposal with hash ${shortHash(hash)}`} />;
  return <ProposalView sp={load.data} />;
}

export function ProposalByName() {
  const { name = '' } = useParams();
  const { source } = useApp();
  const load = useAsync(() => source.byName(name), [source, name]);
  if (load.loading) return <Loading />;
  if (load.error) return <p className="error">Platform could not be read: {load.error}</p>;
  const list = load.data ?? [];
  if (list.length === 0) return <NotFound what={`a proposal named "${name}"`} />;
  if (list.length === 1) return <ProposalView sp={list[0]!} />;
  return (
    <section className="list-section">
      <h1>{list.length} proposals are named {name}</h1>
      <p className="muted">Names are not unique in Dash governance. Pick one by its hash:</p>
      <ul className="chooser">
        {list.map((s) => (
          <li key={s.value.govHash}>
            <Link to={`/p/h/${s.value.govHash}`}>
              <span className="mono-ish">{shortHash(s.value.govHash, 10)}</span>
            </Link>{' '}
            {formatDash(s.value.paymentAmount)}, {formatDate(s.value.startEpoch)} to {formatDate(s.value.endEpoch)} <ProvMark prov={s.prov} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Loading() {
  return (
    <p className="muted center pad" aria-busy="true">
      <span className="spinner" aria-hidden="true" /> Loading the proposal…
    </p>
  );
}

function NotFound({ what }: { what: string }) {
  return (
    <section className="list-section">
      <h1>Not found</h1>
      <p>
        Platform has no record of {what}. It may not be published yet. <Link to="/">Back to active proposals</Link>
      </p>
    </section>
  );
}

function Item({ label, children, prov }: { label: string; children: ReactNode; prov?: Provenance | null }) {
  return (
    <div className="info-row">
      <dt>{label}</dt>
      <dd>
        {children} {prov && <ProvMark prov={prov} />}
      </dd>
    </div>
  );
}

/** Once the browser has checked the collateral, its provenance replaces the source's. */
function contentProvenance(p: Proposal, sourced: Provenance, verdict: CollateralVerdict | null): Provenance {
  if (!verdict) return sourced;
  const source = 'collateral check in this browser';
  if (verdict.ok) return { kind: 'verified', source, detail: `hash recomputed from dataHex; collateral ${shortHash(p.collateralTxid, 6)} checked over DAPI` };
  return { kind: 'mismatch', source, detail: verdict.steps.filter((s) => s.status === 'fail').map((s) => s.label).join(', ') };
}

/** What is known about the collateral's place in the chain, and whether this browser proved it or a node said so. */
function chainStatus(c: ChainFacts): { text: string; prov: Provenance } {
  const source = 'collateral check in this browser';
  const conf = formatInt(c.provenConfirmations ?? c.confirmations);
  if (c.chainLocked === 'verified') {
    return { text: `ChainLocked, BLS-verified; at least ${conf} confirmations`, prov: { kind: 'verified', source, detail: 'block proven by its merkle root; a BLS-valid ChainLock covers it through an X11-checked header chain' } };
  }
  const proven = c.merkle ? 'block inclusion proven by its merkle root' : 'block inclusion not proven';
  return {
    text: c.chainLocked === 'claimed' ? `ChainLocked as a node reports; ${conf} confirmations (node-reported)` : `Not ChainLocked yet; ${conf} confirmations (node-reported)`,
    prov: { kind: 'reported', source, detail: `${proven}; the ChainLock was not verified here` },
  };
}

function ProposalView({ sp }: { sp: Sourced<Proposal> }) {
  const { source, gov, params } = useApp();
  const p = sp.value;
  const now = source.now();
  const tallies = useAsync(() => source.tallies([p.govHash]), [source, p.govHash]);
  const collateral = useCollateralCheck(p);
  const [votes, setVotes] = useState<VotesDone | null>(null);
  const cycle = gov.cycle.data ?? null;
  const row = useMemo(() => deriveRow(sp, tallies.data ?? new Map(), gov.bridgeTallies, cycle, params, now), [sp, tallies.data, gov.bridgeTallies, cycle, params, now]);
  const parsed = useMemo(() => parseProposalData(p.dataHex), [p.dataHex]);
  const json = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(parsed.text), null, 2);
    } catch {
      return parsed.text; // Core's parser is more lenient than JSON.parse; show the bytes as they are
    }
  }, [parsed.text]);

  const contentProv = contentProvenance(p, sp.prov, collateral.verdict);
  // The shown tally is one of the two published ones; a recount of the votes can upgrade or downgrade its provenance.
  const shownName = row.tally === row.bridgeTally ? BRIDGE_TARGET : PLATFORM_TARGET;
  const tallyProv = row.tally ? tallyProvenance({ name: shownName, prov: row.tally.prov, tally: row.tally.value }, votes?.runs) : null;
  const targets = useMemo<VoteTarget[]>(
    () => [
      ...(row.platformTally ? [{ name: PLATFORM_TARGET, tally: row.platformTally.value }] : []),
      ...(row.bridgeTally ? [{ name: BRIDGE_TARGET, tally: row.bridgeTally.value }] : []),
    ],
    [row.platformTally, row.bridgeTally],
  );

  const t = row.tally?.value;
  // Only link a URL that is the hash-committed one (the synchronous check passed).
  const host = row.content.ok ? urlHost(p.url) : null;
  const sched = row.schedule;
  const deadline = cycle ? `${formatRelative(votingDeadlineTime(cycle.value, params), now)}, block ${formatInt(cycle.value.votingDeadlineHeight)}` : null;

  return (
    <article className="proposal">
      <header className="proposal-head">
        <p className="crumbs">
          <Link to={p.endEpoch > now ? '/' : '/past'}>{p.endEpoch > now ? 'Active proposals' : 'Past proposals'}</Link>
        </p>
        <h1>{p.name}</h1>
        {!row.content.ok && (
          <p className="error" role="alert">
            The published fields do not match the proposal's hashed data ({row.content.problem}). The link is disabled; see Raw proposal data for what the hash commits to.
          </p>
        )}
        <p className="proposal-sub">
          {paymentText(p.paymentAmount, sched)}
          {host && (
            <>
              {' '}
              <a href={p.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="ext">
                {host}
                <span className="visually-hidden"> (opens the proposal's own page on another site)</span>
              </a>
            </>
          )}
        </p>
        {row.state && row.absYes !== null && row.threshold && <PassingBar absYes={row.absYes} threshold={row.threshold.value} state={row.state} />}
      </header>

      <div className="proposal-body">
        <section aria-labelledby="info-title" className="info">
          <h2 id="info-title">Details</h2>
          <dl className="info-table">
            <Item label="Payment" prov={contentProv}>
              {formatDash(p.paymentAmount)} per superblock
            </Item>
            <Item label="Payments" prov={cycle?.prov}>
              {sched ? (
                <>
                  {formatInt(sched.total)} in total, {formatInt(sched.remaining)} remaining <span className="muted">(estimated from superblock times)</span>
                </>
              ) : (
                '–'
              )}
            </Item>
            <Item label="Total requested">{sched ? formatDash(p.paymentAmount * sched.total) : '–'}</Item>
            <Item label="Start" prov={contentProv}>
              {formatDateTime(p.startEpoch)}
            </Item>
            <Item label="End" prov={contentProv}>
              {formatDateTime(p.endEpoch)}
            </Item>
            {cycle && (
              <Item label="Voting deadline" prov={cycle.prov}>
                {deadline}
              </Item>
            )}
            <Item label="Votes, weighted" prov={tallyProv}>
              {t ? (
                <>
                  <b>{formatInt(t.yesWeighted)}</b> yes, <b>{formatInt(t.noWeighted)}</b> no, <b>{formatInt(t.abstainWeighted)}</b> abstain
                </>
              ) : tallies.error ? (
                <span className="error">Tally could not be read: {tallies.error}</span>
              ) : tallies.loading ? (
                'Loading…'
              ) : (
                'No tally published yet'
              )}
            </Item>
            <Item label="Votes, masternodes" prov={tallyProv}>
              {t ? `${formatInt(t.yesCount)} yes, ${formatInt(t.noCount)} no, ${formatInt(t.abstainCount)} abstain` : '–'}
            </Item>
            <Item label="Net yes" prov={tallyProv && row.threshold ? weakest(tallyProv, row.threshold.prov) : null}>
              {row.absYes !== null && row.threshold ? (
                <>
                  {formatSigned(row.absYes)} of {formatInt(row.threshold.value)} needed
                </>
              ) : (
                '–'
              )}
            </Item>
            <Item label="Funded" prov={tallyProv}>
              {t ? (t.inNextBudget ? 'Yes, in the next superblock' : row.state?.passing ? 'Passing, but not in the next superblock (budget full or outside its payment window)' : 'No') : '–'}
              {t && t.rank > 0 && <span className="muted"> (rank {t.rank})</span>}
            </Item>
            {row.platformTally && row.bridgeTally && row.platformTally.value.asOfHeight !== row.bridgeTally.value.asOfHeight && (
              <Item label="Tallies" prov={row.bridgeTally.prov}>
                Platform as of block {formatInt(row.platformTally.value.asOfHeight)}, bridge live as of block {formatInt(row.bridgeTally.value.asOfHeight)}; showing the newer one
              </Item>
            )}
            <Item label="Owner" prov={contentProv}>
              Not claimed yet. Pays to <span className="mono-ish break">{p.paymentAddress}</span>
            </Item>
            <Item label="Collateral" prov={contentProv}>
              <span className="mono-ish break">{p.collateralTxid}</span> <span className="muted">at block {formatInt(p.collateralHeight)}</span>
            </Item>
            {collateral.verdict?.chain && (
              <Item label="Collateral status" prov={chainStatus(collateral.verdict.chain).prov}>
                {chainStatus(collateral.verdict.chain).text}
              </Item>
            )}
            <Item label="Submitted" prov={contentProv}>
              {formatDateTime(p.time)}
            </Item>
            <Item label="Governance hash" prov={contentProv}>
              <span className="mono-ish break">{p.govHash}</span>
            </Item>
            {p.docId && (
              <Item label="Platform document" prov={sp.prov}>
                <span className="mono-ish break">{p.docId}</span>
              </Item>
            )}
          </dl>
        </section>

        <VerificationPanel proposal={p} collateral={collateral} targets={targets} onVotes={setVotes} />
      </div>

      <section aria-labelledby="raw-title" className="raw">
        <h2 id="raw-title">Raw proposal data</h2>
        <p className="muted small">
          Exactly what the governance hash commits to ({formatInt(parsed.dataBytes)} bytes). The URL is the owner's own page; govhub does not host or check its content.
        </p>
        <pre className="code">{json}</pre>
        <details>
          <summary>dataHex</summary>
          <pre className="code break">{p.dataHex}</pre>
        </details>
      </section>

      <section aria-labelledby="discussion-title" className="discussion">
        <h2 id="discussion-title">Discussion</h2>
        <p className="muted">Comments are stored on Dash Platform and arrive in the next phase. Until then, the proposal's own page is linked above.</p>
      </section>
    </article>
  );
}
