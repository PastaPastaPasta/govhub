// /p/h/<govHash> (canonical) and /p/<name> (slug; duplicate names get a chooser). The page leads with what a voter needs to know
// before voting: what it funds (the owner's summary, the ask, the payee, the timeline) and where it stands, then the vote, the
// network's record and the discussion. Every check still runs (ui/trust/useProposalTrust.ts) and adds up to one badge; its detail
// is in the "How do we know?" drawer.
import { useNow } from '../ui/vote/common.tsx';
import { formatUtc } from '../data/price.ts';
import { Slug } from '../ui/Slug.tsx';
import { useTitle } from '../app/title.ts';
import { useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { Link } from '../ui/Link.tsx';
import { urlClaimIdentity } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { RecordNotFound, useOtherNetwork, useProbe } from '../app/otherNetwork.tsx';
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
import { mnParam, ProposalVoteBlock, type VoteSubject } from '../ui/vote/VoteBlock.tsx';
import { useOwnerPage } from '../lib/ownerPages.ts';
import { purposeOf, useReadableTitle } from '../ui/OwnerPage.tsx';
import { askText, paymentsLine } from '../ui/ProposalCard.tsx';
import { useAsync } from '../ui/hooks.ts';
import type { Proposal, Sourced } from '../data/types.ts';
import type { Found } from '../lib/ownerPages.ts';
import { capitalize, formatAgoMs, formatDash, formatDate, formatDateTime, formatDuration, formatInt, shortHash, urlHost } from '../lib/format.ts';
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
  if (!load.data) return <NotFound by={{ hash: hash.toLowerCase() }} />;
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
  if (list.length === 0) return <NotFound by={{ name }} />;
  if (list.length === 1) return <ProposalView sp={list[0]!} />;
  return (
    <section className="page-narrow">
      <h1 className="dh-page-header__title">{list.length} proposals are named {name}</h1>
      <p className="muted">Names aren't unique in Dash governance. Pick one:</p>
      <ul className="chooser">
        {list.map((s) => (
          <li key={s.value.govHash}>
            <Link to={`/p/h/${s.value.govHash}`} className="dh-link">
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

/** No such proposal on this network: before saying so, the other network is asked (a link shared from there, opened here). */
function NotFound({ by }: { by: { name: string } | { hash: string } }) {
  const other = useOtherNetwork();
  const key = 'name' in by ? `name:${by.name}` : `hash:${by.hash}`;
  const probe = useProbe(other, async (o) => ('name' in by ? (await o.source.byName(by.name)).length > 0 : !!(/^[0-9a-f]{64}$/.test(by.hash) && (await o.source.proposal(by.hash)))), key);
  const { registry } = useApp();
  const here = registry.coreNetwork === 'testnet' ? 'Testnet' : 'Mainnet';
  return (
    <RecordNotFound
      kicker="Proposal"
      name={'name' in by ? <Slug name={by.name} /> : <span className="mono-ish">{shortHash(by.hash, 10)}</span>}
      title={'name' in by ? `${by.name}: not on ${here}` : `Proposal not on ${here}`}
      thing="proposal"
      record={'name' in by ? by.name : by.hash}
      idLabel={'name' in by ? 'name' : 'hash'}
      probe={probe}
      other={other}
      absent="A proposal shows here a few minutes after it is submitted, once the governance data service has published it."
      list={{ path: '/', label: `Browse ${here} proposals` }}
    />
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
 * The first thing on the page: what the proposal is for, in the owner's words from their page (read when the site was built,
 * quoted and attributed), else where the owner says it.
 */
function Purpose({ page, hasPost, url, host }: { page: Found; hasPost: boolean; url: string; host: string | null }) {
  const now = useNow(30_000, !!page);
  const below = hasPost ? (
    <p className="small" data-testid="p-purpose-post">
      The owner has posted a description here: <a href="#about-title" className="dh-link">read it below</a>.
    </p>
  ) : null;
  if (page) {
    const text = purposeOf(page.page);
    return (
      <div className="p-purpose" data-testid="p-purpose">
        {text && (
          <blockquote className="owner-page-quote p-purpose-quote" cite={page.page.url}>
            <p>
              <bdi>{text}</bdi>
            </p>
          </blockquote>
        )}
        <p className="small muted p-purpose-from" data-testid="owner-page">
          {text ? 'The owner’s own words' : 'The title is the owner’s'}, from their page on {page.page.host} (read <time className="dh-time" dateTime={new Date(page.fetchedAt).toISOString()} title={formatUtc(page.fetchedAt)}>{formatAgoMs(page.fetchedAt, now / 1000)}</time>). Nobody has checked
          them.{' '}
          <a href={page.page.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="ext dh-link" data-testid="owner-page-link">
            Read it all on {page.page.host}
            <span className="visually-hidden"> (opens another site)</span>
          </a>
        </p>
        {below}
      </div>
    );
  }
  if (below) return below;
  return (
    <p className="small p-purpose" data-testid="about-link">
      {host ? (
        <>
          The owner hasn’t said here what it funds; it is on their own page:{' '}
          <a href={url} target="_blank" rel="noopener noreferrer nofollow ugc" className="ext dh-link">
            {linkText(url, host)}
            <span className="visually-hidden"> (opens another site)</span>
          </a>
          . <span className="muted">Nobody has checked what that page says.</span>
        </>
      ) : (
        'The owner hasn’t said what it funds, and the proposal links to no page that would.'
      )}
    </p>
  );
}

/** What the header's badge vouches for: the proposal's record, collateral, votes and budget place, not who owns it. */

function TrustStatus({ agg, cached, onOpen }: { agg: Aggregate; cached: StoredTrust | null; onOpen(): void }) {
  const verified = agg.level === 'verified' || (agg.level === 'checking' && cached?.level === 'verified');
  if (!verified) return <button type="button" className="dh-btn dh-btn--link" onClick={onOpen}>Verification details</button>;
  return <span className="trust-status" data-testid="trust-status"><TrustBadge level="verified" label="Chain verified" reason="Checked in this browser. A first visit takes 10 to 40 seconds; open for the checks and their sources." onOpen={onOpen} /></span>;
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
  // what the owner's page said when the site was built: only for the hash-committed link
  const ownerPage = useOwnerPage(p);
  const page = row.content.ok && check.status !== 'failed' ? (ownerPage ?? null) : null;
  // the heading waits for owners.json (preloaded with the app) rather than changing from the name to the owner's title under the reader
  const titleReady = ownerPage !== undefined || !row.content.ok;
  const ownerTitle = page?.page.title ?? null;
  const hasPost = !!(post.state?.post && post.state.body !== null);
  const words = useReadableTitle(p.name);
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
  const recurring = !!sched && !sched.oneTime && sched.total > 0;
  const paymentsText = paymentsLine(sched, paid && payments ? { made: paid.made.text, count: payments.paid.length, left: payments.remainingEstimate } : null);
  // the vote block names what it is voting on, in the words the lists use (the owner's title quoted as theirs)
  const voteSubject: VoteSubject = {
    title: ownerTitle ? `“${ownerTitle}”` : words,
    ask: row.content.ok ? Object.values(askText(p.paymentAmount, sched, params)).join(' ') : null,
    payments: row.content.ok && recurring ? paymentsText : null,
    standing: state ? { text: state.passing ? `Passing by ${formatInt(state.margin)}` : `Needs ${formatInt(state.needed)} more`, tone: state.light } : null,
  };

  return (
    <article className="proposal">
      <p className="crumbs dh-crumbs">
        {mn ? (
          <Link to={`/masternodes/${mn}`} data-testid="crumb-mn" className="dh-link">
            ‹ Masternode {shortHash(mn, 6)}’s votes
          </Link>
        ) : (
          <Link to={active ? '/' : '/past'} className="dh-link">‹ {active ? 'Active proposals' : 'Past proposals'}</Link>
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
        <h1 className="dh-page-header__title" data-testid="p-title" aria-busy={titleReady ? undefined : true}>
          {!titleReady ? (
            <>
              <span className="dh-skel dh-skel--title" aria-hidden="true" />
              <span className="visually-hidden">{p.name}</span>
            </>
          ) : ownerTitle ? (
            <bdi>{ownerTitle}</bdi>
          ) : (
            words
          )}
        </h1>
        <p className="p-chain-name small" data-testid="p-chain-name">
          <span className="mono-ish">
            <Slug name={p.name} />
          </span>{' '}
          <span className="muted">{ownerTitle ? `is its name on the network; the title is the owner’s, from ${page!.page.host}.` : 'is its name on the network.'}</span>
        </p>
        <div className="dh-page-header__meta p-meta">
          {active && !lameDuck && (
            <a href="#vote" className="dh-btn dh-btn--secondary dh-btn--sm p-jump" data-testid="jump-vote">
              Go to the vote ↓
            </a>
          )}
        </div>
      </header>
      {(trust.aggregate.level === 'failed' || trust.aggregate.level === 'error') && <p className="dh-notice dh-notice--warn" role="status">{trust.aggregate.reason ?? 'Verification could not finish. Figures are shown as reported.'} <button type="button" className="dh-btn dh-btn--link" onClick={() => setDrawer(true)}>Review checks</button></p>}

      <div className="p-layout">
        <div className="p-main">
          <section className="panel dh-card p-funds" aria-labelledby="funds-title" data-testid="p-funds">
            <h2 id="funds-title" className="panel-title">
              What this funds
            </h2>
            {row.content.ok ? (
              <>
                <Purpose page={page} hasPost={hasPost} url={p.url} host={host} />
                <p className="p-amount" data-testid="p-ask">
                  <span className="num">{formatDash(p.paymentAmount)}</span> <span className="p-per">{sched?.oneTime ? 'one payment' : perPayment(params)}</span>
                  {recurring && (
                    <span className="p-total">
                      {' '}
                      × {formatInt(sched.total)} payments = <b>{formatDash(p.paymentAmount * sched.total)}</b>
                    </span>
                  )}
                </p>
              </>
            ) : (
              <p className="small" data-testid="p-funds-mismatch">
                The fields published for this proposal don’t match the hash the network votes on ({row.content.problem}), so its amount, payee and dates aren’t shown
                as what it funds.
              </p>
            )}
            <dl className="kv p-facts small" data-testid="p-facts">
              {row.content.ok && (paid || recurring) && (
                <div>
                  <dt>Payments</dt>
                  <dd data-testid="p-paid">{capitalize(paymentsText ?? '')}</dd>
                </div>
              )}
              {row.content.ok && (
                <div>
                  <dt>Runs</dt>
                  <dd>
                    {formatDate(p.startEpoch)} to {formatDate(p.endEpoch)}
                    {active && !lameDuck && !later && cycle && <span className="muted">; the next payout is around {formatDate(cycle.value.estTime)}</span>}
                  </dd>
                </div>
              )}
              {row.content.ok && (
                <div>
                  <dt>Pays</dt>
                  <dd>
                    <dashhq-hash value={p.paymentAddress} label="payment address" href={`https://${source.coreNetwork === 'testnet' ? 'insight.testnet.networks.dash.org' : 'insight.dash.org'}/insight/address/${encodeURIComponent(p.paymentAddress)}`}>
                      {p.paymentAddress}
                    </dashhq-hash>
                  </dd>
                </div>
              )}
              <div>
                <dt>Owner</dt>
                <dd className="p-owner">
                  <OwnerValue own={own} />
                  <RejectedClaims own={own} />
                </dd>
              </div>
            </dl>

            <section className="p-standing" aria-labelledby="standing-title">
              <h3 id="standing-title" className="p-standing-title">
                Where it stands
              </h3>
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
          </section>

          {active && !lameDuck && (
            <ErrorBoundary what="masternode voting">
              <ProposalVoteBlock proposal={p} subject={voteSubject} mn={mn} closesIn={later ? null : untilDeadline} onVerify={() => setDrawer(true)} />
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
                {!hasPost && (
                  <p className="small muted" data-testid="about-owner-none">
                    {page ? `Their summary, quoted from ${page.page.host}, is at the top of this page.` : 'The owner hasn’t posted a description here.'} The owner can post one here by
                    claiming the proposal.
                  </p>
                )}
                {short && (
                  <p className="small p-short" data-testid="about-short">
                    {resolved ? (
                      <>
                        <b>{host} is a link shortener.</b> When this site was built ({formatDate(resolved.at)}) it led to{' '}
                        <a href={resolved.to} target="_blank" rel="noopener noreferrer nofollow ugc" className="ext break dh-link" data-testid="about-short-to">
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
            <TrustStatus agg={trust.aggregate} cached={cachedTrust} onOpen={() => setDrawer(true)} />
            <dl className="kv" data-testid="summary">
              {host && (
                <div>
                  <dt>Website</dt>
                  <dd>
                    <a href={p.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="ext dh-link">
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
