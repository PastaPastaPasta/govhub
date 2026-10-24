// Privacy by construction: nothing identifying the client is stored. The IP of a request must not appear anywhere in the SQLite files.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IpLimiter } from '../src/ratelimit.ts';
import { T0, World } from './world.ts';

describe('no client address at rest', () => {
  it('a burst of requests from one IP leaves no trace of it in the database file or its WAL', async () => {
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
      // the WAL holds everything written so far (nothing was checkpointed yet)
      expect(statSync(join(dir, 'relay.sqlite-wal')).size).toBeGreaterThan(0);
      for (const buf of dumpAll()) for (const n of needles) expect(buf.includes(n)).toBe(false);
      w.store.db.pragma('wal_checkpoint(TRUNCATE)');
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
});
