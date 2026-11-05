// The treasury ledger against real mainnet superblock coinbases (ledger.fixtures.json: outputs of the coinbases of blocks 2,160,080,
// 2,359,472, 2,542,248 and 2,558,864, as insight.dash.org served them on 5 Nov 2026). 2,359,472's pool put the credit-pool output
// first and the miner last, so the split must not depend on output order.
import { describe, expect, it } from 'vitest';
import type { Proposal } from '../data/types.ts';
import fixtures from './ledger.fixtures.json';
import { ledgerEntry, outcomeOf, scriptAddress, superblockHeights, treasuryPayments, type CoinbaseOutput, type SuperblockRead } from './ledger.ts';

const cb = fixtures as Record<string, CoinbaseOutput[]>;
const dash = (n: bigint) => Number(n) / 1e8;
const sum = (ps: { amount: bigint }[]) => dash(ps.reduce((a, p) => a + p.amount, 0n));

describe('treasuryPayments', () => {
  it("finds the treasury's payments whatever order the pool used", () => {
    expect(sum(treasuryPayments(cb['2558864']!, 'mainnet')!)).toBe(5393); // the bridge's /v1/cycle 'last.paid' for this superblock
    expect(treasuryPayments(cb['2558864']!, 'mainnet')!.map((p) => p.index)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(sum(treasuryPayments(cb['2542248']!, 'mainnet')!)).toBe(6810);
    expect(sum(treasuryPayments(cb['2160080']!, 'mainnet')!)).toBe(7919);
    const shuffled = treasuryPayments(cb['2359472']!, 'mainnet')!;
    expect(shuffled.map((p) => p.index)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(sum(shuffled)).toBe(7104);
  });
  it('names standard payees, P2SH too', () => {
    const ps = treasuryPayments(cb['2558864']!, 'mainnet')!;
    expect(ps.find((p) => p.amount === 4832_00000000n)?.address).toBe('7mUyau75ATy1c6LoZeG3D57jKBkR4iHJkE');
    expect(ps.find((p) => p.amount === 60_00000000n)?.address).toBe('XoLMVTXpDWvLe4yKcj989nZ2vddE2zJQ6q');
  });
  it('gives up rather than guess when the block reward cannot be told apart', () => {
    const outs = cb['2558864']!;
    expect(treasuryPayments(outs.filter((_, i) => i !== 1), 'mainnet')).toBeNull(); // no credit-pool output (older era)
    expect(treasuryPayments(outs.map((o, i) => (i === 0 ? { ...o, value: String(BigInt(o.value) + 1000n) } : o)), 'mainnet')).toBeNull();
  });
  it('finds no payments in a superblock that paid none, rather than giving up', () => {
    expect(treasuryPayments(cb['2558864']!.slice(0, 3), 'mainnet')).toEqual([]);
  });
  it('reads only standard scripts as addresses', () => {
    expect(scriptAddress('6a', 'mainnet')).toBeNull();
    expect(scriptAddress('76a914' + '00'.repeat(20) + '88ac', 'testnet')?.startsWith('y')).toBe(true);
  });
});

const read = (height: number, time: number, outputs = cb[String(height)]!): SuperblockRead => ({ height, blockHash: '00', time, outputs, weak: null });
function proposal(o: Partial<Proposal>): Proposal {
  return { govHash: 'a'.repeat(64), parentHash: '0'.repeat(64), revision: 1, time: 1, dataHex: '', name: 'p', url: '', paymentAddress: '', paymentAmount: 0, startEpoch: 0, endEpoch: 0, collateralTxid: '0'.repeat(64), collateralHeight: 0, ...o };
}
const DCG = proposal({ govHash: 'd'.repeat(64), name: 'DCG-Operations', paymentAddress: '7mUyau75ATy1c6LoZeG3D57jKBkR4iHJkE', paymentAmount: 4832e8, startEpoch: 1_790_000_000, endEpoch: 1_795_000_000 });

describe('ledgerEntry', () => {
  it('names the payments of known proposals, largest first, and the payee of the others', () => {
    const italia = proposal({ name: 'Dash-Italia', paymentAddress: 'XoLMVTXpDWvLe4yKcj989nZ2vddE2zJQ6q', paymentAmount: 60e8, startEpoch: 1_800_000_000, endEpoch: 1_810_000_000 });
    const e = ledgerEntry(read(2558864, 1792566848), [DCG, italia], 'mainnet');
    expect(dash(e.total!)).toBe(5393);
    expect(e.limit > e.total!).toBe(true);
    expect(e.lines![0]!.proposal?.name).toBe('DCG-Operations');
    const sixty = e.lines!.find((l) => l.payment.amount === 60_00000000n)!;
    expect(sixty.proposal).toBeNull(); // its window doesn't hold this superblock
    expect(sixty.samePayee?.name).toBe('Dash-Italia');
  });
  it('calls a payment two known proposals could each account for ambiguous', () => {
    const twin = { ...DCG, govHash: 'e'.repeat(64), name: 'DCG-twin' };
    const line = ledgerEntry(read(2558864, 1792566848), [DCG, twin], 'mainnet').lines![0]!;
    expect(line.proposal).toBeNull();
    expect(line.candidates.map((c) => c.name)).toEqual(['DCG-Operations', 'DCG-twin']);
  });
});

describe('outcomeOf', () => {
  const sb = read(2558864, 1792566848);
  const cover = { oldest: 1_780_000_000, unread: [] };
  it('funded when every superblock due to pay it did', () => {
    expect(outcomeOf({ ...DCG, startEpoch: 1_792_000_000, endEpoch: 1_793_000_000 }, [sb], 'mainnet', cover)).toMatchObject({ kind: 'funded', of: 1, paid: 1, total: 4832_00000000n, partial: null });
  });
  it('not funded when none did, and expired unpaid when none was due', () => {
    const missed = proposal({ paymentAddress: 'XoLMVTXpDWvLe4yKcj989nZ2vddE2zJQ6q', paymentAmount: 61e8, startEpoch: 1_792_000_000, endEpoch: 1_793_000_000 });
    expect(outcomeOf(missed, [sb], 'mainnet', cover).kind).toBe('not-funded');
    expect(outcomeOf({ ...missed, startEpoch: 1_792_700_000, endEpoch: 1_792_800_000 }, [sb], 'mainnet', cover).kind).toBe('no-payout');
  });
  it("doesn't count a superblock just outside its window as due, but counts it when it paid", () => {
    const missed = proposal({ paymentAddress: 'XoLMVTXpDWvLe4yKcj989nZ2vddE2zJQ6q', paymentAmount: 61e8, startEpoch: 1_792_000_000, endEpoch: 1_792_566_848 - 3 * 3600 });
    expect(outcomeOf(missed, [sb], 'mainnet', cover).kind).toBe('no-payout');
    expect(outcomeOf({ ...DCG, startEpoch: 1_792_000_000, endEpoch: 1_792_566_848 - 3 * 3600 }, [sb], 'mainnet', cover)).toMatchObject({ kind: 'funded', of: 1, paid: 1 });
  });
  it('says why the counts are only a lower bound', () => {
    expect(outcomeOf(DCG, [sb], 'mainnet', { oldest: 1_792_000_000, unread: [] })).toMatchObject({ kind: 'funded', of: 1, paid: 1, partial: 'earlier' });
    expect(outcomeOf({ ...DCG, startEpoch: 1_792_000_000 }, [sb], 'mainnet', { ...cover, unread: [1_792_100_000] })).toMatchObject({ partial: 'unread' });
    expect(outcomeOf(DCG, [], 'mainnet', { oldest: null, unread: [] }).kind).toBe('unknown');
  });
  it('flags a payment a twin (same payee and amount, due then too) could account for', () => {
    const p = { ...DCG, startEpoch: 1_792_000_000, endEpoch: 1_793_000_000 };
    expect(outcomeOf(p, [sb], 'mainnet', cover, [p, { ...p, govHash: 'f'.repeat(64) }])).toMatchObject({ kind: 'funded', shared: 1 });
  });
});

describe('superblockHeights', () => {
  it('counts back by the cycle, newest first', () => expect(superblockHeights(2558864, 16616, 3)).toEqual([2558864, 2542248, 2525632]));
});
