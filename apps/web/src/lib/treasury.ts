// What the treasury funds this cycle, as groups a reader can take in at once: in the next budget, passing but over it, short of
// votes, votes not read, and starting later. Proposals carry no category on the network, so they are grouped by where they stand and ordered by
// size, never by a topic guessed from their names.
import type { Row } from './view.ts';

export type GroupId = 'funded' | 'over' | 'short' | 'unread' | 'later';

export interface TreasuryGroup {
  id: GroupId;
  /** largest request first; equal requests keep the list's payout order */
  rows: Row[];
  /** what they ask of one superblock, in duffs */
  sum: number;
}

export interface TreasuryView {
  groups: Record<GroupId, TreasuryGroup>;
  /** What the proposals due at the next superblock ask of it (duffs): the in-budget, over-budget and short groups. */
  requested: number;
  /** Of that, what the proposals with enough votes ask (in the budget or over it); a lower bound while any votes weren't read. */
  passing: number;
}

const groupOf = (r: Row, untallied: ReadonlySet<string>): GroupId =>
  r.startsLater ? 'later' : untallied.has(r.p.value.govHash) ? 'unread' : r.tally?.value.inNextBudget ? 'funded' : r.state?.passing ? 'over' : 'short';

/**
 * `rows`: the active proposals still able to be paid (no lame ducks), in payout order; `untallied`: those whose votes a failed read
 * left unknown (lib/view.ts untalliedOf), grouped apart instead of as short of votes.
 */
export function treasuryView(rows: readonly Row[], untallied: ReadonlySet<string> = new Set()): TreasuryView {
  const groups = Object.fromEntries((['funded', 'over', 'short', 'unread', 'later'] as const).map((id) => [id, { id, rows: [] as Row[], sum: 0 }])) as Record<GroupId, TreasuryGroup>;
  for (const r of rows) {
    if (r.lameDuck) continue;
    const g = groups[groupOf(r, untallied)];
    g.rows.push(r);
    g.sum += r.p.value.paymentAmount;
  }
  for (const g of Object.values(groups)) g.rows.sort((a, b) => b.p.value.paymentAmount - a.p.value.paymentAmount);
  const passing = groups.funded.sum + groups.over.sum;
  return { groups, requested: passing + groups.short.sum + groups.unread.sum, passing };
}

/** `part` as a whole percentage of `whole`: "<1%" for a sliver, ">99%" and ">100%" either side of all, never "0%" or "100%" when it isn't. */
export function share(part: number, whole: number): string {
  if (whole <= 0) return '–';
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 1) return '<1%';
  if (pct > 99 && pct < 100) return '>99%';
  if (pct > 100 && pct < 101) return '>100%';
  return `${Math.round(pct)}%`;
}
