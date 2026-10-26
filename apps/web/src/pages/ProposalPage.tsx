// /p/h/<govHash> (canonical) and /p/<name> (slug; duplicate names get a chooser). The page leads with what a reader wants: the ask,
// whether it will be funded, the vote, the description and the discussion. Every check still runs (ui/trust/useProposalTrust.ts)
// and adds up to one badge; its detail is in the "How do we know?" drawer.
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { urlClaimIdentity } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { Discussion } from '../ui/Discussion.tsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { ReadError } from '../ui/ReadError.tsx';
import { FundingMeter } from '../ui/FundingMeter.tsx';
import { LameDuckPageStatus } from '../ui/LameDuck.tsx';
import { StartsLaterPageStatus } from '../ui/StartsLater.tsx';
import { ClaimPanel, OwnerPost, OwnerValue, RejectedClaims, useOwnership, useOwnerPost } from '../ui/Ownership.tsx';
import { TrustBadge } from '../ui/trust/TrustBadge.tsx';
import { useProposalTrust } from '../ui/trust/useProposalTrust.ts';
import { VerificationDrawer } from '../ui/trust/VerificationDrawer.tsx';
import { OfflineSign, ProposalVotePanel } from '../ui/VotePanel.tsx';
import { useAsync } from '../ui/hooks.ts';
import type { Proposal, Sourced } from '../data/types.ts';
import { formatDash, formatDate, formatDateTime, formatDuration, formatInt, shortHash, urlHost } from '../lib/format.ts';
import { passState, perPayment, votingDeadlineTime } from '../lib/governance.ts';
import { deriveRow } from '../lib/view.ts';
import { isLowerBound } from '../verify/chain.ts';
import { paymentsFact, thresholdFact } from '../verify/facts.ts';
import { useKeyring } from '../voting/KeyringContext.tsx';

export function ProposalByHash() {
  const { hash = '' } = useParams();
  const { source } = useApp();
  const [attempt, setAttempt] = useState(0); // Retry re-runs the read in place: no reload, so memory-only keys stay
  const load = useAsync(() => (/^[0-9a-fA-F]{64}$/.test(hash) ? source.proposal(hash.toLowerCase()) : Promise.resolve(null)), [source, hash, attempt]);
  if (load.loading) return <Loading />;
  if (load.error) return <ReadError error={load.error} what="Platform" lead="The proposal could not be read" onRetry={() => setAttempt((n) => n + 1)} />;
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
  const [attempt, setAttempt] = useState(0);
  const load = useAsync(() => source.byName(name), [source, name, attempt]);
  if (load.loading) return <Loading />;
  if (load.error) return <ReadError error={load.error} what="Platform" lead="The proposal could not be read" onRetry={() => setAttempt((n) => n + 1)} />;
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

export function ProposalView({ sp }: { sp: Sourced<Proposal> }) {
  const { source, gov, params, checks } = useApp();
  const k = useKeyring();
  const p = sp.value;
  const now = source.now();
  const [talliesAttempt, setTalliesAttempt] = useState(0);
  const tallies = useAsync(() => source.tallies([p.govHash]), [source, p.govHash, talliesAttempt]);
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
  const paid = paymentsFact(chain);
  // Proven data decides "in the next budget" once the badge is Verified; until then it is the tally's flag, under a lesser badge.
  const inBudget = trust.funded ?? !!t?.inNextBudget;
  // Not due until a later superblock, by the schedule: "not in the next budget" is no warning, and the next deadline is not its own.
  const later = row.startsLater && !trust.funded ? row.startsLater : null;
  const state = t && row.absYes !== null && threshold ? passState(row.absYes, threshold.value, later ? undefined : inBudget) : null;
  // Nothing left that can pay it: the list's estimate (with its slack) and, once there is one, the verified chain's "N more possible"
  // fact must both say so, so the page never shows "0 more possible" next to a passing bar, nor "1 payment left" above "no more".
  const payments = chain?.payments ?? null;
  const lameDuck = row.lameDuck && !inBudget && (!payments || payments.remainingEstimate <= 0);
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
            {lameDuck ? (
              <LameDuckPageStatus
                total={sched?.total ?? 0}
                paid={payments ? { count: payments.paid.length, atLeast: isLowerBound(payments), firm: payments.othersComplete !== false && !payments.anchor?.weak } : null}
                endEpoch={p.endEpoch}
                counting={!chain && !trust.chain.error && !trust.chain.unavailable}
              />
            ) : state && threshold && row.absYes !== null ? (
              <FundingMeter absYes={row.absYes} threshold={threshold.value} state={state} />
            ) : (
              <p className="muted">{tallies.loading ? 'Reading the votes…' : t ? 'Waiting for the budget cycle' : 'No votes counted yet'}</p>
            )}
            {later && <StartsLaterPageStatus later={later} />}
            {active && !lameDuck && !later && t && (
              <p className="p-status">
                {inBudget ? <span className="tag tag-pass">In the next budget</span> : state?.passing ? <span className="tag tag-warn">Passing, but the next budget is full</span> : null}
                {untilDeadline !== null && (
                  <span className="muted">{untilDeadline > 0 ? `Voting closes in ${formatDuration(untilDeadline)}` : 'Voting for this payout has closed; new votes count toward the next one'}</span>
                )}
              </p>
            )}
            {t && (
              <p className={`p-votes${lameDuck ? ' p-votes-dim' : ''}`} data-testid="p-votes" aria-label={`Masternode votes, weighted: ${t.yesWeighted} yes, ${t.noWeighted} no, ${t.abstainWeighted} abstain`}>
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
                {lameDuck && <span className="small muted">These votes no longer affect payment.</span>}
              </p>
            )}
            {tallies.error && <ReadError error={tallies.error} what="Platform" lead="The tally could not be read" onRetry={() => setTalliesAttempt((n) => n + 1)} />}
            <VoteCta proposal={p} active={active && !lameDuck} />
          </section>

          {active && !lameDuck && k.status === 'open' && (
            <ErrorBoundary what="masternode voting">
              <ProposalVotePanel proposal={p} onVerify={() => setDrawer(true)} />
            </ErrorBoundary>
          )}

          <section className="p-about" aria-labelledby="about-title">
            <h2 id="about-title">About this proposal</h2>
            {ownerId && (
              <ErrorBoundary what="owner's description">
                <OwnerPost govHash={p.govHash} ownerId={ownerId} post={post} trustLevel={trust.aggregate.level} />
              </ErrorBoundary>
            )}
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
