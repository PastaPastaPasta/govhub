// Logging policy (README "What is stored and logged"): nothing that could link a request to a masternode reaches stdout or stderr
// (which Docker's json-file driver keeps) or the token store: no proTxHash, collateral outpoint, IP address, user agent or
// per-request timestamp. This runs a full request flow, failures included, and searches everything that was written.
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log.ts';
import { openTokenStore } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { clientRequest, E, fakeMn, P, votingKey, world } from './helpers.ts';

const IP = '203.0.113.77';
const UA = 'Mozilla/5.0 (badge-log-test)';

describe('no linkable logs', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    log.setLevel('debug'); // the most verbose level must still be clean
    const keep = (chunk: unknown) => (out.push(String(chunk)), true);
    vi.spyOn(process.stderr, 'write').mockImplementation(keep as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(keep as never);
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    log.setLevel('error');
  });

  it('a full request flow writes nothing that names the masternode, its collateral or the client', async () => {
    const w = await world();
    const counters = new Map<string, number>();
    const app = createApp({ network: 'testnet', params: P, issuerId: w.issuerId, contractId: '2aYj4Dkix7xXBUTZFCDBjpcqqLi9Tg5oUwBgHUJBNGCU', service: w.service, epochs: { status: { height: 1, issuingEpochs: [E - 1, E], keyIds: {}, ready: true, problem: null } }, challengeTtlSec: 600, counters });
    const mn = w.core.add(fakeMn());
    const headers = { 'content-type': 'application/json', 'cf-connecting-ip': IP, 'x-forwarded-for': IP, 'user-agent': UA };
    const post = (path: string, body: unknown) => app.fetch(new Request(`http://issuer${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));
    await post('/v1/challenge', {});
    const ok = await post('/v1/token', (await clientRequest(w, mn)).body);
    expect(ok.status).toBe(200);
    expect((await post('/v1/token', (await clientRequest(w, mn)).body)).status).toBe(409); // duplicate
    expect((await post('/v1/token', (await clientRequest(w, mn, { signWith: votingKey().priv })).body)).status).toBe(403); // wrong key
    expect((await post('/v1/token', '{junk')).status).toBe(400);
    expect((await post('/v1/token', { request: 'x'.repeat(5000) })).status).toBe(413);
    // the hourly line main.ts writes
    log.info('requests in the last hour', { ...Object.fromEntries(counters) });
    const all = out.join('\n');
    const [txid, index] = mn.now!.collateral.split(':');
    for (const needle of [mn.proTxHash, txid!, `${txid}:${index}`, IP, UA]) expect(all, needle).not.toContain(needle);
    expect(all).toContain('requests in the last hour'); // the aggregate line is there
    expect(counters.get('issued')).toBe(1);
  });

  it('the token store has no time, address or client columns, and drops the rows of closed epochs', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'issuer-db-')), 's.sqlite');
    const s = openTokenStore(path);
    s.markStarted(0);
    s.reserve({ epoch: 5, windowFrom: 1, proTxHash: 'aa'.repeat(32), collateral: 'bb'.repeat(32) + ':1', blindedHash: new Uint8Array(32) }, () => new Uint8Array(256));
    const db = new Database(path, { readonly: true });
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('tokens')).toEqual(['epoch', 'pro_tx_hash', 'collateral', 'blinded_hash']);
    expect(cols('epochs')).toEqual(['epoch', 'issued', 'closed', 'served', 'report_id']);
    db.close();
    s.closeThrough(5);
    const db2 = new Database(path, { readonly: true });
    expect((db2.prepare('SELECT COUNT(*) AS n FROM tokens').get() as { n: number }).n).toBe(0);
    db2.close();
  });
});
