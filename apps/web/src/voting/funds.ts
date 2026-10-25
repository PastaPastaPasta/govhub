// Credits for keyring writes (D-024): checked before a write, and Platform's "insufficient balance" answer put in plain words with a
// top-up hint instead of the raw SDK error.
import { commentCost, COSTS, postCost, upfrontRequired, type DocumentOp } from '@govhub/forum';
import { errText, formatCredits } from '../lib/format.ts';

/**
 * About what Platform requires to be on the identity for one keyring document write (create or replace), by bucket. Measured on
 * testnet: replacing a bucket-1 KEYS document required 300,631,920 credits; bucket 2 has three times the ciphertext.
 */
export const KEYRING_WRITE_CREDITS: Readonly<Record<1 | 2, bigint>> = { 1: 300_000_000n, 2: 900_000_000n };

export class TopUpError extends Error {
  constructor(
    readonly balance: bigint,
    readonly required: bigint,
    /** what was being written: the keyring (default) or a forum document (comment, reaction, claim, profile, ...) */
    readonly kind: 'keyring' | 'forum' = 'keyring',
  ) {
    super(
      kind === 'forum'
        ? `Your identity has ${formatCredits(balance)} available, and Platform needs about ${formatCredits(required)} available to take this (the fee itself is lower, but Platform checks for more first). Top up the identity, then try again. Nothing was posted.`
        : `Your identity has ${formatCredits(balance)}, and saving the keyring on Platform needs about ${formatCredits(required)}. Top up the identity (menu, Top up), then try again. Nothing was saved.`,
    );
    this.name = 'TopUpError';
  }
}

/** Throws a TopUpError when the known balance cannot pay for a keyring write of `bucket` (unknown balance: the write is tried). */
export function assertCanWrite(balance: bigint | null, bucket: 1 | 2): void {
  const need = KEYRING_WRITE_CREDITS[bucket];
  if (balance !== null && balance < need) throw new TopUpError(balance, need);
}

/** Platform's refusal for a too-small balance, as a TopUpError; anything else unchanged. */
export function topUpFromError(e: unknown, kind: 'keyring' | 'forum' = 'keyring'): unknown {
  const m = /insufficient identity \S+ balance (\d+) required (\d+)/i.exec(errText(e));
  return m ? new TopUpError(BigInt(m[1]!), BigInt(m[2]!), kind) : e;
}

/**
 * About the settled fee of a forum write, in credits (`@govhub/forum` COSTS), or null when there is nothing to hold back: deletes
 * refund most of their storage, and the pre-check still wants a little, but it is never what stops a delete.
 */
export function forumWriteFee(op: DocumentOp): number | null {
  if (op.action === 'delete') return null;
  const replace = op.action === 'replace';
  switch (op.type) {
    case 'comment':
      return commentCost(new TextEncoder().encode(String(op.data.body ?? '')).length);
    case 'reaction':
      return replace ? COSTS.reactionFlip : COSTS.reactionCreate;
    case 'claim':
      return COSTS.claim;
    case 'profile':
      return replace ? COSTS.profileReplace : COSTS.profileCreate;
    case 'block':
      return COSTS.blockCreate;
    case 'blockSubs':
      return replace ? COSTS.blockSubsReplace : COSTS.blockSubsCreate;
    case 'proposalPost': {
      const stored = ['b0', 'b1', 'b2'].reduce((n, k) => n + (op.data[k] instanceof Uint8Array ? (op.data[k] as Uint8Array).length : 0), 0);
      // A replace's bytes added are not known here (the editor, which knows the old size, checks that itself): never refuse on a guess.
      return replace ? postCost(0, 0) : postCost(stored);
    }
    default:
      return COSTS.reactionCreate;
  }
}

/** What Platform wants available for this write (credits, the fee plus its up-front headroom), or null for a delete. */
export function forumWriteRequired(op: DocumentOp): bigint | null {
  const fee = forumWriteFee(op);
  return fee === null ? null : BigInt(upfrontRequired(fee));
}

/** Throws a TopUpError when the known balance is below what Platform wants for `op` (unknown balance: the write is tried). */
export function assertCanAffordWrite(balance: bigint | null, op: DocumentOp): void {
  const need = forumWriteRequired(op);
  if (balance !== null && need !== null && balance < need) throw new TopUpError(balance, need, 'forum');
}

/** Whether the known balance is below what Platform wants available for a write whose settled fee is about `fee` credits. */
export const isShort = (balance: bigint | null, fee: number): boolean => balance !== null && balance < BigInt(upfrontRequired(fee));

/** "costs about 0.00043 DASH" plus, since Platform asks for more, "needs about 0.0023 DASH available". */
export function costText(fee: number): string {
  return `costs about ${formatCredits(fee, true)}, needs about ${formatCredits(upfrontRequired(fee), true)} available`;
}
