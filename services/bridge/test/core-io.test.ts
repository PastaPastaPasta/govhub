// CoreRpc retry/timeout behaviour, ZMQ sequence tracking and a real ZMQ loopback, config loading.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Publisher } from 'zeromq';
import { hexToBytes } from '@govhub/verify';
import { loadConfig, readIdentityKeyFile } from '../src/config.ts';
import { CoreRpc, CoreRpcError } from '../src/core/rpc.ts';
import { SequenceTracker, ZmqListener, type ZmqMessage } from '../src/core/zmq.ts';
import { votesFixture } from './helpers.ts';

function fakeFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ body: any; auth: string | null }> = [];
  const f = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next();
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (o: unknown, status = 200) => () => new Response(JSON.stringify(o), { status });

describe('CoreRpc', () => {
  it('sends JSON-RPC with basic auth and returns the result', async () => {
    const { f, calls } = fakeFetch([json({ result: 2560434, error: null, id: 1 })]);
    const rpc = new CoreRpc({ url: 'http://x', user: 'u', password: 'p', fetch: f });
    expect(await rpc.getBlockCount()).toBe(2560434);
    expect(calls[0]!.body.method).toBe('getblockcount');
    expect(calls[0]!.auth).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
  });

  it('retries transport errors and warm-up (-28), not other RPC errors', async () => {
    const down = () => {
      throw new TypeError('fetch failed');
    };
    const ok = fakeFetch([down, json({ result: null, error: { code: -28, message: 'Loading block index…' } }, 500), json({ result: 7, error: null })]);
    expect(await new CoreRpc({ url: 'http://x', user: 'u', password: 'p', fetch: ok.f, retryDelayMs: 1 }).call('getblockcount')).toBe(7);
    const bad = fakeFetch([json({ result: null, error: { code: -8, message: 'Unknown governance-hash' } }, 500)]);
    const err = await new CoreRpc({ url: 'http://x', user: 'u', password: 'p', fetch: bad.f, retryDelayMs: 1 }).call('gobject', ['get', 'x']).catch((e: unknown) => e as CoreRpcError);
    expect(err).toBeInstanceOf(CoreRpcError);
    expect((err as CoreRpcError).code).toBe(-8);
    expect(bad.calls.length).toBe(1);
  });

  it('gives up after the retry budget and fails fast on 401', async () => {
    const down = () => {
      throw new TypeError('fetch failed');
    };
    const r = fakeFetch([down, down, down]);
    await expect(new CoreRpc({ url: 'http://x', user: 'u', password: 'p', fetch: r.f, retries: 2, retryDelayMs: 1 }).call('x')).rejects.toThrow(/fetch failed/);
    expect(r.calls.length).toBe(3);
    const a = fakeFetch([() => new Response('', { status: 401 })]);
    await expect(new CoreRpc({ url: 'http://x', user: 'u', password: 'p', fetch: a.f }).call('x')).rejects.toThrow(/authentication/);
  });
});

describe('ZMQ', () => {
  it('SequenceTracker reports gaps per topic and handles uint32 wrap-around', () => {
    const t = new SequenceTracker();
    expect(t.observe('rawgovernancevote', 5)).toBeNull();
    expect(t.observe('rawgovernancevote', 6)).toBeNull();
    expect(t.observe('hashblock', 100)).toBeNull();
    expect(t.observe('rawgovernancevote', 9)).toEqual({ topic: 'rawgovernancevote', expected: 7, got: 9 });
    expect(t.observe('hashblock', 0xffffffff)).toEqual({ topic: 'hashblock', expected: 101, got: 0xffffffff });
    expect(t.observe('hashblock', 0)).toBeNull();
  });

  it('receives Core-framed messages (topic, body, LE sequence) over a real socket and reports a gap', async () => {
    const pub = new Publisher();
    await pub.bind('tcp://127.0.0.1:*');
    const url = pub.lastEndpoint!;
    const got: ZmqMessage[] = [];
    const gaps: unknown[] = [];
    const l = new ZmqListener(url, { onMessage: (m) => void got.push(m), onGap: (g) => void gaps.push(g) });
    l.start();
    const raw = hexToBytes(votesFixture().proposals[0]!.votes[0]!.rawHex);
    const seq = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n);
      return b;
    };
    // slow joiner: publish until the subscription is live
    for (let i = 0; i < 50 && got.length === 0; i++) {
      await pub.send(['rawgovernancevote', Buffer.from(raw), seq(i)]);
      await new Promise((r) => setTimeout(r, 20));
    }
    const base = got[got.length - 1]!.seq;
    await pub.send(['rawgovernancevote', Buffer.from(raw), seq(base + 3)]);
    await pub.send(['ignored-topic', Buffer.from('x'), seq(0)]);
    await new Promise((r) => setTimeout(r, 100));
    await l.stop();
    pub.close();
    expect(got[0]!.topic).toBe('rawgovernancevote');
    expect(Buffer.from(got[0]!.body).equals(Buffer.from(raw))).toBe(true);
    expect(gaps).toEqual([{ topic: 'rawgovernancevote', expected: base + 1, got: base + 3 }]);
    expect(got.every((m) => m.topic === 'rawgovernancevote')).toBe(true);
  });
});

describe('config', () => {
  it('PUBLISH=0 needs neither a contract nor an identity key file', () => {
    const c = loadConfig({ PUBLISH: '0', CORE_NETWORK: 'regtest' });
    expect(c.publish.enabled).toBe(false);
    expect(c.platformNetwork).toBe('testnet');
    expect(c.core.rpcUrl).toBe('http://127.0.0.1:19898');
  });

  it('PUBLISH=1 requires GOV_CONTRACT_ID and BRIDGE_IDENTITY_KEY_FILE; core and platform networks are independent', () => {
    expect(() => loadConfig({})).toThrow(/GOV_CONTRACT_ID/);
    expect(() => loadConfig({ GOV_CONTRACT_ID: 'x' })).toThrow(/BRIDGE_IDENTITY_KEY_FILE/);
    const c = loadConfig({ GOV_CONTRACT_ID: 'x', BRIDGE_IDENTITY_KEY_FILE: '/k', CORE_NETWORK: 'mainnet', PLATFORM_NETWORK: 'testnet' });
    expect([c.coreNetwork, c.platformNetwork]).toEqual(['mainnet', 'testnet']);
  });

  it('empty values mean defaults; secrets come from files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-cfg-'));
    writeFileSync(join(dir, 'pw'), 's3cret\n');
    const c = loadConfig({ PUBLISH: '0', CORE_RPC_PASSWORD_FILE: join(dir, 'pw'), RECONCILE_INTERVAL_S: '', TALLY_PUBLISH_INTERVAL_S: '' });
    expect(c.core.rpcPassword).toBe('s3cret');
    expect(c.reconcileIntervalSec).toBe(600);
    expect(c.publish.tallyIntervalSec).toBe(3600);
    expect(() => loadConfig({ PUBLISH: 'maybe' })).toThrow(/PUBLISH/);
    expect(() => loadConfig({ PUBLISH: '0', CORE_NETWORK: 'moon' })).toThrow(/CORE_NETWORK/);
    writeFileSync(join(dir, 'key.json'), JSON.stringify({ identityId: '9CVk', keyId: 2, privateKeyHex: '11'.repeat(32) }));
    expect(readIdentityKeyFile(join(dir, 'key.json')).keyId).toBe(2);
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ identityId: '9CVk', keyId: 2 }));
    expect(() => readIdentityKeyFile(join(dir, 'bad.json'))).toThrow(/privateKeyHex or wif/);
  });
});
