// Lame-duck proposals (lib/lameDuck.ts): still on the network, nothing left that can pay them. The list keeps them in a collapsed
// section after the live ones, a card shows a neutral state instead of the funding bars, and the proposal page replaces the
// passing / budget / voting-deadline block with the outcome.
import { useId, type ReactNode } from 'react';
import { formatDate } from '../lib/format.ts';

export const LAME_DUCK_TITLE = 'Finished, still on the network';
export const LAME_DUCK_EXPLAINER = 'No superblock left can pay these, whether or not they were paid (estimated from the superblock schedule). They drop off the network when they end.';

/** The collapsed list section; its cards are only rendered once it is opened. */
export function LameDuckSection({ count, open, onToggle, children }: { count: number; open: boolean; onToggle(): void; children: ReactNode }) {
  const bodyId = useId();
  if (count === 0) return null;
  return (
    <section className="lameduck" aria-labelledby={`${bodyId}-title`} data-testid="lameduck-section">
      <h2 className="lameduck-title" id={`${bodyId}-title`}>
        <button type="button" className="lameduck-toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle} data-testid="toggle-lameduck">
          <span className="lameduck-caret" aria-hidden="true" />
          {LAME_DUCK_TITLE} ({count})
        </button>
      </h2>
      <p className="small muted">{LAME_DUCK_EXPLAINER}</p>
      <div id={bodyId} hidden={!open}>
        {open && <div className="plist">{children}</div>}
      </div>
    </section>
  );
}

/** A card's funding zone for a lame duck: no bars, no budget tag. */
export function LameDuckCardStatus({ endEpoch }: { endEpoch: number }) {
  return (
    <>
      <span className="tag tag-done" data-testid="card-lameduck" title="Estimated from the superblock schedule (2.62 minutes per block, as Core estimates it)">
        No more payments possible
      </span>
      <p className="small muted">Ends {formatDate(endEpoch)}</p>
    </>
  );
}

/** Payments proven from the chain (a lower bound when `atLeast`), or null while they are not known. */
export interface PaidCount {
  count: number;
  atLeast: boolean;
  /** False when the count is not fully proven (another listed proposal could not be ruled out, or the chain's proof of work is weak). */
  firm: boolean;
}

const paymentWord = (n: number) => (n === 1 ? 'payment' : 'payments');

/** What the page says: a short headline and the sentence behind it. `total` is the estimated number of payments in its window. */
export function lameDuckSummary({ total, paid, endEpoch }: { total: number; paid: PaidCount | null; endEpoch: number }): { headline: string; detail: string } {
  const headline = 'No more payments possible';
  const leaves = `No more payments are possible; it leaves the network on ${formatDate(endEpoch)}.`;
  if (!paid) return { headline, detail: `${leaves} Every superblock that could pay it has passed, or comes after its end date.` };
  // a lower bound that already reaches the total is still "in full"
  if (paid.count >= Math.max(1, total)) {
    const of = Math.max(total, paid.count);
    if (!paid.firm) return { headline, detail: `${paid.count} of ${of} ${paymentWord(of)} found, not fully proven (see the checks). ${leaves}` };
    return { headline: 'Paid in full', detail: `${paid.count} of ${of} ${paymentWord(of)} made. ${leaves}` };
  }
  if (paid.count === 0) return { headline, detail: `No payment ${paid.atLeast ? 'found yet in the superblocks read' : 'was made'}. ${leaves}` };
  return { headline, detail: `${paid.atLeast ? 'At least ' : ''}${paid.count} of ${total} ${paymentWord(total)} made. ${leaves}` };
}

/** The proposal page's replacement for the passing / budget / voting-deadline block. */
export function LameDuckPageStatus({ total, paid, endEpoch, counting }: { total: number; paid: PaidCount | null; endEpoch: number; counting: boolean }) {
  const { headline, detail } = lameDuckSummary({ total, paid, endEpoch });
  return (
    <div className="p-lameduck" data-testid="lameduck-status">
      <p>
        <span className="tag tag-done">{headline}</span>
      </p>
      <p>
        {detail}
        {counting && !paid && ' Counting the payments made…'}
      </p>
      <p className="small muted">
        Whether a later superblock could still pay it is an estimate, from Core's schedule of 2.62 minutes per block. Payments made are counted from the
        superblocks' coinbases once the chain check has run.
      </p>
    </div>
  );
}
