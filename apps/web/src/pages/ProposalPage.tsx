// /p/h/<govHash> (canonical) and /p/<name> (slug; duplicate names get a chooser). The page leads with what a voter needs to know
// before voting: the ask, the standing and vote entry, followed by the details, the owner's words, the
// network's record and the discussion. Every check still runs (ui/trust/useProposalTrust.ts) and adds up to one badge; its detail
// is in the "How do we know?" drawer.
import { useNow } from '../ui/vote/common.tsx';
import { formatUtc } from '../data/price.ts';
import { Slug } from '../ui/Slug.tsx';
import { useTitle } from '../app/title.ts';
import { useEffect, useMemo, useState } from 'react';
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
import { LEVEL_LABEL, type Aggregate } from '../verify/aggregate.ts';
import { VerificationDrawer } from '../ui/trust/VerificationDrawer.tsx';
import { mnParam, ProposalVoteBlock, type VoteSubject } from '../ui/vote/VoteBlock.tsx';
import { useOwnerPage } from '../lib/ownerPages.ts';
import { purposeOf, useReadableTitle } from '../ui/OwnerPage.tsx';
import { askText, paymentsLine } from '../ui/ProposalCard.tsx';
import { useAsync } from '../ui/hooks.ts';
import type { Proposal, Sourced } from '../data/types.ts';
import type { Found } from '../lib/ownerPages.ts';
import { capitalize, dashUnit, formatAgoMs, formatDash, formatDashAmount, formatDate, formatDateTime, formatDuration, formatInt, shortHash, urlHost } from '../lib/format.ts';
import { passState, perPayment, votingDeadlineTime } from '../lib/governance.ts';
import { deriveRow } from '../lib/view.ts';
import { isShortLink, useResolvedLink } from '../lib/links.ts';
import { isLowerBound } from '../verify/chain.ts';
import { paymentsFact, thresholdFact } from '../verify/facts.ts';

export function ProposalByHash() {
  const { hash = '' } = useParams();
  const { source } = useApp();
  const [attempt, setAttempt] = useState(0); // Retry re-runs the read in place: no reload, so memory-only keys stay
  const h = /^[0-9a-fA-F]{64}$/.test(hash) ? hash.toLowerCase() : null;
  const load = useAsync(() => (h ? source.proposal(h) : Promise.resolve(null)), [source, h, attempt]);
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
 * What the proposal is for, in the owner's words from their page (read when the site was built,
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
          {text ? 'The owner’s own words' : 'The title is the owner’s'}, from their page on {page.page.host} (read <time className="dh-time" dateTime={new Date(page.fetchedAt * 1000).toISOString()} title={formatUtc(page.fetchedAt * 1000)}>{formatAgoMs(page.fetchedAt * 1000, now / 1000)}</time>). Nobody has checked
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

function TrustStatus({ agg, onOpen }: { agg: Aggregate; onOpen(): void }) {
  if (agg.level === 'verified') return <span className="trust-status" data-testid="trust-status"><TrustBadge level="verified" label="Chain verified" reason="Checked in this browser. A first visit takes 10 to 40 seconds; open for the checks and their sources." onOpen={onOpen} /></span>;
  const described = `Verification details: ${LEVEL_LABEL[agg.level]}${agg.reason ? ` — ${agg.reason}` : ''}`;
  return (
    <button type="button" className="dh-btn dh-btn--link" onClick={onOpen} data-testid="trust-badge" data-trust={agg.level} aria-label={described} title={agg.reason ?? undefined} aria-haspopup="dialog">
      Verification details
    </button>
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
  const retryTallies = () => setTalliesAttempt((n) => n + 1);
  const cycle = gov.cycle.data ?? null;
  // The Platform tally document whenever there is one: the recount is checked against that proven record, not the bridge's own.
  const row = useMemo(() => deriveRow(sp, tallies.data ?? new Map(), gov.bridgeTallies, cycle, params, now, 'platform'), [sp, tallies.data, gov.bridgeTallies, cycle, params, now]);
  const trust = useProposalTrust(p, row, tallies.loading);
  const [drawer, setDrawer] = useState(false);
  const check = checks.state(p);

  const own = useOwnership(p, trust.collateral.verdict);
  const ownerId = own.verdict?.owner?.identityId ?? null;
  const post = useOwnerPost(p.govHash, ownerId);
  const featured = useMemo(() => proposalOwner(ownerId), [ownerId]);
  // Known to be unclaimed (owner read and collateral check done, as the latter can reveal a method-3 owner; not a failed read): the
  // claim is how anyone gets to write the description, so it sits where the description goes rather than in the sidebar. The place is
  // decided once per proposal and shown only then, since a form moved mid-edit (a recheck, a late owner) would reset.
  const settled = !own.loading && (!!trust.collateral.verdict || !!trust.collateral.error);
  const unclaimed = settled && !own.error && !ownerId;
  const [claimPlace, setClaimPlace] = useState<{ govHash: string; about: boolean } | null>(null);
  useEffect(() => {
    if (settled && claimPlace?.govHash !== p.govHash) setClaimPlace({ govHash: p.govHash, about: unclaimed });
  }, [settled, unclaimed, claimPlace, p.govHash]);
  const claimAbout = claimPlace?.govHash === p.govHash ? claimPlace.about : null;
  const claim = <ClaimPanel p={p} own={own} collateral={trust.collateral.verdict} />;

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

  let decisionTime = `${active ? 'Payment window ends' : 'Ended'} ${formatDate(p.endEpoch)}`;
  if (later) decisionTime = `Starts at a later payout; runs ${formatDate(p.startEpoch)} to ${formatDate(p.endEpoch)}`;
  else if (active && !lameDuck && untilDeadline !== null) {
    decisionTime = untilDeadline > 0 ? `Votes close around ${formatDate(now + untilDeadline)}` : 'Voting for this payout has closed';
    if (cycle) decisionTime += `; next payout around ${formatDate(cycle.value.estTime)}`;
  }

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
        <p className="p-sub">
          <Slug name={p.name} />
          {ownerTitle && <span className="muted"> · title from the owner’s page on {page!.page.host}</span>}
        </p>
        {row.content.ok && <Purpose page={page} hasPost={hasPost} url={p.url} host={host} />}
      </header>
      {trust.aggregate.level === 'failed' && <p className="dh-notice dh-notice--warn" role="status">{trust.aggregate.reason ?? 'Verification could not finish. Figures are shown as reported.'} <button type="button" className="dh-btn dh-btn--link" onClick={() => setDrawer(true)}>Review checks</button></p>}

      <section className="panel p-funds" aria-labelledby="funds-title" data-testid="p-funds">
        <h2 id="funds-title" className="visually-hidden">
          Amount and standing
        </h2>
        <div className="p-lead">
          <div className="p-lead-ask">
            {row.content.ok ? (
              <p className="p-amount" data-testid="p-ask">
                <span className="num">{formatDashAmount(p.paymentAmount)}</span> <small>{dashUnit()}</small> <span className="p-per">{sched?.oneTime ? 'one payment' : perPayment(params)}</span>
                {recurring && (
                  <span className="p-total">
                    {' '}
                    × {formatInt(sched.total)} payments = <b>{formatDash(p.paymentAmount * sched.total)}</b>
                  </span>
                )}
              </p>
            ) : <p className="small" data-testid="p-funds-mismatch">The fields published for this proposal don’t match the hash the network votes on ({row.content.problem}), so its amount, payee and dates aren’t shown as what it funds.</p>}
            {row.content.ok && paymentsText && <p className="p-left" data-testid="p-paid">{capitalize(paymentsText)}</p>}
          </div>
          <div className="p-lead-standing">
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
            {!active && !lameDuck && <p className="p-ended">Voting ended {formatDate(p.endEpoch)}</p>}
            {active && !lameDuck && !later && untilDeadline !== null && untilDeadline > 0 && <p className="p-closes">Voting closes in {formatDuration(untilDeadline)}</p>}
            {!lameDuck && threshold && row.absYes !== null && (
              <p className="p-net">
                <b>{formatInt(row.absYes)}</b> net yes of <b>{formatInt(threshold.value)}</b> needed <span className="muted">({chain ? `masternode list at block ${formatInt(chain.threshold.height)}` : 'feed estimate'})</span>
              </p>
            )}
            {trust.aggregate.level !== 'verified' && trust.aggregate.level !== 'failed' && trust.aggregate.level !== 'error' && (
              <p className="p-reported" data-testid="p-reported">
                {trust.aggregate.level === 'checking' ? 'As reported, until this browser finishes checking it against the chain.' : 'As reported; not fully checked against the chain here.'}
              </p>
            )}
          </div>
        </div>
        <section className="p-standing" aria-labelledby="standing-title">
          <h3 id="standing-title" className="visually-hidden">Where it stands</h3>
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
          {tallies.error && (t ? (
            <p className="p-tally-note small muted" data-testid="tally-fallback">
              The Platform tally record couldn’t be read, so these are the governance feed’s counts.{' '}
              <button type="button" className="linkish dh-btn dh-btn--link" onClick={retryTallies} title={tallies.error}>
                Try again
              </button>
            </p>
          ) : <ReadError error={tallies.error} what="Platform" lead="The tally could not be read" onRetry={retryTallies} />)}
        </section>
        <div className="dh-page-header__meta p-meta">
          {active && !lameDuck && (
            <a href="#vote" className="dh-btn dh-btn--secondary dh-btn--sm p-jump" data-testid="jump-vote">
              Go to the vote ↓
            </a>
          )}
        </div>
      </section>

      <div className="p-layout">
        <div className="p-main">
          {active && !lameDuck && (
            <ErrorBoundary what="masternode voting">
              <ProposalVoteBlock proposal={p} subject={voteSubject} mn={mn} closesIn={later || (untilDeadline !== null && untilDeadline > 0) ? null : untilDeadline} onVerify={() => setDrawer(true)} />
            </ErrorBoundary>
          )}

          <section className="p-about" aria-labelledby="about-title">
            <h2 id="about-title">About this proposal</h2>
            <div className="p-claims">
              {(hasPost || ownerId || !page || short) && <section className="p-claim" aria-labelledby="owner-says" data-testid="about-owner">
                <h3 id="owner-says">What the owner says</h3>
                {ownerId && (
                  <ErrorBoundary what="owner's description">
                    <OwnerPost govHash={p.govHash} ownerId={ownerId} post={post} trustLevel={trust.aggregate.level} />
                  </ErrorBoundary>
                )}
                {!hasPost && !page && (
                  <p className="small muted" data-testid="about-owner-none">
                    The owner hasn’t posted a description here. The owner can post one here by claiming the proposal.
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
              </section>}
              <details className="p-claim p-recorded" data-testid="about-recorded" open={!row.content.ok}>
                <summary><h3 id="network-records">What the network records</h3></summary>
                {row.content.ok ? (
                  <>
                  <dl className="kv small">
                    <div>
                      <dt>Name</dt>
                      <dd className="break" data-testid="p-chain-name">{p.name}</dd>
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
              </details>
            </div>
            {claimAbout === true && claim}
          </section>

          <ErrorBoundary what="discussion">
            <Discussion
              govHash={p.govHash}
              featured={featured}
              composerNote={unclaimed ? "This posts a comment in the discussion. Only the proposal's owner can write the description above." : undefined}
            />
          </ErrorBoundary>
        </div>

        <aside className="p-side" aria-label="Summary">
          <section className="panel dh-card p-details" aria-labelledby="details-title" data-testid="p-details">
            <h2 id="details-title" className="panel-title">Summary</h2>
            <TrustStatus agg={trust.aggregate} onOpen={() => setDrawer(true)} />
            <dl className="kv p-facts small" data-testid="p-facts">
              {row.content.ok && <div data-testid="p-decision"><dt>Timing</dt><dd>{decisionTime}</dd></div>}
              {row.content.ok && (
                <div>
                  <dt>Runs</dt>
                  <dd>
                    {formatDate(p.startEpoch)} to {formatDate(p.endEpoch)}
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
          {claimAbout === false && claim}
        </aside>
      </div>

      <VerificationDrawer sp={sp} trust={trust} cycle={cycle?.value ?? null} open={drawer} onClose={() => setDrawer(false)} />
    </article>
  );
}
