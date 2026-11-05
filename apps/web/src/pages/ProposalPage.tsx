// /p/h/<govHash> (canonical) and /p/<name> (slug; duplicate names get a chooser). The page leads with what a reader wants: the ask,
// whether it will be funded, the vote, the description and the discussion. Every check still runs (ui/trust/useProposalTrust.ts)
// and adds up to one badge; its detail is in the "How do we know?" drawer.
import { Slug } from '../ui/Slug.tsx';
import { useTitle } from '../app/title.ts';
import { useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { Link } from '../ui/Link.tsx';
import { urlClaimIdentity } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { Discussion } from '../ui/Discussion.tsx';
import { proposalOwner } from '../lib/social.ts';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { ReadError } from '../ui/ReadError.tsx';
import { FundingMeter } from '../ui/FundingMeter.tsx';
import { LameDuckPageStatus } from '../ui/LameDuck.tsx';
import { StartsLaterPageStatus } from '../ui/StartsLater.tsx';
import { ClaimPanel, OwnerPost, OwnerValue, RejectedClaims, useOwnership, useOwnerPost } from '../ui/Ownership.tsx';
import { TrustBadge } from '../ui/trust/TrustBadge.tsx';
import { useProposalTrust } from '../ui/trust/useProposalTrust.ts';
import type { Aggregate } from '../verify/aggregate.ts';
import { trustScope, useCachedTrust, type StoredTrust } from '../ui/trust/store.ts';
import { VerificationDrawer } from '../ui/trust/VerificationDrawer.tsx';
import { mnParam, ProposalVoteBlock } from '../ui/vote/VoteBlock.tsx';
import { useAsync } from '../ui/hooks.ts';
import type { Proposal, Sourced } from '../data/types.ts';
import { formatDash, formatDate, formatDateTime, formatDuration, formatInt, shortHash, urlHost } from '../lib/format.ts';
import { passState, perPayment, votingDeadlineTime } from '../lib/governance.ts';
import { deriveRow } from '../lib/view.ts';
import { isShortLink, useResolvedLink } from '../lib/links.ts';
import { isLowerBound } from '../verify/chain.ts';
import { paymentsFact, thresholdFact } from '../verify/facts.ts';

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
  useTitle(name);
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
      <h1 className="dh-page-header__title">{list.length} proposals are named {name}</h1>
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
  useTitle('Proposal not found');
  return (
    <section className="page-narrow">
      <h1 className="dh-page-header__title">Not found</h1>
      <p>
        Platform has no record of {what}. It may not be published yet. <Link to="/">Back to active proposals</Link>
      </p>
    </section>
  );
}

/** The host, plus the path when it is short enough to read (a shortened link is all path). */
function linkText(url: string, host: string): string {
  try {
    const u = new URL(url);
    const rest = (u.pathname === '/' ? '' : u.pathname) + u.search;
    return rest && rest.length <= 40 ? host + rest : host;
  } catch {
    return host;
  }
}

/** Why the checks didn't finish, what still holds, and Try again. Nothing while they run: the badge above shows their progress. */
function EvidenceLine({ agg, onRetry }: { agg: Aggregate; onRetry(): void }) {
  if (agg.level !== 'error') return null;
  return (
    <p className="evidence-line small" data-testid="evidence-unverified">
      {agg.reason ? `${agg.reason.replace(/\.$/, '')}. ` : ''}The amount, votes and budget place above are shown as reported.{' '}
      <button type="button" className="linkish dh-btn dh-btn--link" onClick={onRetry} data-testid="evidence-retry">
        Try again
      </button>
    </p>
  );
}

/**
 * The header's one status: the badge, with the checks' progress while they run ("Checking 3 of 5"). A result this browser proved
 * earlier for the very tally shown stays up while the checks run again, so a return visit doesn't flicker back to "Checking".
 */
function TrustStatus({ agg, cached, onOpen }: { agg: Aggregate; cached: StoredTrust | null; onOpen(): void }) {
  const checking = agg.level === 'checking';
  const done = agg.components.filter((c) => c.state.status !== 'pending').length;
  if (checking && cached?.level === 'verified') {
    const ago = `${formatDuration(Math.max(60, Math.floor((Date.now() - cached.at) / 1000)))} ago`;
    return (
      <span className="trust-status" data-testid="trust-status">
        <TrustBadge level="verified" reason={`Proved in this browser ${ago}; checking again now`} onOpen={onOpen} />
        <span className="small muted" aria-live="polite">
          proved {ago}, checking again
        </span>
      </span>
    );
  }
  return (
    <span className="trust-status" data-testid="trust-status">
      <TrustBadge level={agg.level} reason={agg.reason} onOpen={onOpen} {...(checking ? { label: `Checking ${done} of ${agg.components.length}` } : {})} />
      {checking && (
        <span className="small muted" aria-live="polite" data-testid="evidence-progress">
          in this browser; a first visit takes 10 to 40 seconds
        </span>
      )}
    </span>
  );
}

export function ProposalView({ sp }: { sp: Sourced<Proposal> }) {
  const { source, gov, params, checks } = useApp();
  const p = sp.value;
  const mn = mnParam(useLocation().search);
  useTitle(p.name);
  const now = source.now();
  const [talliesAttempt, setTalliesAttempt] = useState(0);
  const tallies = useAsync(() => source.tallies([p.govHash]), [source, p.govHash, talliesAttempt]);
  const cycle = gov.cycle.data ?? null;
  // The Platform tally document whenever there is one: the recount is checked against that proven record, not the bridge's own.
  const row = useMemo(() => deriveRow(sp, tallies.data ?? new Map(), gov.bridgeTallies, cycle, params, now, 'platform'), [sp, tallies.data, gov.bridgeTallies, cycle, params, now]);
  const trust = useProposalTrust(p, row, tallies.loading);
  const cachedTrust = useCachedTrust(trustScope(source), p, row.tally?.value ?? null);
  const [drawer, setDrawer] = useState(false);
  const check = checks.state(p);

  const own = useOwnership(p, trust.collateral.verdict);
  const ownerId = own.verdict?.owner?.identityId ?? null;
  const post = useOwnerPost(p.govHash, ownerId);
  const featured = useMemo(() => proposalOwner(ownerId), [ownerId]);

  const t = row.tally?.value;
  const active = p.endEpoch > now;
  // Only link a URL that is the hash-committed one (the synchronous check passed).
  const host = row.content.ok ? urlHost(p.url) : null;
  const short = !!host && isShortLink(host);
  const resolved = useResolvedLink(p.url, short);
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
      <p className="crumbs dh-crumbs">
        {mn ? (
          <Link to={`/masternodes/${mn}`} data-testid="crumb-mn">
            ‹ Masternode {shortHash(mn, 6)}’s votes
          </Link>
        ) : (
          <Link to={active ? '/' : '/past'}>‹ {active ? 'Active proposals' : 'Past proposals'}</Link>
        )}
      </p>
      {check.status === 'failed' && (
        <p className="invalid-banner dh-notice dh-notice--error" role="alert" data-testid="invalid-banner">
          <b>This proposal failed verification:</b> {check.reason}.{' '}
          {row.content.ok ? 'It is hidden from the proposal lists.' : 'It is hidden from the proposal lists and its link is disabled.'}{' '}
          <button type="button" className="linkish dh-btn dh-btn--link" onClick={() => setDrawer(true)}>
            See what failed
          </button>
        </p>
      )}

      <header className="p-hero dh-page-header">
        <p className="dh-page-header__kicker">Proposal</p>
        <div className="p-title dh-page-header__text">
          <h1 className="dh-page-header__title"><Slug name={p.name} /></h1>

        </div>
        <div className="p-owner">
          <OwnerValue p={p} own={own} />
          <RejectedClaims own={own} />
        </div>
        <div className="dh-page-header__meta">
          <TrustStatus agg={trust.aggregate} cached={cachedTrust} onOpen={() => setDrawer(true)} />
        </div>
      </header>

      <div className="p-layout">
        <div className="p-main">
          <section className="panel dh-card p-ask" aria-label="Funding">
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
                {inBudget ? <span className="tag dh-badge tag-pass dh-badge--good">In the next budget</span> : state?.passing ? <span className="tag dh-badge tag-warn dh-badge--warn">Passing, but the next budget is full</span> : null}
                {(inBudget || state?.passing) && trust.funded === null && trust.aggregate.level !== 'checking' && (
                  <span className="small muted" data-testid="budget-reported" title="The budget place is the published tally's; it counts as verified once this browser has recounted the votes and the funding order">
                    as reported, not verified here
                  </span>
                )}
                {/* the vote block below says when voting closes */}
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

            <EvidenceLine agg={trust.aggregate} onRetry={trust.recheck} />
            {tallies.error && <ReadError error={tallies.error} what="Platform" lead="The tally could not be read" onRetry={() => setTalliesAttempt((n) => n + 1)} />}
          </section>

          {active && !lameDuck && (
            <ErrorBoundary what="masternode voting">
              <ProposalVoteBlock proposal={p} mn={mn} closesIn={later ? null : untilDeadline} onVerify={() => setDrawer(true)} />
            </ErrorBoundary>
          )}

          <section className="p-about" aria-labelledby="about-title">
            <h2 id="about-title">About this proposal</h2>
            <div className="p-claims">
              <section className="p-claim" aria-labelledby="owner-says" data-testid="about-owner">
                <h3 id="owner-says">What the owner says</h3>
                {ownerId && (
                  <ErrorBoundary what="owner's description">
                    <OwnerPost govHash={p.govHash} ownerId={ownerId} post={post} trustLevel={trust.aggregate.level} />
                  </ErrorBoundary>
                )}
                {!(post.state?.post && post.state.body !== null) && (
                  <p className="small" data-testid="about-link">
                    {host ? (
                      <>
                        The owner hasn't posted a description here; it is on their own page:{' '}
                        <a href={p.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="ext">
                          {linkText(p.url, host)}
                          <span className="visually-hidden"> (opens another site)</span>
                        </a>
                        .
                      </>
                    ) : (
                      "The owner hasn't posted a description here."
                    )}{' '}
                    <span className="muted">Nobody has checked what the linked page says. The owner can post a description here by claiming the proposal.</span>
                  </p>
                )}
                {short && (
                  <p className="small p-short" data-testid="about-short">
                    {resolved ? (
                      <>
                        <b>{host} is a link shortener.</b> When this site was built ({formatDate(resolved.at)}) it led to{' '}
                        <a href={resolved.to} target="_blank" rel="noopener noreferrer nofollow ugc" className="ext break" data-testid="about-short-to">
                          {resolved.to}
                          <span className="visually-hidden"> (opens another site)</span>
                        </a>
                        . Whoever made the short link can point it elsewhere, so check where it leads when you open it.
                      </>
                    ) : (
                      <>
                        <b>{host} is a link shortener</b>, so where it leads shows only once you open it.
                      </>
                    )}
                  </p>
                )}
              </section>
              <section className="p-claim p-recorded" aria-labelledby="network-records" data-testid="about-recorded">
                <h3 id="network-records">What the network records</h3>
                {row.content.ok ? (
                  <>
                  <dl className="kv small">
                    <div>
                      <dt>Name</dt>
                      <dd className="break">{p.name}</dd>
                    </div>
                    <div>
                      <dt>Requests</dt>
                      <dd>
                        {formatDash(p.paymentAmount)} {sched?.oneTime ? 'once' : perPayment(params)}
                      </dd>
                    </div>
                    <div>
                      <dt>Payment window</dt>
                      <dd>
                        {formatDate(p.startEpoch)} to {formatDate(p.endEpoch)}
                      </dd>
                    </div>
                    <div>
                      <dt>Pays</dt>
                      <dd>
                        <dashhq-hash value={p.paymentAddress} full="" label="payment address">
                          {p.paymentAddress}
                        </dashhq-hash>
                      </dd>
                    </div>
                    <div>
                      <dt>Link</dt>
                      <dd className="break">{p.url}</dd>
                    </div>
                  </dl>
                  <p className="small muted">That is all a Dash proposal holds. Each field above matches the hash the network votes on.</p>
                  </>
                ) : (
                  <p className="small" data-testid="about-recorded-mismatch">
                    The fields published for this proposal don't match the hash the network votes on ({row.content.problem}), so none of them is shown here as
                    the network's record.
                  </p>
                )}
              </section>
            </div>
          </section>

          <ErrorBoundary what="discussion">
            <Discussion govHash={p.govHash} featured={featured} />
          </ErrorBoundary>
        </div>

        <aside className="p-side" aria-label="Summary">
          <section className="panel dh-card">
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
                    {resolved && <span className="small muted"> leading to {urlHost(resolved.to)}</span>}
                  </dd>
                </div>
              )}
              <div>
                <dt>Submitted</dt>
                <dd>{formatDateTime(p.time)}</dd>
              </div>
            </dl>
            <button type="button" className="linkish dh-btn dh-btn--link small" onClick={() => setDrawer(true)}>
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
