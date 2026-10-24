import { Link } from 'react-router-dom';
import { formatDash, formatInt, shortAddress } from '../lib/format.ts';
import type { PaymentSchedule } from '../lib/governance.ts';
import type { Row } from '../lib/view.ts';
import { PassingBar } from './PassingBar.tsx';
import { ProvMark } from './Provenance.tsx';

export function paymentText(amountDuffs: number, s: PaymentSchedule | null): string {
  const amount = formatDash(amountDuffs);
  if (!s) return `${amount} per payment`;
  if (s.oneTime) return `${amount} one-time${s.remaining === 0 ? ' (paid or expired)' : ''}`;
  if (s.total === 0) return `${amount}, no superblock in its window`;
  return `${amount} per month (${s.remaining === 0 ? 'ended' : `${s.remaining} of ${s.total} remaining`})`;
}

export function ProposalCard({ row, href }: { row: Row; href: string }) {
  const p = row.p.value;
  const t = row.tally?.value;
  return (
    <article className={`card card-${row.state?.light ?? 'none'}`} data-govhash={p.govHash}>
      <header className="card-head">
        <h3 className="card-title">
          <Link to={href}>{p.name}</Link>
        </h3>
        <p className="card-owner">
          Owner not claimed yet. Pays <span className="mono-ish">{shortAddress(p.paymentAddress)}</span>
        </p>
      </header>

      {row.state && row.absYes !== null && row.threshold ? (
        <PassingBar absYes={row.absYes} threshold={row.threshold.value} state={row.state} />
      ) : (
        <p className="muted small passbar-missing">{row.tally ? 'Waiting for the budget cycle to compute the threshold' : 'No tally published yet'}</p>
      )}

      <p className="card-pay">
        {paymentText(p.paymentAmount, row.schedule)} <ProvMark prov={row.p.prov} />
      </p>

      <footer className="card-foot">
        {t ? (
          <p className="card-votes" aria-label={`Yes ${t.yesWeighted}, no ${t.noWeighted}, abstain ${t.abstainWeighted} (weighted)`}>
            <span>
              <b>{formatInt(t.yesWeighted)}</b> yes
            </span>
            <span>
              <b>{formatInt(t.noWeighted)}</b> no
            </span>
            <span>
              <b>{formatInt(t.abstainWeighted)}</b> abstain
            </span>
            <ProvMark prov={row.tally!.prov} />
          </p>
        ) : (
          <p className="card-votes muted">No votes yet</p>
        )}
        <p className="card-meta">
          {t?.inNextBudget ? <span className="chip chip-funded">In next budget</span> : row.state?.passing ? <span className="chip chip-over" title="Passing, but the budget is full or the next superblock is outside its payment window">Not in next payout</span> : null}
          <span className="card-comments" title="Comments arrive in phase 2">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M2 2.5h10v7H6l-3 2.5v-2.5H2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
            <span className="visually-hidden">Comments: </span>&ndash;
          </span>
        </p>
      </footer>
    </article>
  );
}
