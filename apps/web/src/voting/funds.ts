// Credits for keyring writes (D-024): checked before a write, and Platform's "insufficient balance" answer put in plain words with a
// top-up hint instead of the raw SDK error.
import { formatCredits } from '../lib/format.ts';

/**
 * About what Platform requires to be on the identity for one keyring document write (create or replace), by bucket. Measured on
 * testnet: replacing a bucket-1 KEYS document required 300,631,920 credits; bucket 2 has three times the ciphertext.
 */
export const KEYRING_WRITE_CREDITS: Readonly<Record<1 | 2, bigint>> = { 1: 300_000_000n, 2: 900_000_000n };

export class TopUpError extends Error {
  constructor(
    readonly balance: bigint,
    readonly required: bigint,
  ) {
    super(
      `Your identity has ${formatCredits(balance)}, and saving the keyring on Platform needs about ${formatCredits(required)}. Top up the identity (menu, Top up), then try again. Nothing was saved.`,
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
export function topUpFromError(e: unknown): unknown {
  const m = /insufficient identity \S+ balance (\d+) required (\d+)/i.exec(e instanceof Error ? e.message : String(e));
  return m ? new TopUpError(BigInt(m[1]!), BigInt(m[2]!)) : e;
}
