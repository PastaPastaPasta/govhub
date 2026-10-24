// Scores are counted client-side from the proven reactions on a target (PV13 has no counts; PV14 ranked counts
// replace this in v2). The unique [$ownerId, target] index already allows one reaction per identity; the counter
// still keeps only one per owner, ignores reactions of the wrong kind, and can leave out excluded identities
// (blocked authors, whose reactions are hidden like their comments).
import type { Reaction } from './types.ts';

export interface Score {
  up: number;
  down: number;
  /** up - down */
  net: number;
  /** the viewer's own reaction, when they have one */
  mine?: Reaction;
}

export function score(reactions: readonly Reaction[], opts: { kind: number; target: string; viewer?: string | null; exclude?: (ownerId: string) => boolean }): Score {
  const latest = new Map<string, Reaction>();
  for (const r of reactions) {
    if (r.kind !== opts.kind || r.target !== opts.target) continue;
    const prev = latest.get(r.ownerId);
    if (!prev || r.updatedAt > prev.updatedAt || (r.updatedAt === prev.updatedAt && r.revision > prev.revision)) latest.set(r.ownerId, r);
  }
  let up = 0;
  let down = 0;
  for (const r of latest.values()) {
    if (opts.exclude?.(r.ownerId) && r.ownerId !== opts.viewer) continue;
    if (r.value === 1) up++;
    else down++;
  }
  const mine = opts.viewer ? latest.get(opts.viewer) : undefined;
  return { up, down, net: up - down, ...(mine ? { mine } : {}) };
}
