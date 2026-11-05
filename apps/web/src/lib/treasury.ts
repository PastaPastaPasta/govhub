// What the treasury funds this cycle, as groups a reader can take in at once: in the next budget, passing but over it, short of
// votes, and starting later. Proposals carry no category on the network, so they are grouped by where they stand and ordered by
// size, never by a topic guessed from their names.
import type { Row } from './view.ts';

export type GroupId = 'funded' | 'over' | 'short' | 'later';

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
  /** Of that, what the proposals with enough votes ask (in the budget or over it). */
  passing: number;
}

const groupOf = (r: Row): GroupId => (r.startsLater ? 'later' : r.tally?.value.inNextBudget ? 'funded' : r.state?.passing ? 'over' : 'short');

/** `rows`: the active proposals still able to be paid (no lame ducks), in payout order. */
export function treasuryView(rows: readonly Row[]): TreasuryView {
  const groups = Object.fromEntries((['funded', 'over', 'short', 'later'] as const).map((id) => [id, { id, rows: [] as Row[], sum: 0 }])) as Record<GroupId, TreasuryGroup>;
  for (const r of rows) {
    if (r.lameDuck) continue;
    const g = groups[groupOf(r)];
    g.rows.push(r);
    g.sum += r.p.value.paymentAmount;
  }
  for (const g of Object.values(groups)) g.rows.sort((a, b) => b.p.value.paymentAmount - a.p.value.paymentAmount);
  const passing = groups.funded.sum + groups.over.sum;
  return { groups, requested: passing + groups.short.sum, passing };
}

/** `part` as a whole percentage of `whole` ("<1%" for a sliver, never "0%" for something there). */
export function share(part: number, whole: number): string {
  if (whole <= 0) return '–';
  const pct = (part / whole) * 100;
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}
