// One proposal in a list: who asks, how much, and whether it gets funded. Three zones side by side on wide screens, stacked on
// narrow ones. The trust mark is the last full result of the proposal page (ui/trust/store.ts), when it still applies.
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

/** "1 of 4 payments left", "one payment", "ended". */
export function paymentsLeft(s: PaymentSchedule | null): string | null {
  if (!s) return null;
  if (s.oneTime) return 'one-time payment';
  if (s.total === 0) return 'no payout in its window';
  return s.remaining === 0 ? 'final payment made' : `${formatInt(s.remaining)} of ${formatInt(s.total)} payments left`;
}

export function askText(amountDuffs: number, s: PaymentSchedule | null, params: GovParams): { amount: string; per: string } {
  return { amount: formatDash(amountDuffs), per: s?.oneTime ? 'once' : perPayment(params) };
}

export function ProposalCard({
  row, href, comments, urlOwner, ownerProfile, check,
}: { row: Row; href: string; comments?: number | undefined; urlOwner?: string | null; ownerProfile?: Profile | undefined; check?: CheckState }) {
  const { params, source, registry } = useApp();
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
  return (
    <article className={`prow prow-${tone}`} data-govhash={p.govHash} data-check={check?.status} data-lameduck={ended ? 'true' : undefined} data-testid="proposal-card">
      <div className="prow-main">
        {/* h2: the list's heading is the page's h1 (a skipped level breaks heading navigation) */}
        <h2 className="prow-title">
          <Link to={href}>{p.name}</Link>
          {mark && <TrustBadge size="s" level={mark.level} reason={mark.reason} testId="card-trust" />}
        </h2>
        {failed ? (
          <FailedNote reason={failed} />
        ) : !row.content.ok ? (
          <p className="tag tag-fail" title={row.content.problem}>
            Published fields don't match the hashed data
          </p>
        ) : urlOwner ? (
          <p className="prow-owner">
            <Avatar id={urlOwner} profile={ownerProfile} size={18} />
            <span title={`Identity ${urlOwner}, named in the proposal URL by its creator; the proposal page shows whether it accepted`}>
              <a href={window.dashhq?.href('explorer', '/identity?id=' + encodeURIComponent(urlOwner))}><bdi>{ownerProfile && authorLabel(urlOwner, ownerProfile).name ? authorText(urlOwner, ownerProfile) : shortHash(urlOwner, 5)}</bdi></a> <span className="muted small">named by the creator</span>
            </span>
          </p>
        ) : (
          <p className="prow-owner prow-owner-none">
            pays <dashhq-hash value={p.paymentAddress} label="Payee address" href={`https://${registry.coreNetwork === 'testnet' ? 'insight.testnet.networks.dash.org' : 'insight.dash.org'}/insight/address/${encodeURIComponent(p.paymentAddress)}`}>{p.paymentAddress}</dashhq-hash> ↗
          </p>
        )}
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
          <p className="muted small">{row.tally ? 'Waiting for the budget cycle' : 'No votes yet'}</p>
        )}
        {ended ? null : later ? (
          <StartsLaterTag later={later} />
        ) : inBudget ? (
          <span className="tag tag-pass">In the next budget</span>
        ) : row.state?.passing ? (
          <span className="tag tag-warn" title="Passing, but the budget is full or the next payout is outside its window">
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
          <span className="muted">No votes yet</span>
        )}
        <CommentsLink to={href} count={comments} />
      </p>
    </article>
  );
}
