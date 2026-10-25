// One proposal in a list: who asks, how much, and whether it gets funded. Three zones side by side on wide screens, stacked on
// narrow ones. The trust mark is the last full result of the proposal page (ui/trust/store.ts), when it still applies.
import type { Profile } from '@govhub/forum';
import { Link } from 'react-router-dom';
import { useApp } from '../app/context.tsx';
import { formatDash, formatInt, shortAddress, shortHash } from '../lib/format.ts';
import { authorLabel, authorText } from '../lib/social.ts';
import { perPayment, type GovParams, type PaymentSchedule } from '../lib/governance.ts';
import type { Row } from '../lib/view.ts';
import type { CheckState } from '../verify/checks.ts';
import { FundingMeter } from './FundingMeter.tsx';
import { FailedNote } from './HiddenToggle.tsx';
import { Avatar } from './Identity.tsx';
import { trustScope, useCachedTrust } from './trust/store.ts';
import { TrustBadge } from './trust/TrustBadge.tsx';

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
  const { params, source } = useApp();
  const p = row.p.value;
  const t = row.tally?.value;
  const failed = check?.status === 'failed' ? check.reason : null;
  const trust = useCachedTrust(trustScope(source), p, t ?? null);
  const mark = !failed && trust && trust.level !== 'error' ? trust : null;
  // Proven data decides once the cached result is "verified" for this very tally; otherwise it is the tally's own flag.
  const inBudget = mark?.level === 'verified' && mark.funded !== null ? mark.funded : t?.inNextBudget;
  const ask = askText(p.paymentAmount, row.schedule, params);
  const left = paymentsLeft(row.schedule);
  return (
    <article className={`prow prow-${failed ? 'invalid' : (row.state?.light ?? 'none')}`} data-govhash={p.govHash} data-check={check?.status} data-testid="proposal-card">
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
              <bdi>{ownerProfile && authorLabel(urlOwner, ownerProfile).name ? authorText(urlOwner, ownerProfile) : shortHash(urlOwner, 5)}</bdi> <span className="muted small">named by the creator</span>
            </span>
          </p>
        ) : (
          <p className="prow-owner prow-owner-none">
            pays <span className="mono-ish" title={p.paymentAddress}>{shortAddress(p.paymentAddress)}</span>
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
        {row.state && row.absYes !== null && row.threshold ? (
          <FundingMeter absYes={row.absYes} threshold={row.threshold.value} state={row.state} size="s" />
        ) : (
          <p className="muted small">{row.tally ? 'Waiting for the budget cycle' : 'No votes yet'}</p>
        )}
        {inBudget ? (
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
        <Link to={href} className="prow-comments" title={comments === undefined ? 'Counting comments…' : `${comments} ${comments === 1 ? 'comment' : 'comments'} (hidden ones not counted)`} data-testid="card-comments">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2.5h10v7H6l-3 2.5v-2.5H2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
          <span className="visually-hidden">Comments: </span>
          {comments === undefined ? '–' : formatInt(comments)}
        </Link>
      </p>
    </article>
  );
}
