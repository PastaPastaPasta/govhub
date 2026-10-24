// runFunding against a scripted DAPI and Platform: ordering (watch before showing the address, watch before broadcast), IS-lock
// persistence, the chain-lock fallback, resume without rebuilding the lock, and records that hold no secrets.
import { parseTx, type Dapi, type WatchHandlers } from '@govhub/dapi';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hash160, hexToBytes } from '../src/bytes.ts';
import { fundingKey, runFunding, sessionTopUpKey, type FundingRecord, type FundingStore, type FundingView } from '../src/funding.ts';
import { addressOf, wifOf } from '../src/keys.ts';
import type { AssetLockProofInput, PlatformPort } from '../src/platform.ts';
import { registrationFundingPath, SeedWallet } from '../src/seed.ts';
import { buildPayment, identityIdFromOutpoint } from '../src/tx.ts';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';

function memStore(): FundingStore & { m: Map<string, FundingRecord> } {
  const m = new Map<string, FundingRecord>();
  return { m, load: (k) => structuredClone(m.get(k) ?? null), save: (r) => void m.set(r.key, structuredClone(r)), remove: (k) => void m.delete(k), list: () => [...m.values()] };
}

interface Script {
  events: string[];
  deliverIsLock: boolean;
  mined: number;
}

/** A DAPI that pays the watched address once the address is shown, and IS-locks whatever is broadcast. */
function fakeDapi(s: Script) {
  const watchers: WatchHandlers[] = [];
  let broadcast: Uint8Array | null = null;
  const dapi = {
    network: 'testnet',
    call: async (fn: (core: unknown) => Promise<unknown>) => ({
      value: await fn({
        getBestBlockHeight: async () => 1000,
        getTransaction: async () => ({ raw: broadcast, height: s.mined, confirmations: 1 }),
      }),
      node: 'n',
    }),
    watchAddressForDeposit: async (_h: Uint8Array, h: WatchHandlers) => {
      s.events.push('watch-deposit');
      watchers.push(h);
      return { cancel: () => s.events.push('cancel-deposit') };
    },
    watchTransactions: async (_f: unknown, h: WatchHandlers) => {
      s.events.push('watch-lock');
      watchers.push(h);
      return { cancel: () => {} };
    },
    broadcastTransaction: async (raw: Uint8Array) => {
      s.events.push('broadcast');
      broadcast = raw;
      const txid = parseTx(raw).txid;
      if (s.deliverIsLock) setTimeout(() => void watchers.at(-1)!.onIsLock({ lock: { txid } as never, bytes: hexToBytes('01' + 'ab'.repeat(100)), known: true, node: 'n' }), 5);
      return { txid, node: 'n' };
    },
    pay(raw: Uint8Array) {
      const tx = parseTx(raw);
      watchers[0]!.onTx({ tx, raw, matches: [0], node: 'n' });
    },
  };
  return dapi;
}

function fakePlatform(o: { refuseInstant?: boolean; onRefuse?: () => void } = {}) {
  const created = new Map<string, AssetLockProofInput>();
  const p: PlatformPort & { created: typeof created; calls: string[] } = {
    network: 'testnet',
    created,
    calls: [],
    identityByUniqueKeyHash: async () => null,
    identitiesByNonUniqueKeyHash: async () => [],
    identityKeys: async (id) => (created.has(id) ? [] : null),
    balance: async (id) => (created.has(id) ? 1n : null),
    coreChainLockedHeight: async () => 2000,
    createIdentity: async ({ proof }) => {
      p.calls.push(proof.kind);
      if (proof.kind === 'instant' && o.refuseInstant) {
        o.onRefuse?.();
        throw new Error('Invalid instant lock signature');
      }
      const txid = proof.kind === 'instant' ? parseTx(proof.tx).txid : proof.txid;
      created.set(identityIdFromOutpoint(txid, proof.creditIndex), proof);
    },
    topUpIdentity: async () => {},
    addKeys: async () => {},
    vault: { list: async () => [], byCredential: async () => null, put: async () => {}, remove: async () => {} },
  };
  return p;
}

const funderKey = hexToBytes('33'.repeat(32));
const deposit = (to: string, duffs: bigint) => {
  const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
  const k = w.derive(registrationFundingPath('testnet', 0));
  expect(addressOf(k.publicKey, 'testnet')).toBe(to);
  return buildPayment({ utxos: [{ txid: 'cd'.repeat(32), vout: 0, value: 10_000_000n }], key: funderKey, to: [{ pubKeyHash: hash160(k.publicKey), duffs }] }).raw;
};

describe('runFunding (create)', () => {
  it('shows the address only after the watcher is live, watches before broadcasting, persists the IS-lock, registers', async () => {
    const s: Script = { events: [], deliverIsLock: true, mined: 0 };
    const dapi = fakeDapi(s);
    const platform = fakePlatform();
    const store = memStore();
    const views: FundingView[] = [];
    const r = await runFunding({
      wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform, store, kind: 'create', identityIndex: 0, isLockWaitMs: 2000,
      onUpdate: (v) => {
        views.push(v);
        if (v.state === 'awaiting-deposit' && views.length === 1) {
          s.events.push('address-shown');
          dapi.pay(deposit(v.address, 1_000_000n));
        }
      },
    });
    expect(s.events.slice(0, 2)).toEqual(['watch-deposit', 'address-shown']);
    expect(s.events.indexOf('watch-lock')).toBeLessThan(s.events.indexOf('broadcast'));
    expect(platform.calls).toEqual(['instant']);
    const rec = store.m.get(fundingKey('create', 'testnet', 0))!;
    expect(rec.state).toBe('done');
    expect(rec.isLock).toMatch(/^01/);
    expect(rec.identityId).toBe(r.identityId);
    expect(rec.identityId).toBe(identityIdFromOutpoint(rec.lock!.txid, 0));
    // no key material in the record
    const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
    const json = JSON.stringify(rec);
    for (const secret of [w.derive(registrationFundingPath('testnet', 0)).privateKey, w.identityKey(0, 2).privateKey, w.entropy()]) {
      expect(json).not.toContain(bytesToHex(secret));
      expect(json).not.toContain(wifOf(secret.length === 32 ? secret : new Uint8Array(32).fill(1), 'testnet'));
    }
  });

  it('falls back to a chain-lock proof when Platform refuses the IS-lock, and resumes without rebuilding the lock', async () => {
    const s: Script = { events: [], deliverIsLock: true, mined: 0 };
    const dapi = fakeDapi(s);
    const store = memStore();
    const wallet = SeedWallet.fromPhrase(PHRASE, 'testnet');
    // first run: stop right after the asset lock is built and broadcast (abort while waiting for the IS-lock)
    const ac = new AbortController();
    s.deliverIsLock = false;
    await runFunding({
      wallet, dapi: dapi as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, isLockWaitMs: 60_000, signal: ac.signal,
      onUpdate: (v) => {
        if (v.state === 'awaiting-deposit' && !v.receivedDuffs) dapi.pay(deposit(v.address, 1_000_000n));
        if (v.state === 'locked') ac.abort();
      },
    }).catch(() => {});
    const first = store.m.get(fundingKey('create', 'testnet', 0))!;
    expect(first.state).toBe('locked');
    const lockTxid = first.lock!.txid;
    // second run (a reload): the lock is not mined yet, so the same bytes are re-sent and the IS-lock arrives; Platform refuses it
    // (say its quorum rotated away), so a chain proof at Platform's height follows once the lock is mined
    s.deliverIsLock = true;
    s.mined = 0;
    const platform = fakePlatform({ refuseInstant: true, onRefuse: () => (s.mined = 1500) });
    const r = await runFunding({ wallet, dapi: dapi as unknown as Dapi, platform, store, kind: 'create', identityIndex: 0, isLockWaitMs: 2000, pollMs: 10 });
    const rec = store.m.get(fundingKey('create', 'testnet', 0))!;
    expect(rec.lock!.txid).toBe(lockTxid);
    expect(platform.calls).toEqual(['instant', 'chain']);
    expect((platform.created.get(r.identityId) as { coreChainLockedHeight: number }).coreChainLockedHeight).toBe(2000);
    expect(rec.state).toBe('done');
    expect(s.events.filter((e) => e === 'broadcast')).toHaveLength(2);
  });

  it('does not re-send or wait for an IS-lock when the lock is already mined (IS-locks are never replayed)', async () => {
    const s: Script = { events: [], deliverIsLock: false, mined: 0 };
    const dapi = fakeDapi(s);
    const store = memStore();
    const wallet = SeedWallet.fromPhrase(PHRASE, 'testnet');
    const ac = new AbortController();
    await runFunding({
      wallet, dapi: dapi as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, isLockWaitMs: 60_000, signal: ac.signal,
      onUpdate: (v) => {
        if (v.state === 'awaiting-deposit' && !v.receivedDuffs) dapi.pay(deposit(v.address, 1_000_000n));
        if (v.state === 'locked') ac.abort();
      },
    }).catch(() => {});
    s.mined = 1500;
    const platform = fakePlatform();
    await runFunding({ wallet, dapi: dapi as unknown as Dapi, platform, store, kind: 'create', identityIndex: 0, isLockWaitMs: 100, pollMs: 10 });
    expect(platform.calls).toEqual(['chain']);
    expect(s.events.filter((e) => e === 'broadcast')).toHaveLength(1);
  });

  it('refuses a saved record that belongs to another phrase', async () => {
    const store = memStore();
    store.save({ v: 1, key: fundingKey('create', 'testnet', 0), kind: 'create', network: 'testnet', identityIndex: 0, address: 'yNotMine', deposits: [], state: 'awaiting-deposit', createdAt: 0, updatedAt: 0 });
    const dapi = fakeDapi({ events: [], deliverIsLock: false, mined: 0 });
    await expect(runFunding({ wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0 })).rejects.toThrow(/another recovery phrase/);
  });
});

describe('sessionTopUpKey', () => {
  it('is deterministic per (key, identity, n) and differs across them', () => {
    const k = hexToBytes('44'.repeat(32));
    const id = 'FUfinhTAJRUff12BbJLZa7ZUqjJne8Xqyh9aiJdeKiXh';
    expect(bytesToHex(sessionTopUpKey(k, id, 0).privateKey)).toBe(bytesToHex(sessionTopUpKey(k, id, 0).privateKey));
    expect(bytesToHex(sessionTopUpKey(k, id, 0).privateKey)).not.toBe(bytesToHex(sessionTopUpKey(k, id, 1).privateKey));
    expect(bytesToHex(sessionTopUpKey(k, id, 0).privateKey)).not.toBe(bytesToHex(k));
  });
});
