// Privacy by construction: nothing identifying the client is stored. The IP of a request must not appear anywhere in the SQLite files.
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, Store } from '../src/db.ts';
import { IpLimiter } from '../src/ratelimit.ts';
import { T0, World } from './world.ts';

describe('no client address at rest', () => {
  it('a burst of requests from one IP leaves no trace of it in the database file (and there is no WAL)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-privacy-'));
    const w = new World('testnet', { CLIENT_IP_HEADER: 'X-Real-IP', RATE_IP_PER_MIN: '1000', RATE_MN_PER_HOUR: '1000' }, join(dir, 'relay.sqlite'));
    try {
      const ips = ['198.51.100.23', '2001:db8:85a3::8a2e:370:7334'];
      const mn = w.mn();
      const ids: string[] = [];
      for (const ip of ips) {
        const hdr = { 'x-real-ip': ip, 'x-forwarded-for': ip, 'user-agent': 'Mozilla/5.0 privacy-test-agent' };
        for (let i = 0; i < 8; i++) {
          const gov = w.proposal();
          const body = w.voteBody(mn, { govHash: gov, time: T0 + 1800 + i });
          const r = await w.post('/v1/votes', body, hdr);
          expect(r.status).toBe(202);
          ids.push(r.body.id);
          await w.post('/v1/votes', body, hdr); // idempotent retry
          await w.post('/v1/votes/cancel', w.cancelBody(mn, r.body.id, r.body.voteHash), hdr);
          await w.post('/v1/votes', '{broken', hdr);
          await w.get(`/v1/votes/${r.body.id}`);
        }
      }
      expect(w.store.db.prepare(`SELECT COUNT(*) n FROM votes WHERE status = 'cancelled'`).get()).toEqual({ n: 16 });

      const needles = [...ips, 'privacy-test-agent'].map((s) => Buffer.from(s));
      const dumpAll = () =>
        readdirSync(dir)
          .map((f) => readFileSync(join(dir, f)))
          .map((b) => b);
      // no WAL and no leftover journal: the database file is all there is (review SR-36)
      expect(readdirSync(dir)).toEqual(['relay.sqlite']);
      for (const buf of dumpAll()) for (const n of needles) expect(buf.includes(n)).toBe(false);
      // a sanity check that the search would find data we did store
      expect(readFileSync(join(dir, 'relay.sqlite')).includes(Buffer.from(ids[0]!))).toBe(true);

      // the schema has no place for one
      const cols = (['votes', 'last_broadcast'] as const).flatMap((t) => (w.store.db.pragma(`table_info(${t})`) as Array<{ name: string }>).map((c) => c.name));
      expect(cols.filter((c) => /(^|_)(ip|addr|address|remote|agent|host)(_|$)/i.test(c))).toEqual([]);
      const tables = (w.store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((t) => t.name).sort();
      expect(tables).toEqual(['last_broadcast', 'votes']);
      // receive time is only kept as the hour
      const rows = w.store.db.prepare('SELECT received_hour FROM votes').all() as Array<{ received_hour: number }>;
      for (const r of rows) expect(r.received_hour % 3600).toBe(0);
      expect(rows[0]!.received_hour).toBe(T0 - (T0 % 3600));
    } finally {
      w.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the IP limiter keys buckets by a salted HMAC, so equal addresses collide and different ones do not', () => {
    let t = 1000;
    const a = new IpLimiter(2, () => t);
    expect(a.take('192.0.2.1')).toBe(0);
    expect(a.take('192.0.2.1')).toBe(0);
    expect(a.take('192.0.2.1')).toBeGreaterThan(0);
    expect(a.take('192.0.2.2')).toBe(0);
    expect(a.size).toBe(2);
    t += 60;
    a.take('192.0.2.3'); // sweeps the idle full buckets
    expect(a.size).toBe(1);
    // a limiter with another salt does not know the first one's buckets (the key is not derivable from the address alone)
    const b = new IpLimiter(2, () => t);
    expect(b.take('192.0.2.1')).toBe(0);
    expect(b.take('192.0.2.1')).toBe(0);
    expect(b.take('192.0.2.1')).toBeGreaterThan(0);
  });

  it('SR-36: the file keeps neither the order votes arrived in nor the content of purged rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-order-'));
    const path = join(dir, 'relay.sqlite');
    const w = new World('testnet', { RATE_MN_PER_HOUR: '1000', MAX_HELD_PER_MN: '1000', RATE_IP_PER_MIN: '1000' }, path);
    try {
      const mn = w.mn();
      const ids: string[] = [];
      for (let i = 0; i < 40; i++) ids.push((await w.submit(mn, { govHash: w.proposal(), time: T0 + 1800 + i })).id);
      // no rowid: nothing numbers the rows in arrival order, and they are stored (and read back from the table b-tree) in id order
      expect(() => w.store.db.prepare('SELECT rowid FROM votes').all()).toThrow(/no such column/);
      for (const t of ['votes', 'last_broadcast']) expect(w.store.db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t)).toEqual({ sql: expect.stringMatching(/WITHOUT ROWID$/) });
      const stored = (w.store.db.prepare('SELECT id, sig_b64 FROM votes').all() as Array<{ id: string }>).map((r) => r.id);
      expect(stored).toEqual([...ids].sort());
      expect(stored).not.toEqual(ids);
      expect(w.store.db.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(w.store.db.pragma('secure_delete', { simple: true })).toBe(1);
      // purged rows are zeroed in the file, not just unlinked from the b-tree
      const victim = w.row(ids[7]!);
      await w.post('/v1/votes/cancel', w.cancelBody(mn, victim.id, victim.vote_hash));
      w.clock.advance(8 * 86400);
      expect(w.broadcaster.tickPurge().votes).toBe(1);
      const file = readFileSync(path);
      for (const needle of [victim.id, victim.vote_hash, victim.sig_b64]) expect(file.includes(Buffer.from(needle))).toBe(false);
      expect(file.includes(Buffer.from(ids[8]!))).toBe(true);
    } finally {
      w.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a database from before (rowid tables, WAL): rows kept in id order, no WAL left, held re-sends become maybe-broadcast', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-migrate-'));
    const path = join(dir, 'relay.sqlite');
    try {
      const old = new Database(path);
      old.pragma('journal_mode = WAL');
      old.exec(`CREATE TABLE votes (id TEXT PRIMARY KEY, vote_hash TEXT NOT NULL UNIQUE, collateral_txid TEXT NOT NULL, collateral_n INTEGER NOT NULL, gov_hash TEXT NOT NULL,
        signal INTEGER NOT NULL, outcome INTEGER NOT NULL, time INTEGER NOT NULL, sig_b64 TEXT NOT NULL, release_at INTEGER NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, broadcast_at INTEGER, confirmed_at INTEGER, last_error TEXT, received_hour INTEGER NOT NULL,
        finished_at INTEGER, fail_n INTEGER NOT NULL DEFAULT 0, rebroadcasts INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX votes_due ON votes (status, next_attempt_at);
        CREATE TABLE last_broadcast (collateral_txid TEXT NOT NULL, collateral_n INTEGER NOT NULL, gov_hash TEXT NOT NULL, signal INTEGER NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (collateral_txid, collateral_n, gov_hash, signal));`);
      const ins = old.prepare(`INSERT INTO votes (id, vote_hash, collateral_txid, collateral_n, gov_hash, signal, outcome, time, sig_b64, release_at, status, next_attempt_at, received_hour, rebroadcasts, last_error)
        VALUES (?, ?, ?, 0, ?, 1, 1, 1, 'sig', 1, ?, 1, 0, ?, ?)`);
      const rows: Array<[string, string, number, string | null]> = [
        ['ff'.repeat(16), 'held', 0, null],
        ['aa'.repeat(16), 'held', 2, 'not-visible'],
        ['cc'.repeat(16), 'held', 0, 'core-error'],
        ['bb'.repeat(16), 'confirmed', 0, null],
      ];
      for (const [id, status, rb, err] of rows) ins.run(id, id + id, 'tx' + id, 'gov' + id, status, rb, err);
      old.prepare('INSERT INTO last_broadcast VALUES (?, 0, ?, 1, 5)').run('t', 'g');
      expect(readdirSync(dir)).toContain('relay.sqlite-wal');
      old.close();

      const store = new Store(openDb(path));
      expect(readdirSync(dir)).toEqual(['relay.sqlite']);
      expect((store.db.prepare('SELECT id, sig_b64 FROM votes').all() as Array<{ id: string }>).map((r) => r.id)).toEqual(rows.map((r) => r[0]).sort());
      expect(store.get('ff'.repeat(16))).toMatchObject({ status: 'held', maybe_sent: 0, same_as_current: null });
      expect(store.get('aa'.repeat(16))).toMatchObject({ status: 'maybe-broadcast', maybe_sent: 1, rebroadcasts: 2 });
      expect(store.get('cc'.repeat(16))).toMatchObject({ status: 'maybe-broadcast', maybe_sent: 1 });
      expect(store.get('bb'.repeat(16))).toMatchObject({ status: 'confirmed', maybe_sent: 0 });
      expect(store.lastBroadcastAt({ txid: 't', n: 0, govHash: 'g', signal: 1 })).toBe(5);
      expect(() => store.db.prepare('SELECT rowid FROM votes').all()).toThrow(/no such column/);
      expect((store.db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all('index') as Array<{ name: string }>).map((r) => r.name)).toEqual(expect.arrayContaining(['votes_due', 'votes_key']));
      store.close();
      // opening again is a no-op
      const again = new Store(openDb(path));
      expect(again.db.prepare('SELECT COUNT(*) n FROM votes').get()).toEqual({ n: 4 });
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
