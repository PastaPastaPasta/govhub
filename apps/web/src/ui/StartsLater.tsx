// Proposals whose first eligible superblock is after the next one (lib/lameDuck.ts `startsLater`): not in the next budget because
// they are not due yet, not because the budget is full. A card shows an info tag in place of the "Not in the next budget" warning,
// and the proposal page says when the first payment is and that votes count then. Dates are estimates from the superblock schedule.
import { formatDate, formatMonth } from '../lib/format.ts';
import type { StartsLater } from '../lib/lameDuck.ts';

const STARTS_LATER_ESTIMATE = 'Estimated from the superblock schedule (2.62 minutes per block, as Core estimates it)';

/** "Starts paying ~Jan 2027". */
export function startsLaterLabel(s: StartsLater): string {
  return `Starts paying ~${formatMonth(s.firstTime)}`;
}

/** The proposal page's sentence. */
export function startsLaterDetail(s: StartsLater): string {
  return `Its first payment is the superblock around ${formatDate(s.firstTime)}. Votes count then; it isn't eligible for the ${formatDate(s.nextTime)} budget.`;
}

/** A card's budget tag for a proposal that is not due yet. */
export function StartsLaterTag({ later }: { later: StartsLater }) {
  return (
    <span className="tag tag-info" data-testid="card-starts-later" title={`${startsLaterDetail(later)} ${STARTS_LATER_ESTIMATE}.`}>
      {startsLaterLabel(later)}
    </span>
  );
}

/** The proposal page's status line for a proposal that is not due yet. */
export function StartsLaterPageStatus({ later }: { later: StartsLater }) {
  return (
    <div className="p-startslater" data-testid="startslater-status">
      <p>
        <span className="tag tag-info">{startsLaterLabel(later)}</span>
      </p>
      <p>{startsLaterDetail(later)}</p>
      <p className="small muted">{STARTS_LATER_ESTIMATE}; the day is approximate.</p>
    </div>
  );
}
