// Fixture mode: sign in as a sample identity whose writes go into the in-memory fixture store. The balance starts
// at 0.003 DASH (what a new account pays in) and is charged the same fee estimates the UI shows.
import { commentCost, COSTS, postCost, type DocumentOp, type MemoryStore } from '@govhub/forum';
import type { Session } from './session.ts';

const INITIAL_CREDITS = 300_000_000n; // 0.003 DASH

function estimate(op: DocumentOp): number {
  if (op.action === 'delete') return op.type === 'reaction' ? COSTS.reactionDelete : op.type === 'block' ? COSTS.blockDelete : -20_000_000;
  const bytes = (k: string) => {
    const v = op.data[k];
    return v instanceof Uint8Array ? v.length : typeof v === 'string' ? new TextEncoder().encode(v).length : 0;
  };
  switch (op.type) {
    case 'comment':
      return commentCost(bytes('body'));
    case 'reaction':
      return op.action === 'replace' ? COSTS.reactionFlip : COSTS.reactionCreate;
    case 'claim':
      return COSTS.claim;
    case 'profile':
      return op.action === 'replace' ? COSTS.profileReplace : COSTS.profileCreate;
    case 'block':
      return COSTS.blockCreate;
    case 'blockSubs':
      return op.action === 'replace' ? COSTS.blockSubsReplace : COSTS.blockSubsCreate;
    case 'proposalPost':
      return postCost(bytes('b0') + bytes('b1') + bytes('b2'), op.action === 'replace' ? 0 : undefined);
    default:
      return 50_000_000;
  }
}

export function fixtureSession(store: MemoryStore, identityId: string, label: string): Session {
  let balance = INITIAL_CREDITS;
  let open = true;
  return {
    identityId,
    label,
    async balance() {
      return balance;
    },
    async signAndBroadcastDocument(op) {
      if (!open) throw new Error('signed out');
      const cost = BigInt(estimate(op));
      if (cost > balance) throw new Error('not enough credits: top up the identity first');
      await new Promise((r) => setTimeout(r, 150));
      const result = store.apply(identityId, op);
      balance -= cost;
      return result;
    },
    close() {
      open = false;
    },
  };
}
