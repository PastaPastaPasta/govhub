// Client-side threading by parentId (there is deliberately no parentId index). A reply attaches to its parent only
// when the parent is on the same proposal AND strictly earlier in (createdAt, id) order. That order is total, so no
// set of comments can form a cycle, even though a PV13 author can precompute the id of a future comment
// (sha256d of contract, owner, type and their own entropy) and point an earlier reply at it.
import type { Comment } from './types.ts';

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
  const roots: ThreadNode[] = [];
  for (const node of byId.values()) {
    const pid = node.comment.parentId;
    const parent = pid ? byId.get(pid) : undefined;
    if (parent && parent.comment.govHash === node.comment.govHash && before(parent.comment, node.comment)) parent.children.push(node);
    else {
      node.orphan = pid !== undefined;
      roots.push(node);
    }
  }
  const settle = (nodes: ThreadNode[], depth: number) => {
    nodes.sort(byTime);
    for (const n of nodes) {
      n.depth = depth;
      settle(n.children, depth + 1);
    }
  };
  settle(roots, 0);
  return roots;
}

/** Depth-first order (what a reader sees top to bottom). */
export function flatten(roots: readonly ThreadNode[]): ThreadNode[] {
  const out: ThreadNode[] = [];
  const walk = (ns: readonly ThreadNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/** The ancestor ids of `id`, root first, for expanding a deep link. */
export function ancestors(roots: readonly ThreadNode[], id: string): string[] {
  const path: string[] = [];
  const find = (ns: readonly ThreadNode[]): boolean => {
    for (const n of ns) {
      if (n.comment.id === id) return true;
      path.push(n.comment.id);
      if (find(n.children)) return true;
      path.pop();
    }
    return false;
  };
  return find(roots) ? path : [];
}
