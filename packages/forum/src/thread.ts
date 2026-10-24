// Client-side threading by parentId (there is deliberately no parentId index). A reply attaches to its parent only
// when the parent is on the same proposal AND strictly earlier in (createdAt, id) order. That order is total, so no
// set of comments can form a cycle, even though a PV13 author can precompute the id of a future comment
// (sha256d of contract, owner, type and their own entropy) and point an earlier reply at it.
// Hostile input: one identity can post a reply chain thousands deep. Nesting is capped at MAX_THREAD_DEPTH (deeper
// replies attach to their ancestor at the cap) and nothing here recurses, so a chain cannot overflow the stack.
import type { Comment } from './types.ts';

export const MAX_THREAD_DEPTH = 32;

export interface ThreadNode {
  comment: Comment;
  children: ThreadNode[];
  /** 0 for roots */
  depth: number;
  /** a reply whose parent is missing (retracted, hidden from the read, or invalid): shown as a root */
  orphan: boolean;
}

const before = (a: Comment, b: Comment): boolean => a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
const byTime = (a: ThreadNode, b: ThreadNode): number => (before(a.comment, b.comment) ? -1 : before(b.comment, a.comment) ? 1 : 0);

export function buildThreads(comments: readonly Comment[]): ThreadNode[] {
  const byId = new Map<string, ThreadNode>();
  for (const c of comments) if (!byId.has(c.id)) byId.set(c.id, { comment: c, children: [], depth: 0, orphan: false });
  const parentOf = new Map<ThreadNode, ThreadNode>();
  // Oldest first, so every parent's depth is final before its replies are placed.
  const ordered = [...byId.values()].sort(byTime);
  const roots: ThreadNode[] = [];
  for (const node of ordered) {
    const pid = node.comment.parentId;
    let parent = pid ? byId.get(pid) : undefined;
    if (!parent || parent.comment.govHash !== node.comment.govHash || !before(parent.comment, node.comment)) {
      node.orphan = pid !== undefined;
      roots.push(node);
      continue;
    }
    while (parent.depth + 1 > MAX_THREAD_DEPTH) parent = parentOf.get(parent)!;
    node.depth = parent.depth + 1;
    parent.children.push(node);
    parentOf.set(node, parent);
  }
  // Children were appended in time order already; roots too.
  return roots;
}

/** Depth-first order (what a reader sees top to bottom), iteratively. */
export function flatten(roots: readonly ThreadNode[]): ThreadNode[] {
  const out: ThreadNode[] = [];
  const stack = [...roots].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out;
}

/** The ancestor ids of `id`, root first, for expanding a deep link. */
export function ancestors(roots: readonly ThreadNode[], id: string): string[] {
  const all = flatten(roots);
  if (!all.some((n) => n.comment.id === id)) return [];
  const parent = new Map<string, string>();
  for (const n of all) for (const c of n.children) parent.set(c.comment.id, n.comment.id);
  const path: string[] = [];
  for (let p = parent.get(id); p !== undefined; p = parent.get(p)) path.push(p);
  return path.reverse();
}

/**
 * For every node: is it, or anything below it, shown? Computed bottom-up in one pass, so a placeholder for a hidden
 * parent of a visible reply costs O(n) overall, not O(n²).
 */
export function visibleSubtrees(roots: readonly ThreadNode[], shown: (c: Comment) => boolean): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const order = flatten(roots);
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i]!;
    out.set(n.comment.id, shown(n.comment) || n.children.some((c) => out.get(c.comment.id) === true));
  }
  return out;
}
