// /p/h/<govHash> (canonical) and /p/<name> (slug; duplicate names get a chooser). The page leads with what a reader wants: the ask,
// whether it will be funded, the vote, the description and the discussion. Every check still runs (ui/trust/useProposalTrust.ts)
// and adds up to one badge; its detail is in the "How do we know?" drawer.
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { urlClaimIdentity } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { Discussion } from '../ui/Discussion.tsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { FundingMeter } from '../ui/FundingMeter.tsx';
import { ClaimPanel, OwnerPost, OwnerValue, RejectedClaims, useOwnership, useOwnerPost } from '../ui/Ownership.tsx';
import { openSignIn } from '../ui/SignIn.tsx';
import { TrustBadge } from '../ui/trust/TrustBadge.tsx';
import { useProposalTrust } from '../ui/trust/useProposalTrust.ts';
import { VerificationDrawer } from '../ui/trust/VerificationDrawer.tsx';
import { useReactions } from '../ui/useReactions.ts';
import { Votes } from '../ui/Votes.tsx';
import { OfflineSign, ProposalVotePanel } from '../ui/VotePanel.tsx';
import { useAsync } from '../ui/hooks.ts';
import type { Proposal, Sourced } from '../data/types.ts';
import { formatDash, formatDate, formatDateTime, formatDuration, formatInt, shortHash, urlHost } from '../lib/format.ts';
import { passState, perPayment, votingDeadlineTime } from '../lib/governance.ts';
import { deriveRow } from '../lib/view.ts';
import { deadlineFact, paymentsFact, thresholdFact } from '../verify/facts.ts';
import { useKeyring } from '../voting/KeyringContext.tsx';

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
    <section className="page-narrow">
      <h1>{list.length} proposals are named {name}</h1>
      <p className="muted">Names aren't unique in Dash governance. Pick one:</p>
      <ul className="chooser">
        {list.map((s) => (
          <li key={s.value.govHash}>
            <Link to={`/p/h/${s.value.govHash}`}>
              {formatDash(s.value.paymentAmount)}, {formatDate(s.value.startEpoch)} to {formatDate(s.value.endEpoch)}
            </Link>{' '}
            <span className="mono-ish muted small">{shortHash(s.value.govHash, 10)}</span>
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
    <section className="page-narrow">
      <h1>Not found</h1>
      <p>
        Platform has no record of {what}. It may not be published yet. <Link to="/">Back to active proposals</Link>
      </p>
    </section>
  );
}

/** Community up/down vote on the proposal (`reaction` kind 2): not a masternode funding vote. */
function CommunityVote({ govHash }: { govHash: string }) {
  const { session } = useForum();
  const targets = useMemo(() => [{ govHash }], [govHash]);
  const { scores, vote, error } = useReactions(targets);
  const s = scores.get(govHash) ?? { up: 0, down: 0, net: 0 };
  return (
    <div className="community-vote" data-testid="community-vote">
      <Votes score={s} signedIn={!!session} label="Community vote on this proposal" onVote={(v) => (session ? vote({ govHash }, v) : (openSignIn(), Promise.resolve()))} />
      <span className="small muted">
        {s.up} up, {s.down} down
      </span>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

/**
 * Masternode owners without an open keyring get a pointer, and offline signing (the key never enters the page); with a keyring, the
 * vote panel right below is the call to action.
 */
function VoteCta({ proposal, active }: { proposal: Proposal; active: boolean }) {
  const k = useKeyring();
  if (!active || k.status === 'open') return null;
  return (
    <div className="p-vote-cta">
      <p className="small muted">
        Own a masternode? <Link to="/masternodes">Add your voting key</Link> to vote here.
      </p>
      <OfflineSign proposal={proposal} />
    </div>
  );
}

function ProposalView({ sp }: { sp: Sourced<Proposal> }) {
  const { source, gov, params, checks } = useApp();
  const k = useKeyring();
  const p = sp.value;
  const now = source.now();
  const tallies = useAsync(() => source.tallies([p.govHash]), [source, p.govHash]);
  const cycle = gov.cycle.data ?? null;
  // The Platform tally document whenever there is one: the recount is checked against that proven record, not the bridge's own.
  const row = useMemo(() => deriveRow(sp, tallies.data ?? new Map(), gov.bridgeTallies, cycle, params, now, 'platform'), [sp, tallies.data, gov.bridgeTallies, cycle, params, now]);
  const trust = useProposalTrust(p, row, tallies.loading);
  const [drawer, setDrawer] = useState(false);
  const check = checks.state(p);

  const own = useOwnership(p, trust.collateral.verdict);
  const ownerId = own.verdict?.owner?.identityId ?? null;
  const post = useOwnerPost(p.govHash, ownerId);

  const t = row.tally?.value;
  const active = p.endEpoch > now;
  // Only link a URL that is the hash-committed one (the synchronous check passed).
  const host = row.content.ok ? urlHost(p.url) : null;
  const sched = row.schedule;
  const chain = trust.chain.report;
  // The proven threshold replaces the bridge's once the chain is verified.
  const threshold = thresholdFact(chain, row.threshold);
  const deadline = deadlineFact(chain, cycle?.value ?? null, now, cycle?.prov, cycle ? votingDeadlineTime(cycle.value, params) : null);
  const paid = paymentsFact(chain);
  const state = t && row.absYes !== null && threshold ? passState(row.absYes, threshold.value, trust.funded ?? t.inNextBudget) : null;
  // Proven data decides "in the next budget" once the badge is Verified; until then it is the tally's flag, under a lesser badge.
  const inBudget = trust.funded ?? !!t?.inNextBudget;
  // the verified chain's schedule once there is one (the deadline height is then proven, its time Core's own estimate)
  const untilDeadline = chain ? chain.schedule.deadlineEstTime - now : cycle ? votingDeadlineTime(cycle.value, params) - now : null;

  return (
    <article className="proposal">
      <p className="crumbs">
        <Link to={active ? '/' : '/past'}>‹ {active ? 'Active proposals' : 'Past proposals'}</Link>
      </p>
      {check.status === 'failed' && (
        <p className="invalid-banner" role="alert" data-testid="invalid-banner">
          <b>This proposal failed verification:</b> {check.reason}.{' '}
          {row.content.ok ? 'It is hidden from the proposal lists.' : 'It is hidden from the proposal lists and its link is disabled.'}{' '}
          <button type="button" className="linkish" onClick={() => setDrawer(true)}>
            See what failed
          </button>
        </p>
      )}

      <header className="p-hero">
        <div className="p-title">
          <h1>{p.name}</h1>
          <TrustBadge level={trust.aggregate.level} reason={trust.aggregate.reason} onOpen={() => setDrawer(true)} />
        </div>
        <div className="p-owner">
          <OwnerValue p={p} own={own} />
          <RejectedClaims own={own} />
        </div>
      </header>

      <div className="p-layout">
        <div className="p-main">
          <section className="panel p-ask" aria-label="Funding">
            <p className="p-amount">
              <span className="num">{formatDash(p.paymentAmount)}</span> <span className="p-per">{sched?.oneTime ? 'one payment' : perPayment(params)}</span>
            </p>
            {sched && !sched.oneTime && sched.total > 0 && (
              <p className="muted">
                {sched.remaining === 0 ? 'No payments left' : `${formatInt(sched.remaining)} of ${formatInt(sched.total)} payments left`}, {formatDash(p.paymentAmount * sched.total)} in total
              </p>
            )}
            {state && threshold && row.absYes !== null ? (
              <FundingMeter absYes={row.absYes} threshold={threshold.value} state={state} />
            ) : (
              <p className="muted">{tallies.loading ? 'Reading the votes…' : t ? 'Waiting for the budget cycle' : 'No votes counted yet'}</p>
            )}
            {active && t && (
              <p className="p-status">
                {inBudget ? <span className="tag tag-pass">In the next budget</span> : state?.passing ? <span className="tag tag-warn">Passing, but the next budget is full</span> : null}
                {untilDeadline !== null && (
                  <span className="muted">{untilDeadline > 0 ? `Voting closes in ${formatDuration(untilDeadline)}` : 'Voting for this payout has closed; new votes count toward the next one'}</span>
                )}
              </p>
            )}
            {t && (
              <p className="p-votes" data-testid="p-votes" aria-label={`Masternode votes, weighted: ${t.yesWeighted} yes, ${t.noWeighted} no, ${t.abstainWeighted} abstain`}>
                <span>
                  <b>{formatInt(t.yesWeighted)}</b> yes
                </span>
                <span>
                  <b>{formatInt(t.noWeighted)}</b> no
                </span>
                <span>
                  <b>{formatInt(t.abstainWeighted)}</b> abstain
                </span>
                <span className="muted small" data-testid="p-voters" title={`${formatInt(t.yesCount)} yes, ${formatInt(t.noCount)} no, ${formatInt(t.abstainCount)} abstain; counted at block ${formatInt(t.asOfHeight)}`}>
                  {formatInt(t.yesCount + t.noCount + t.abstainCount)} masternodes voted; evonodes count 4 times
                </span>
              </p>
            )}
            {tallies.error && <p className="error small">The tally could not be read: {tallies.error}</p>}
            <VoteCta proposal={p} active={active} />
          </section>

          {active && k.status === 'open' && (
            <ErrorBoundary what="masternode voting">
              <ProposalVotePanel proposal={p} onVerify={() => setDrawer(true)} />
            </ErrorBoundary>
          )}

          <section className="p-about" aria-labelledby="about-title">
            <h2 id="about-title">About this proposal</h2>
            {ownerId ? (
              <ErrorBoundary what="owner's description">
                <OwnerPost govHash={p.govHash} ownerId={ownerId} post={post} />
              </ErrorBoundary>
            ) : null}
            {!(post.state?.post && post.state.body !== null) && (
              <p className="muted">
                {host ? (
                  <>
                    The owner describes it on their own page:{' '}
                    <a href={p.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="ext">
                      {host}
                      <span className="visually-hidden"> (opens another site)</span>
                    </a>
                  </>
                ) : (
                  'No description has been posted here yet.'
                )}
              </p>
            )}
          </section>

          <ErrorBoundary what="discussion">
            <Discussion govHash={p.govHash} owner={ownerId} />
          </ErrorBoundary>
        </div>

        <aside className="p-side" aria-label="Summary">
          <section className="panel">
            <h2 className="panel-title">Summary</h2>
            <dl className="kv" data-testid="summary">
              {paid && (
                <div>
                  <dt>Paid so far</dt>
                  <dd>
                    {paid.made.text}, {paid.remaining.text}
                  </dd>
                </div>
              )}
              <div>
                <dt>Runs</dt>
                <dd>
                  {formatDate(p.startEpoch)} to {formatDate(p.endEpoch)}
                </dd>
              </div>
              {host && (
                <div>
                  <dt>Website</dt>
                  <dd>
                    <a href={p.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="ext">
                      {host}
                    </a>
                  </dd>
                </div>
              )}
              <div>
                <dt>Submitted</dt>
                <dd>{formatDateTime(p.time)}</dd>
              </div>
              <div>
                <dt>Community</dt>
                <dd>
                  <CommunityVote govHash={p.govHash} />
                </dd>
              </div>
            </dl>
            <button type="button" className="linkish small" onClick={() => setDrawer(true)}>
              Hashes, raw data and every check
            </button>
          </section>
          <ClaimPanel p={p} own={own} collateral={trust.collateral.verdict} />
        </aside>
      </div>

      <VerificationDrawer sp={sp} trust={trust} cycle={cycle?.value ?? null} open={drawer} onClose={() => setDrawer(false)} />
    </article>
  );
}
