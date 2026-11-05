import { describe, expect, it } from 'vitest';
import { cardMark } from './ProposalCard.tsx';

const network = "The chain couldn't be checked: this browser couldn't reach the Dash network's nodes just now";
const mismatch = 'Mismatch: the signed votes the bridge served contradict the Platform tally for block 2,567,100';

describe('the trust mark on a proposal card', () => {
  it("a check that only couldn't reach the network marks no card (the list says it once)", () => {
    expect(cardMark({ level: 'error', reason: network }, undefined)).toBeNull();
    expect(cardMark(null, { status: 'inconclusive', reason: 'Failed to fetch' })).toBeNull();
  });
  it('a mismatch or an absent collateral stays on the card', () => {
    expect(cardMark({ level: 'error', reason: mismatch }, undefined)).toEqual({ level: 'error', reason: mismatch });
    expect(cardMark(null, { status: 'inconclusive', reason: "every DAPI node asked answered NOT_FOUND (nodes can't prove a transaction doesn't exist)" })?.level).toBe('error');
    // a network-only page result doesn't hide what the background check found
    expect(cardMark({ level: 'error', reason: network }, { status: 'inconclusive', reason: 'the nodes disagree about the transaction' })?.reason).toMatch(/nodes disagree/);
  });
  it('finished results show as they are; a pending check shows nothing', () => {
    expect(cardMark({ level: 'verified', reason: null }, { status: 'pending' })).toEqual({ level: 'verified', reason: null });
    expect(cardMark({ level: 'partial', reason: 'Testnet' }, undefined)?.level).toBe('partial');
    expect(cardMark(null, { status: 'pending' })).toBeNull();
  });
});
