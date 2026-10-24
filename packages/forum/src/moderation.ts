// Moderation (PLAN §9): block lists hide, never delete. A list is the set of `block` documents one identity owns:
// the default list is `mod.block` by the moderation identity, subscribed lists and the user's own list are
// `forum.block`. Blocks target identities (kind 1: everything the identity wrote) or single documents (kind 2).
import { BLOCK_KIND, type Block, type Comment } from './types.ts';

export type ListSource = 'default' | 'subscription' | 'mine';

export interface BlockList {
  source: ListSource;
  /** identity that owns the list */
  ownerId: string;
  /** display name ("govhub moderation", "my blocks", a profile name) */
  name: string;
  blocks: Block[];
}

export interface HideReason {
  list: string;
  source: ListSource;
  kind: 'identity' | 'document';
  reason?: string;
  block: Block;
}

export interface HideIndex {
  /** Why a comment (or any document by an author) is hidden; empty when it is not. */
  reasons(doc: { id: string; ownerId: string }): HideReason[];
  identityHidden(ownerId: string): boolean;
  /** The block on the user's own list for this target, to offer "unblock". */
  mine(target: string): Block | undefined;
  readonly size: number;
}

export function buildHideIndex(lists: readonly BlockList[]): HideIndex {
  const ids = new Map<string, HideReason[]>();
  const docs = new Map<string, HideReason[]>();
  const mine = new Map<string, Block>();
  let size = 0;
  for (const l of lists) {
    for (const b of l.blocks) {
      if (b.ownerId !== l.ownerId) continue; // a list is only what its owner wrote
      const kind = b.kind === BLOCK_KIND.identity ? 'identity' : b.kind === BLOCK_KIND.document ? 'document' : null;
      if (!kind) continue; // unknown kinds are reserved for later contract conventions
      const map = kind === 'identity' ? ids : docs;
      map.set(b.target, [...(map.get(b.target) ?? []), { list: l.name, source: l.source, kind, block: b, ...(b.reason ? { reason: b.reason } : {}) }]);
      if (l.source === 'mine') mine.set(b.target, b);
      size++;
    }
  }
  return {
    reasons: (d) => [...(docs.get(d.id) ?? []), ...(ids.get(d.ownerId) ?? [])],
    identityHidden: (o) => ids.has(o),
    mine: (t) => mine.get(t),
    size,
  };
}

export const EMPTY_HIDE_INDEX: HideIndex = buildHideIndex([]);

/**
 * The comment views (PLAN §9). "recommended" = MN-badge holders plus the proposal owner on their own proposal;
 * "all" = everyone. Badges arrive in phase 4: until the first badge epoch is live the reader starts on "all"
 * (PLAN §12 fallback), and choosing "recommended" shows only the owner. `badged` is where badge holders slot in.
 */
export type CommentFilter = 'recommended' | 'all';

export interface FilterContext {
  /** the proposal's verified owner, if any */
  owner: string | null;
  /** whether an author holds a current MN badge from a trusted issuer (always false before phase 4) */
  badged: (ownerId: string) => boolean;
}

export function passesFilter(c: Pick<Comment, 'ownerId'>, filter: CommentFilter, ctx: FilterContext): boolean {
  return filter === 'all' || c.ownerId === ctx.owner || ctx.badged(c.ownerId);
}

/** The view a reader starts with: "recommended" once badges are live, everyone until then. */
export const defaultFilter = (badgesLive: boolean): CommentFilter => (badgesLive ? 'recommended' : 'all');
