// GET /v1/status's held count and GET /v1/votes/:id's hold explanation, in the situation an owner hit on testnet: a vote goes out
// and is confirmed, then a second vote with the SAME outcome is sent ~70 s later and the relay holds it for Core's one-change-per-hour
// rule. The status must count it, and the vote's record must say why it waits, until when, and that it changes nothing.
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, Store } from '../src/db.ts';
import { holdReason } from '../src/relay.ts';
import { T0, World } from './world.ts';

describe('held votes: count and explanation', () => {
  it('a same-outcome re-vote held for the one-hour rule is counted, explained and flagged', async () => {
    const w = new World('testnet');
    const mn = w.mn();
    const gov = w.proposal();
    const a = await w.submit(mn, { govHash: gov, outcome: 'no' });
    await w.broadcaster.tickBroadcast();
    w.clock.advance(30);
    await w.broadcaster.tickConfirm();
    expect(w.row(a.id).status).toBe('confirmed');
    expect((await w.get('/v1/status')).body.held).toBe(0);

    w.clock.advance(40);
    const b = await w.submit(mn, { govHash: gov, outcome: 'no', time: w.clock.t });
    expect((await w.get('/v1/status')).body.held).toBe(1);
    await w.broadcaster.tickBroadcast(); // rescheduled by the hour rule, not sent
    expect(w.core.count('voteraw')).toBe(1);
    expect((await w.get('/v1/status')).body.held).toBe(1);
    await w.broadcaster.tickConfirm();
    expect((await w.get('/v1/status')).body.held).toBe(1);

    const view = (await w.get(`/v1/votes/${b.id}`)).body;
    expect(view).toMatchObject({ status: 'held', holdReason: 'one-change-per-hour', nextAttemptAt: T0 + 3630, sameAsCurrent: true });
  });

  it('a vote whose outcome differs from the current one is not flagged; unknown when Core cannot be asked', async () => {
    const w = new World('testnet');
    const mn = w.mn();
    const gov = w.proposal();
    w.core.addCurrentVote(mn, gov, 'yes', T0 - 7200);
    const b = await w.submit(mn, { govHash: gov, outcome: 'no' });
    expect((await w.get(`/v1/votes/${b.id}`)).body.sameAsCurrent).toBe(false);
    const gov2 = w.proposal();
    w.core.currentVotesError = new Error('down');
    const c = await w.submit(mn, { govHash: gov2, outcome: 'no' });
    expect((await w.get(`/v1/votes/${c.id}`)).body.sameAsCurrent).toBeNull();
  });

  it('holdReason: release time, future limit, retries, and rows from before the hold codes', () => {
    const row = { status: 'held' as const, last_error: null, release_at: T0 + 600, next_attempt_at: T0 + 600, time: T0 + 600 };
    expect(holdReason(row, T0)).toBe('release-time');
    expect(holdReason({ ...row, last_error: 'future-limit' }, T0)).toBe('core-time-limit');
    expect(holdReason({ ...row, last_error: 'core-error' }, T0)).toBe('retrying');
    expect(holdReason({ ...row, last_error: 'too-often' }, T0)).toBe('one-change-per-hour');
    // legacy rows: rescheduled with no code
    expect(holdReason({ ...row, release_at: T0, next_attempt_at: T0 + 3630 }, T0)).toBe('one-change-per-hour');
    expect(holdReason({ ...row, release_at: T0, time: T0 + 7200, next_attempt_at: T0 + 7200 - 3540 }, T0)).toBe('core-time-limit');
    expect(holdReason({ ...row, status: 'broadcast' }, T0)).toBeNull();
  });

  it('opens a database created before same_as_current and adds the column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-db-'));
    try {
      const path = join(dir, 'old.db');
      const old = new Database(path);
      old.exec(`CREATE TABLE votes (id TEXT PRIMARY KEY, vote_hash TEXT NOT NULL UNIQUE, collateral_txid TEXT NOT NULL, collateral_n INTEGER NOT NULL,
        gov_hash TEXT NOT NULL, signal INTEGER NOT NULL, outcome INTEGER NOT NULL, time INTEGER NOT NULL, sig_b64 TEXT NOT NULL, release_at INTEGER NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, broadcast_at INTEGER, confirmed_at INTEGER, last_error TEXT,
        received_hour INTEGER NOT NULL, finished_at INTEGER, fail_n INTEGER NOT NULL DEFAULT 0, rebroadcasts INTEGER NOT NULL DEFAULT 0)`);
      old.prepare(`INSERT INTO votes (id, vote_hash, collateral_txid, collateral_n, gov_hash, signal, outcome, time, sig_b64, release_at, status, next_attempt_at, received_hour)
        VALUES ('${'a'.repeat(32)}', '${'b'.repeat(64)}', '${'c'.repeat(64)}', 0, '${'d'.repeat(64)}', 1, 2, ${T0}, 'x', ${T0}, 'held', ${T0 + 3630}, ${T0 - (T0 % 3600)})`).run();
      old.close();
      const store = new Store(openDb(path));
      expect(store.countHeld()).toBe(1);
      expect(store.get('a'.repeat(32))).toMatchObject({ status: 'held', same_as_current: null });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
