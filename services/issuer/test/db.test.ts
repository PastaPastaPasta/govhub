import { describe, expect, it } from 'vitest';
import { openTokenStore, type TokenStore } from '../src/db.ts';
import { legacyClose, rnd, tmpDb } from './helpers.ts';

const sig = () => rnd(256);

const take = (s: TokenStore, epoch: number, p: string) => s.reserve({ epoch, windowFrom: 0, proTxHash: p, collateral: p, blindedHash: rnd(32) }, sig);

describe('token store', () => {
  it('a database from before the start guard keeps issuing (it has epochs but no meta table)', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const Database = (await import('better-sqlite3')).default;
    const path = join(mkdtempSync(join(tmpdir(), 'issuer-db-')), 'old.sqlite');
    const old = new Database(path);
    old.exec('CREATE TABLE epochs (epoch INTEGER PRIMARY KEY, issued INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0, served INTEGER NOT NULL DEFAULT 0, report_id TEXT)');
    old.close();
    const s = openTokenStore(path);
    s.markStarted(999);
    expect(s.reserve({ epoch: 5, windowFrom: 10, proTxHash: 'aa', collateral: 'c1', blindedHash: rnd(32) }, sig).kind).toBe('signed');
    const fresh = openTokenStore(join(mkdtempSync(join(tmpdir(), 'issuer-db-')), 'new.sqlite'));
    fresh.markStarted(999);
    expect(fresh.reserve({ epoch: 5, windowFrom: 10, proTxHash: 'aa', collateral: 'c1', blindedHash: rnd(32) }, sig).kind).toBe('store-too-new');
  });

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

  it('reopens epochs an older rule closed above the close mark, newest first, while none had a token or a report', () => {
    const path = tmpDb();
    let s = openTokenStore(path);
    s.markStarted(0);
    take(s, 3, 'a');
    s.openEpoch(4);
    s.openEpoch(6);
    s.close();
    legacyClose(path, 4);
    legacyClose(path, 8); // 5 and 7 have no row: closed by the watermark only
    s = openTokenStore(path);
    expect(s.reopenAboveCloseMark()).toEqual([]); // no close mark yet: nothing is reopened
    s.closeThrough(2);
    s.markReported(4, 'doc');
    // 8 and 6 never had a token: reopened; 4 is reported: it stays closed, and so does everything below it
    expect(s.reopenAboveCloseMark()).toEqual([8, 6]);
    expect(s.closedThrough()).toBe(4);
    expect(take(s, 5, 'b').kind).toBe('signed');
    expect(take(s, 4, 'c')).toEqual({ kind: 'closed' });
    expect(s.issued(3)).toBe(1);
  });

  it('never reopens an epoch whose token rows were deleted, nor one closeThrough closed', () => {
    const path = tmpDb();
    let s = openTokenStore(path);
    s.markStarted(0);
    s.closeThrough(1);
    take(s, 5, 'b');
    s.openEpoch(6);
    s.close();
    legacyClose(path, 6);
    s = openTokenStore(path);
    // 6 had no token: reopened; 5's rows are gone: closed for good, and the 'b' token cannot be issued twice
    expect(s.reopenAboveCloseMark()).toEqual([6]);
    expect(s.closedThrough()).toBe(5);
    expect(s.issued(5)).toBe(1);
    expect(take(s, 5, 'b')).toEqual({ kind: 'closed' });
    // closed by closeThrough (the tip passed its window), with no token: a lower tip later does not reopen it
    s.closeThrough(9);
    expect(s.reopenAboveCloseMark()).toEqual([]);
    expect(s.closedThrough()).toBe(9);
  });
});
