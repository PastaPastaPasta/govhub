// /p/h/<govHash> (canonical) and /p/<name> (slug; duplicate names get a chooser).
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { parseProposalData, urlClaimIdentity } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { Discussion } from '../ui/Discussion.tsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { ClaimPanel, OwnerPost, OwnerValue, ownerProvenance, RejectedClaims, useOwnership, useOwnerPost } from '../ui/Ownership.tsx';
import { openSignIn } from '../ui/SignIn.tsx';
import { useReactions } from '../ui/useReactions.ts';
import { Votes } from '../ui/Votes.tsx';
import type { Proposal, Provenance, Sourced } from '../data/types.ts';
import { formatDash, formatDate, formatDateTime, formatInt, formatRelative, formatSigned, shortHash, urlHost } from '../lib/format.ts';
import { perSuperblock, votingDeadlineTime } from '../lib/governance.ts';
import { deriveRow, weakest } from '../lib/view.ts';
import { BRIDGE_TARGET, PLATFORM_TARGET, tallyProvenance } from '../verify/verdict.ts';
import type { VoteTarget } from '../verify/votes.ts';
import { useAsync, useChainReport, useCollateralCheck } from '../ui/hooks.ts';
import { PassingBar } from '../ui/PassingBar.tsx';
import { paymentText } from '../ui/ProposalCard.tsx';
import { ProvMark } from '../ui/Provenance.tsx';
import { VerificationPanel } from '../ui/VerificationPanel.tsx';
import type { CollateralVerdict } from '../verify/collateral.ts';
import { collateralHeightProv, collateralStatus, deadlineFact, fundedFact, paymentsFact, thresholdFact } from '../verify/facts.ts';
import type { RankingDone, VotesDone } from '../verify/protocol.ts';
import { ProposalVotePanel } from '../ui/VotePanel.tsx';

export function ProposalByHash() {
  const { hash = '' } = useParams();
  const { source } = useApp();
  const load = useAsync(() => (/^[0-9a-fA-F]{64}$/.test(hash) ? source.proposal(hash.toLowerCase()) : Promise.resolve(null)), [source, hash]);
  if (load.loading) return <Loading />;
  if (load.error) return <p className="error">Platform could not be read: {load.error}</p>;
  if (!load.data) return <NotFound what={`a proposal with hash ${shortHash(hash)}`} />;
  return <ProposalView sp={load.data} />;
}

/**
 * /p/<name>, and /p/<identityId>/<name>: the URL govhub's wizard commits into new proposals (claim method 1). With an
 * identity, the proposals of that name whose hashed URL names it are preferred; the page's own claim check decides.
 */
export function ProposalByName() {
  const { name = '', identity } = useParams();
  const { source, registry } = useApp();
  const load = useAsync(() => source.byName(name), [source, name]);
  if (load.loading) return <Loading />;
  if (load.error) return <p className="error">Platform could not be read: {load.error}</p>;
  const all = load.data ?? [];
  const named = identity ? all.filter((s) => urlClaimIdentity(s.value.url, s.value.name, registry.forum.claimPortals) === identity) : [];
  const list = named.length ? named : all;
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

function RawData({ json, dataHex, bytes }: { json: string; dataHex: string; bytes: number }) {
  return (
    <>
      <p className="muted small">
        Exactly what the governance hash commits to ({formatInt(bytes)} bytes). The URL is the owner's own page; govhub does not host or check its content.
      </p>
      <pre className="code">{json}</pre>
      <details>
        <summary>dataHex</summary>
        <pre className="code break">{dataHex}</pre>
      </details>
    </>
  );
}

/** Community up/down vote on the proposal (`reaction` kind 2): not a Core governance vote. */
function CommunityVote({ govHash }: { govHash: string }) {
  const { session } = useForum();
  const targets = useMemo(() => [{ govHash }], [govHash]);
  const { scores, vote, error } = useReactions(targets);
  const s = scores.get(govHash) ?? { up: 0, down: 0, net: 0 };
  return (
    <div className="community-vote" data-testid="community-vote">
      <span className="small muted">Community vote</span>
      <Votes score={s} signedIn={!!session} label="Community vote on this proposal" onVote={(v) => (session ? vote({ govHash }, v) : (openSignIn(), Promise.resolve()))} />
      <span className="small muted">
        {s.up} up, {s.down} down. Anyone with an identity can vote; masternode funding votes are the tally above.
      </span>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

function ProposalView({ sp }: { sp: Sourced<Proposal> }) {
  const { source, gov, params, mode, checks } = useApp();
  const p = sp.value;
  const now = source.now();
  const tallies = useAsync(() => source.tallies([p.govHash]), [source, p.govHash]);
  const collateral = useCollateralCheck(p);
  // This page's full check counts for the lists too; a proposal hidden there is still shown here, under a banner.
  useEffect(() => {
    if (collateral.verdict) checks.record(p, collateral.verdict, { full: true });
  }, [checks, p, collateral.verdict]);
  useSyncExternalStore(checks.subscribe, checks.getVersion);
  const check = checks.state(p);
  const [votes, setVotes] = useState<VotesDone | null>(null);
  const [ranking, setRanking] = useState<RankingDone | null>(null);
  const chain = useChainReport(p, collateral.verdict);
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

  const own = useOwnership(p, collateral.verdict);
  const ownerId = own.verdict?.owner?.identityId ?? null;
  const post = useOwnerPost(p.govHash, ownerId);
  // The owner's description replaces the raw fields once it exists (they stay one click away).
  const postShown = !!post.state?.post && post.state.body !== null;
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
  // Chain facts proven in this browser replace the bridge's numbers where they exist (heights verified, times estimated).
  const deadline = deadlineFact(chain.report, cycle?.value ?? null, now, cycle?.prov, cycle ? votingDeadlineTime(cycle.value, params) : null);
  const threshold = thresholdFact(chain.report, row.threshold);
  const paid = paymentsFact(chain.report);
  const funded = fundedFact(ranking?.result ?? null, p.govHash);

  return (
    <article className="proposal">
      <header className="proposal-head">
        <p className="crumbs">
          <Link to={p.endEpoch > now ? '/' : '/past'}>{p.endEpoch > now ? 'Active proposals' : 'Past proposals'}</Link>
        </p>
        <h1>{p.name}</h1>
        {check.status === 'failed' && (
          <p className="invalid-banner" role="alert" data-testid="invalid-banner">
            <b>This proposal failed verification:</b> {check.reason}.{' '}
            {row.content.ok ? 'It is hidden from the proposal lists.' : 'It is hidden from the proposal lists and its link is disabled; see Raw proposal data for what the hash commits to.'}
          </p>
        )}
        <p className="proposal-sub">
          {paymentText(p.paymentAmount, sched, params)}
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
        {row.state && row.absYes !== null && threshold && <PassingBar absYes={row.absYes} threshold={threshold.value} state={row.state} />}
        <CommunityVote govHash={p.govHash} />
      </header>

      <div className="proposal-body">
        <section aria-labelledby="info-title" className="info">
          <h2 id="info-title">Details</h2>
          <dl className="info-table">
            <Item label="Payment" prov={contentProv}>
              {formatDash(p.paymentAmount)} {perSuperblock(params)}
            </Item>
            {paid ? (
              <>
                <Item label="Payments made" prov={paid.made.prov}>
                  {paid.made.text}
                </Item>
                <Item label="Payments remaining" prov={paid.remaining.prov}>
                  {paid.remaining.text} <span className="muted">(estimated from block times)</span>
                </Item>
              </>
            ) : (
              <Item label="Payments" prov={cycle?.prov}>
                {sched ? (
                  <>
                    {formatInt(sched.total)} in total, {formatInt(sched.remaining)} remaining <span className="muted">(estimated from superblock times)</span>
                  </>
                ) : (
                  '–'
                )}
              </Item>
            )}
            <Item label="Total requested">{sched ? formatDash(p.paymentAmount * sched.total) : '–'}</Item>
            <Item label="Start" prov={contentProv}>
              {formatDateTime(p.startEpoch)}
            </Item>
            <Item label="End" prov={contentProv}>
              {formatDateTime(p.endEpoch)}
            </Item>
            {deadline && (
              <Item label="Voting deadline" prov={deadline.prov}>
                {deadline.text}
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
            <Item label="Net yes" prov={tallyProv && threshold ? weakest(tallyProv, threshold.prov) : null}>
              {row.absYes !== null && threshold ? (
                <>
                  {formatSigned(row.absYes)} of {formatInt(threshold.value)} needed
                </>
              ) : (
                '–'
              )}
            </Item>
            <Item label="Funded" prov={funded?.prov ?? tallyProv}>
              {funded ? funded.text : t ? (t.inNextBudget ? 'Yes, in the next superblock' : row.state?.passing ? 'Passing, but not in the next superblock (budget full or outside its payment window)' : 'No') : '–'}
              {!funded && t && t.rank > 0 && <span className="muted"> (rank {t.rank})</span>}
            </Item>
            {row.platformTally && row.bridgeTally && row.platformTally.value.asOfHeight !== row.bridgeTally.value.asOfHeight && (
              <Item label="Tallies" prov={row.bridgeTally.prov}>
                Platform as of block {formatInt(row.platformTally.value.asOfHeight)}, bridge live as of block {formatInt(row.bridgeTally.value.asOfHeight)}; showing the newer one
              </Item>
            )}
            <Item label="Owner" prov={ownerProvenance(own.verdict?.owner ?? null, mode === 'fixtures') ?? contentProv}>
              <OwnerValue p={p} own={own} />
              <RejectedClaims own={own} />
            </Item>
            <Item label="Collateral" prov={collateralHeightProv(collateral.verdict?.chain, p.collateralHeight, contentProv)}>
              <span className="mono-ish break">{p.collateralTxid}</span> <span className="muted">at block {formatInt(p.collateralHeight)}</span>
            </Item>
            {collateral.verdict?.chain && (
              <Item label="Collateral status" prov={collateralStatus(collateral.verdict.chain).prov}>
                {collateralStatus(collateral.verdict.chain).text}
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
          <ClaimPanel p={p} own={own} collateral={collateral.verdict} />
        </section>

        <VerificationPanel proposal={p} collateral={collateral} chain={chain} cycle={cycle?.value ?? null} targets={targets} onVotes={setVotes} onRanking={setRanking} />
      </div>

      {p.endEpoch > Date.now() / 1000 && (
        <ErrorBoundary what="masternode voting">
          <ProposalVotePanel proposal={p} />
        </ErrorBoundary>
      )}

      {ownerId && (
        <ErrorBoundary what="owner's description">
          <OwnerPost govHash={p.govHash} ownerId={ownerId} post={post} />
        </ErrorBoundary>
      )}

      {postShown ? (
        <details className="raw raw-collapsed">
          <summary>Raw proposal data (what the governance hash commits to)</summary>
          <RawData json={json} dataHex={p.dataHex} bytes={parsed.dataBytes} />
        </details>
      ) : (
        <section aria-labelledby="raw-title" className="raw">
          <h2 id="raw-title">Raw proposal data</h2>
          <RawData json={json} dataHex={p.dataHex} bytes={parsed.dataBytes} />
        </section>
      )}

      <ErrorBoundary what="discussion">
        <Discussion govHash={p.govHash} owner={ownerId} />
      </ErrorBoundary>
    </article>
  );
}
