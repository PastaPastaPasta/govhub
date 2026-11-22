// One proposal in a list: who asks, how much, and whether it gets funded. Three zones side by side on wide screens, stacked on
// narrow ones. The trust mark is the last full result of the proposal page (ui/trust/store.ts), when it still applies.
import { Slug } from './Slug.tsx';
import type { Profile } from '@govhub/forum';
import { Link } from './Link.tsx';
import { useApp } from '../app/context.tsx';
import { formatDash, formatInt, shortHash } from '../lib/format.ts';
import { onlyUnreached, unfinishedReason } from '../lib/netError.ts';
import { authorLabel, authorText } from '../lib/social.ts';
import { perPayment, type GovParams, type PaymentSchedule } from '../lib/governance.ts';
import type { Row } from '../lib/view.ts';
import type { TrustLevel } from '../verify/aggregate.ts';
import type { CheckState } from '../verify/checks.ts';
import { CommentsLink } from './CommentsLink.tsx';
import { FundingMeter } from './FundingMeter.tsx';
import { FailedNote } from './HiddenToggle.tsx';
import { Avatar } from './Identity.tsx';
import { LameDuckCardStatus } from './LameDuck.tsx';
import { StartsLaterTag } from './StartsLater.tsx';
import { trustScope, useCachedTrust } from './trust/store.ts';
import { useOwnerPage } from '../lib/ownerPages.ts';
import { PurposeLine, useReadableTitle } from './OwnerPage.tsx';
import { TrustBadge } from './trust/TrustBadge.tsx';

type Mark = { level: TrustLevel; reason: string | null };

/**
 * The card's trust mark: the proposal page's last full result, else the list's background check. A check that only failed to reach the
 * network says nothing about the proposal and is usually the same trouble for every row, so the list says that once (UncheckedNote)
 * instead. Anything else that kept it from "verified" (a mismatch, an absent or unconfirmed collateral) stays on the card as
 * "Couldn't verify", never like a pass.
 */
export function cardMark(trust: Mark | null, check: CheckState | undefined): Mark | null {
  const background: Mark | null = check?.status === 'inconclusive' ? { level: 'error', reason: `The collateral couldn't be checked: ${unfinishedReason(check.reason)}` } : null;
  return [trust, background].find((m): m is Mark => !!m && !(m.level === 'error' && onlyUnreached(m.reason))) ?? null;
}

/** "1 of 4 payments left", "one-time payment", "no payments left". */
export function paymentsLeft(s: PaymentSchedule | null): string | null {
  if (!s) return null;
  if (s.oneTime) return 'one-time payment';
  if (s.total === 0) return 'no payout in its window';
  return s.remaining === 0 ? 'no payments left' : `${formatInt(s.remaining)} of ${formatInt(s.total)} payments left`;
}

/**
 * The payments line on a proposal page, phrased as the lists phrase it ("1 of 4 payments left"), with the payments the verified chain
 * shows made ("· 3 paid") once it has been read. The chain's own count of what is still possible then decides "left"; when paid and
 * left together exceed the schedule's total, no total is claimed ("1 more possible · 1 paid").
 */
export function paymentsLine(s: PaymentSchedule | null, proven: { made: string; count: number; left: number } | null): string | null {
  if (!proven) return paymentsLeft(s);
  const fits = !!s && !s.oneTime && proven.count + proven.left <= s.total;
  // nothing paid yet and every payment still ahead: the lists' phrase says it all
  if (fits && proven.count === 0 && proven.left === s!.total) return paymentsLeft(s);
  const left = proven.left === 0 ? 'no payments left' : fits ? `${formatInt(proven.left)} of ${formatInt(s!.total)} payments left` : `${formatInt(proven.left)} more possible`;
  return `${left} · ${proven.made} paid`;
}

export function askText(amountDuffs: number, s: PaymentSchedule | null, params: GovParams): { amount: string; per: string } {
  return { amount: formatDash(amountDuffs), per: s?.oneTime ? 'once' : perPayment(params) };
}

export function ProposalCard({
  row, href, comments, urlOwner, ownerProfile, ownerDpns, check,
}: { row: Row; href: string; comments?: number | undefined; urlOwner?: string | null; ownerProfile?: Profile | undefined; ownerDpns?: string | undefined; check?: CheckState }) {
  const { params, source, gov } = useApp();
  const p = row.p.value;
  const t = row.tally?.value;
  const failed = check?.status === 'failed' ? check.reason : null;
  const trust = useCachedTrust(trustScope(source), p, t ?? null);
  const mark = failed ? null : cardMark(trust, check);
  // Under a "Verified" mark only proven data decides "in the next budget" (none: no tag); otherwise it is the tally's own flag.
  const verified = trust && mark?.level === 'verified' ? trust : null;
  const inBudget = verified ? (verified.funded ?? undefined) : t?.inNextBudget;
  // Not due until a later superblock, by the schedule; only a proven "funded" overrides that estimate.
  const later = verified && inBudget ? null : row.startsLater;
  const ask = askText(p.paymentAmount, row.schedule, params);
  // Nothing left that can pay it: no funding bars or budget tag, and no "payments left" claim either.
  const ended = row.lameDuck && !inBudget;
  const left = ended ? null : paymentsLeft(row.schedule);
  const tone = failed ? 'invalid' : ended ? 'ended' : (row.state?.light ?? 'none');
  // the owner's page, only for a proposal whose fields match its hash (its link is the committed one)
  const owner = useOwnerPage(p);
  const page = row.content.ok && !failed ? (owner?.page ?? null) : null;
  const words = useReadableTitle(p.name);
  // no tally: a read that failed or hasn't answered isn't "no votes"
  const noTally = gov?.talliesLoading ? 'Reading the votes…' : gov?.untallied?.has(p.govHash) ? 'Votes not read' : 'No votes yet';
  return (
    <article className={`prow prow-${tone}`} data-govhash={p.govHash} data-check={check?.status} data-lameduck={ended ? 'true' : undefined} data-testid="proposal-card">
      <div className="prow-main">
        <h3 className="prow-title">
          <Link to={href} className="dh-link">{page?.title ? <bdi>“{page.title}”</bdi> : words}</Link>
          {mark && <TrustBadge size="s" level={mark.level} reason={mark.reason} testId="card-trust" />}
        </h3>
        <p className="prow-slug small" data-testid="card-slug">
          <Slug name={p.name} />
        </p>
        {page && <PurposeLine page={page} />}
        {failed ? (
          <FailedNote reason={failed} />
        ) : !row.content.ok ? (
          <p className="tag dh-badge tag-fail dh-badge--bad" title={row.content.problem}>
            Published fields don't match the hashed data
          </p>
        ) : urlOwner ? (
          <p className="prow-owner">
            <Avatar id={urlOwner} profile={ownerProfile} size={18} />
            <span title={`Identity ${urlOwner}, named in the proposal URL by its creator; the proposal page shows whether it accepted`}>
              <a href={window.dashhq?.href('explorer', '/identity?id=' + encodeURIComponent(urlOwner))} className="dh-link"><bdi data-testid="card-owner-name">{ownerText(urlOwner, ownerProfile, ownerDpns)}</bdi></a> <span className="muted small">named by the creator</span>
            </span>
          </p>
        ) : null}
      </div>

      <div className="prow-ask">
        <p>
          <span className="num">{ask.amount}</span> <span className="prow-per">{ask.per}</span>
        </p>
        {left && <p className="small muted">{left}</p>}
      </div>

      <div className="prow-fund">
        {ended ? (
          <LameDuckCardStatus endEpoch={p.endEpoch} />
        ) : row.state && row.absYes !== null && row.threshold ? (
          <FundingMeter absYes={row.absYes} threshold={row.threshold.value} state={row.state} size="s" />
        ) : (
          <p className="muted small">{row.tally ? 'Waiting for the budget cycle' : noTally}</p>
        )}
        {ended ? null : later ? (
          <StartsLaterTag later={later} />
        ) : inBudget ? (
          <span className="tag dh-badge tag-pass dh-badge--good">In the next budget</span>
        ) : row.state?.passing ? (
          <span className="tag dh-badge tag-warn dh-badge--warn" title="Passing, but the budget is full or the next payout is outside its window">
            Not in the next budget
          </span>
        ) : null}
      </div>

      <p className="prow-meta small">
        {t ? (
          <span className="prow-votes" aria-label={`Weighted votes: ${t.yesWeighted} yes, ${t.noWeighted} no, ${t.abstainWeighted} abstain`}>
            <span>
              <b>{formatInt(t.yesWeighted)}</b> yes
            </span>
            <span>
              <b>{formatInt(t.noWeighted)}</b> no
            </span>
            <span>
              <b>{formatInt(t.abstainWeighted)}</b> abstain
            </span>
          </span>
        ) : (
          <span className="muted">{noTally}</span>
        )}
        {comments !== 0 && <CommentsLink to={href} count={comments} />}
      </p>
    </article>
  );
}

/** The URL owner on a card: DPNS name, else the self-chosen name with the short id, else the short id. */
function ownerText(id: string, profile?: Profile, dpns?: string): string {
  const a = authorLabel(id, profile, dpns);
  return a.dpns || a.name ? authorText(id, profile, dpns) : shortHash(id, 5);
}
