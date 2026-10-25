// F2: forum writes check the balance against what Platform wants available (more than the fee), and put its refusal in plain words.
import { describe, expect, it } from 'vitest';
import { commentCost, forumOps, upfrontRequired, UPFRONT_HEADROOM, type DocumentOp } from '@govhub/forum';
import { assertCanAffordWrite, costText, forumWriteRequired, isShort, topUpFromError, TopUpError } from './funds.ts';

const contracts = { forum: 'F'.repeat(43), mod: 'M'.repeat(43) } as unknown as Parameters<typeof forumOps>[0];
const ops = forumOps(contracts, () => 1_800_000_000_000);
const GOV = 'ab'.repeat(32);
const comment52 = (): DocumentOp => ops.comment(GOV, 'C2 prelaunch QA badge check 2026-10-25T22:44:09.870Z'.padEnd(52, '.'));

describe('F2: the up-front balance check', () => {
  it('refuses the QA case: a 52-byte comment at 0.0015 DASH (150,438,280 credits) needs 227,124,440+', () => {
    const op = comment52();
    expect(new TextEncoder().encode(String(op.action === 'create' ? op.data.body : '')).length).toBe(52);
    expect(forumWriteRequired(op)!).toBeGreaterThanOrEqual(227_124_440n);
    expect(() => assertCanAffordWrite(150_438_280n, op)).toThrow(TopUpError);
    expect(() => assertCanAffordWrite(KNOWN_OK, op)).not.toThrow();
  });
  const KNOWN_OK = 400_000_000n;

  it('the shown fee alone is not enough', () => {
    const fee = commentCost(52);
    expect(isShort(BigInt(fee) + 1_000_000n, fee)).toBe(true);
    expect(isShort(BigInt(fee) * 6n, fee)).toBe(false);
    expect(isShort(null, fee)).toBe(false); // unknown balance: the write is tried
  });

  it('covers every forum write kind, and never stops a delete', () => {
    const ID = 'D'.repeat(43);
    const written: DocumentOp[] = [
      ops.react({ govHash: GOV }, 1),
      ops.react({ commentId: ID }, -1, { id: ID, revision: 1, value: 1 }),
      ops.block('forum', ID, 2),
      ops.claim(GOV, 2, new Uint8Array(65)),
      ops.profile({ displayName: 'Alice' }),
      ops.proposalPost(GOV, 'A title', [new Uint8Array(100)]),
      ops.blockSubs([], false),
    ];
    for (const op of written) {
      expect(forumWriteRequired(op), op.type).toBeGreaterThan(185_000_000n);
      expect(() => assertCanAffordWrite(10_000_000n, op), op.type).toThrow(TopUpError);
    }
    expect(forumWriteRequired(ops.retractComment(ID))).toBeNull();
    expect(() => assertCanAffordWrite(0n, ops.retractComment(ID))).not.toThrow();
    expect(() => assertCanAffordWrite(0n, ops.react({ commentId: ID }, 1, { id: ID, revision: 1, value: 1 }))).not.toThrow(); // clearing refunds
  });

  it('says both numbers: the fee, and what must be available', () => {
    expect(costText(commentCost(52))).toMatch(/^costs about 0\.00043 DASH, needs about 0\.0023 DASH available$/);
  });
});

describe('F2: Platform’s refusal in plain words', () => {
  const raw = 'Failed to broadcast: Protocol error: Insufficient identity AeJkWhDjL8QD7UTDEywqbY6qe2yVJ1dG2JfTU1KjHVpJ balance 150438280 required 227124440';
  it('becomes a top-up message with both amounts, never the raw error', () => {
    const e = topUpFromError(new Error(raw), 'forum');
    expect(e).toBeInstanceOf(TopUpError);
    const m = (e as Error).message;
    expect(m).toContain('0.00150438 DASH available');
    expect(m).toContain('about 0.00227124 DASH available');
    expect(m).toMatch(/Top up the identity, then try again\. Nothing was posted\./);
    expect(m).not.toMatch(/Protocol error|Insufficient identity|AeJk/);
  });
  it('also reads a WASM SDK error whose message is a prototype getter', () => {
    class WasmSdkError {
      get message() {
        return raw;
      }
    }
    expect(topUpFromError(new WasmSdkError(), 'forum')).toBeInstanceOf(TopUpError);
  });
  it('keyring wording is unchanged, and other errors pass through', () => {
    expect((topUpFromError(new Error(raw)) as Error).message).toMatch(/saving the keyring on Platform needs about/);
    const other = new Error('nope');
    expect(topUpFromError(other, 'forum')).toBe(other);
  });
});

describe('F2: what Platform wants available', () => {
  it('is the fee plus the up-front headroom, calibrated on the measured refusal', () => {
    // QA: a 52-byte comment (shown as about 0.00043 DASH) was refused at balance 150,438,280 with "required 227,124,440"
    const required = upfrontRequired(commentCost(52));
    expect(required).toBeGreaterThanOrEqual(227_124_440);
    expect(required).toBeLessThan(227_124_440 * 1.05);
    expect(required / commentCost(52)).toBeGreaterThan(5);
    // a big comment is not asked for a multiple of its fee: the headroom is added once
    expect(upfrontRequired(commentCost(5000))).toBe(commentCost(5000) + UPFRONT_HEADROOM);
    // refunds do not count towards it
    expect(upfrontRequired(-43_000_000)).toBe(UPFRONT_HEADROOM);
  });
});
