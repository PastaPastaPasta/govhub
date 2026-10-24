import { describe, expect, it } from 'vitest';
import { openTokenStore } from '../src/db.ts';
import { rnd } from './helpers.ts';

const sig = () => rnd(256);

describe('token store', () => {
  it('refuses an epoch whose window opened before the store existed (a lost or reset database)', () => {
    const s = openTokenStore(':memory:');
    expect(s.reserve({ epoch: 5, windowFrom: 10, proTxHash: 'aa', collateral: 'c1', blindedHash: rnd(32) }, sig)).toEqual({ kind: 'store-too-new' });
    s.markStarted(11);
    s.markStarted(5); // the first height is kept
    expect(s.reserve({ epoch: 5, windowFrom: 10, proTxHash: 'aa', collateral: 'c1', blindedHash: rnd(32) }, sig)).toEqual({ kind: 'store-too-new' });
    expect(s.reserve({ epoch: 6, windowFrom: 11, proTxHash: 'aa', collateral: 'c1', blindedHash: rnd(32) }, sig).kind).toBe('signed');
  });

  it('dedups per (epoch, proTxHash) and (epoch, collateral); idempotent on the same blinded hash', () => {
    const s = openTokenStore(':memory:');
    s.markStarted(0);
    const h = rnd(32);
    const a = s.reserve({ epoch: 5, windowFrom: 10, proTxHash: 'aa', collateral: 'c1', blindedHash: h }, sig);
    expect(a.kind).toBe('signed');
    const again = s.reserve({ epoch: 5, windowFrom: 10, proTxHash: 'aa', collateral: 'c1', blindedHash: h }, sig);
    expect(again).toMatchObject({ kind: 'signed', retry: true });
    expect(s.reserve({ epoch: 5, windowFrom: 10, proTxHash: 'aa', collateral: 'c1', blindedHash: rnd(32) }, sig)).toEqual({ kind: 'conflict', reason: 'mn' });
    expect(s.reserve({ epoch: 5, windowFrom: 10, proTxHash: 'bb', collateral: 'c1', blindedHash: rnd(32) }, sig)).toEqual({ kind: 'conflict', reason: 'collateral' });
    expect(s.reserve({ epoch: 6, windowFrom: 10, proTxHash: 'aa', collateral: 'c1', blindedHash: rnd(32) }, sig).kind).toBe('signed'); // next epoch is fresh
    expect(s.issued(5)).toBe(1);
    expect(s.issued(6)).toBe(1);
  });

  it('nothing is stored when signing throws', () => {
    const s = openTokenStore(':memory:');
    s.markStarted(0);
    expect(() => s.reserve({ epoch: 5, windowFrom: 10, proTxHash: 'aa', collateral: 'c1', blindedHash: rnd(32) }, () => { throw new Error('fault'); })).toThrow('fault');
    expect(s.issued(5)).toBe(0);
    expect(s.reserve({ epoch: 5, windowFrom: 10, proTxHash: 'aa', collateral: 'c1', blindedHash: rnd(32) }, sig).kind).toBe('signed');
  });

  it('closing deletes token rows, keeps counts, refuses further issuance, and lists the epoch for reporting', () => {
    const s = openTokenStore(':memory:');
    s.markStarted(0);
    for (const p of ['a', 'b', 'c']) s.reserve({ epoch: 7, windowFrom: 10, proTxHash: p, collateral: p, blindedHash: rnd(32) }, sig);
    s.openEpoch(8);
    expect(s.closeThrough(7)).toBe(3);
    expect(s.issued(7)).toBe(3);
    expect(s.reserve({ epoch: 7, windowFrom: 10, proTxHash: 'd', collateral: 'd', blindedHash: rnd(32) }, sig)).toEqual({ kind: 'closed' });
    expect(s.unreported()).toEqual([7]);
    s.markReported(7, 'doc');
    expect(s.unreported()).toEqual([]);
    expect(s.reserve({ epoch: 8, windowFrom: 10, proTxHash: 'a', collateral: 'a', blindedHash: rnd(32) }, sig).kind).toBe('signed');
  });
});
