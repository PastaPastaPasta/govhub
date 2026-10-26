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
        ? `Your identity has ${formatCredits(balance)} available, and Platform needs about ${formatCredits(required)} available to take this (the fee itself can be lower, but Platform checks for more first). Top up the identity, then try again. Nothing was sent.`
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
      // a replace's bytes added are not known here: the fee is only a floor for it
      return replace ? postCost(0, 0) : postCost(stored);
    }
    default:
      return COSTS.reactionCreate;
  }
}

/**
 * Whether the up-front requirement of this kind of write has been measured: a comment (the refusal `UPFRONT_HEADROOM` is calibrated on)
 * and a reaction (the same two non-unique-plus-owner index shape and about the same fee). The others have fewer indexes, so the same
 * headroom would overstate what they need; for them only the settled fee is a certain floor, and Platform's own refusal (with its
 * numbers, in `TopUpError`) says the rest. Never refuse a write on a guess.
 */
export const hasMeasuredHeadroom = (op: Pick<DocumentOp, 'action' | 'type'>): boolean => op.action === 'create' && (op.type === 'comment' || op.type === 'reaction');

/** What must be available for a write whose settled fee is about `fee`: with `measured` the up-front requirement, otherwise the fee itself. */
const requiredFor = (fee: number, measured: boolean): bigint => BigInt(measured ? upfrontRequired(fee) : fee);

/** At least what must be available for this write (credits): the fee, plus the up-front headroom where that was measured; null for a delete. */
export function forumWriteRequired(op: DocumentOp): bigint | null {
  const fee = forumWriteFee(op);
  return fee === null ? null : requiredFor(fee, hasMeasuredHeadroom(op));
}

/** Throws a TopUpError when the known balance is below what Platform needs for `op` (unknown balance: the write is tried). */
export function assertCanAffordWrite(balance: bigint | null, op: DocumentOp): void {
  const need = forumWriteRequired(op);
  if (balance !== null && need !== null && balance < need) throw new TopUpError(balance, need, 'forum');
}

/** Whether the known balance is below what a write whose settled fee is about `fee` credits needs (`measured`: comment, reaction). */
export const isShort = (balance: bigint | null, fee: number, measured = false): boolean => balance !== null && balance < requiredFor(fee, measured);

/** "costs about 0.00043 DASH", plus "needs about 0.0023 DASH available" where the up-front requirement is higher (`measured`). */
export const costText = (fee: number, measured = false): string =>
  measured ? `costs about ${formatCredits(fee, true)}, needs about ${formatCredits(upfrontRequired(fee), true)} available` : `costs about ${formatCredits(fee, true)}`;
