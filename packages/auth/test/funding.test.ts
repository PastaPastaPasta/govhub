// runFunding against a scripted DAPI and Platform: ordering (watch before showing the address, watch before broadcast), deposits
// counted only once IS-locked or mined, IS-lock persistence, the chain-lock fallback, resume without rebuilding the lock, records keyed
// per funding key (no collisions between seeds), error classification, ended sessions, and records that hold no secrets.
import { parseTx, type Dapi, type WatchHandlers } from '@govhub/dapi';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hash160, hexToBytes } from '../src/bytes.ts';
import {
  classifyRegistrationError, discardFunding, fundingRecordKey, nextTopUpIndex, pendingFundings, pickInputs, runFunding, sessionTopUpKey, type FundingRecord, type FundingStore, type FundingView,
} from '../src/funding.ts';
import { addressOf, publicKeyOf, wifOf } from '../src/keys.ts';
import { MIN_CREATE_LOCK_DUFFS } from '../src/layout.ts';
import type { AssetLockProofInput, PlatformPort } from '../src/platform.ts';
import { registrationFundingPath, SeedWallet } from '../src/seed.ts';
import { makeSession } from '../src/signin.ts';
import { AssetLockError, buildAssetLock, buildPayment, identityIdFromOutpoint } from '../src/tx.ts';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';
const PHRASE_B = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function memStore(): FundingStore & { m: Map<string, FundingRecord> } {
  const m = new Map<string, FundingRecord>();
  return { m, load: (k) => structuredClone(m.get(k) ?? null), save: (r) => void m.set(r.key, structuredClone(r)), remove: (k) => void m.delete(k), list: () => [...m.values()] };
}

interface Script {
  events: string[];
  deliverIsLock: boolean;
  mined: number;
  /** Error thrown by the next `rejectCount` broadcasts (default 1). */
  rejectNextBroadcast?: string;
  rejectCount?: number;
  /** getTransaction fails with a network error (not NOT_FOUND). */
  lookupFails?: boolean;
  /** Deliver the lock's IS-lock even when its broadcast is refused (another node relayed it). */
  isLockOnRefusal?: boolean;
}

/** A DAPI whose deposit watcher reports payments (IS-locked unless told otherwise) and which IS-locks whatever is broadcast. */
function fakeDapi(s: Script) {
  const deposits: WatchHandlers[] = [];
  const locks: WatchHandlers[] = [];
  let broadcast: Uint8Array | null = null;
  const known = new Set<string>();
  const isLock = (h: WatchHandlers, txid: string) => void h.onIsLock({ lock: { txid } as never, bytes: hexToBytes('01' + 'ab'.repeat(100)), known: true, node: 'n' });
  return {
    network: 'testnet',
    call: async (fn: (core: unknown) => Promise<unknown>) => ({
      value: await fn({
        getBestBlockHeight: async () => 1000,
        getTransaction: async (txid: string) => {
          if (s.lookupFails) throw Object.assign(new Error('upstream connect error'), { code: 14 });
          if (!known.has(txid)) throw Object.assign(new Error('not found'), { code: 5 });
          return { raw: broadcast, height: s.mined, confirmations: 1 };
        },
      }),
      node: 'n',
    }),
    watchAddressForDeposit: async (_h: Uint8Array, h: WatchHandlers) => {
      s.events.push('watch-deposit');
      deposits.push(h);
      return { cancel: () => {} };
    },
    watchTransactions: async (_f: unknown, h: WatchHandlers) => {
      s.events.push('watch-lock');
      locks.push(h);
      return { cancel: () => {} };
    },
    broadcastTransaction: async (raw: Uint8Array) => {
      s.events.push('broadcast');
      if (s.rejectNextBroadcast) {
        const m = s.rejectNextBroadcast;
        s.rejectCount = (s.rejectCount ?? 1) - 1;
        if (s.rejectCount <= 0) s.rejectNextBroadcast = undefined;
        if (s.isLockOnRefusal) isLock(locks.at(-1)!, parseTx(raw).txid);
        throw new Error(m);
      }
      broadcast = raw;
      const txid = parseTx(raw).txid;
      known.add(txid);
      if (s.deliverIsLock) setTimeout(() => isLock(locks.at(-1)!, txid), 5);
      return { txid, node: 'n' };
    },
    /** A payment as the deposit stream sees it; `lock: false` leaves it unconfirmed until `confirm`. */
    pay(raw: Uint8Array, o: { lock?: boolean } = {}) {
      const tx = parseTx(raw);
      deposits.at(-1)!.onTx({ tx, raw, matches: tx.outputs.map((_, i) => i), node: 'n' });
      if (o.lock !== false) isLock(deposits.at(-1)!, tx.txid);
      return tx.txid;
    },
    confirm(txid: string) {
      deposits.at(-1)!.onBlock?.({ matched: [txid] } as never, 'n');
    },
  };
}

function fakePlatform(o: { refuseInstant?: boolean; onRefuse?: () => void; failWith?: unknown } = {}) {
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
      if (o.failWith) throw o.failWith;
      if (proof.kind === 'instant' && o.refuseInstant) {
        o.onRefuse?.();
        throw new Error('Invalid instant lock signature');
      }
      const txid = proof.kind === 'instant' ? parseTx(proof.tx).txid : proof.txid;
      created.set(identityIdFromOutpoint(txid, proof.creditIndex), proof);
    },
    topUpIdentity: async () => {},
    addKeys: async () => {},
    writeDocument: async () => ({ id: 'x' }),
    vault: { list: async () => [], byCredential: async () => null, put: async () => {}, remove: async () => {} },
  };
  return p;
}

const funderKey = hexToBytes('33'.repeat(32));
let funderTx = 0;
const payTo = (to: string, duffs: bigint) => {
  const h = hash160(SeedWallet.fromPhrase(PHRASE, 'testnet').derive(registrationFundingPath('testnet', 0)).publicKey);
  expect(addressOf(SeedWallet.fromPhrase(PHRASE, 'testnet').derive(registrationFundingPath('testnet', 0)).publicKey, 'testnet')).toBe(to);
  return buildPayment({ utxos: [{ txid: (++funderTx).toString(16).padStart(64, 'c'), vout: 0, value: 10_000_000n }], key: funderKey, to: [{ pubKeyHash: h, duffs }] }).raw;
};
const keyFor = (phrase: string) => fundingRecordKey('testnet', 'create', hash160(SeedWallet.fromPhrase(phrase, 'testnet').derive(registrationFundingPath('testnet', 0)).publicKey));

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
          dapi.pay(payTo(v.address, 1_000_000n));
        }
      },
    });
    expect(s.events.slice(0, 2)).toEqual(['watch-deposit', 'address-shown']);
    expect(s.events.indexOf('watch-lock')).toBeLessThan(s.events.indexOf('broadcast'));
    expect(platform.calls).toEqual(['instant']);
    const rec = store.m.get(keyFor(PHRASE))!;
    expect(rec.state).toBe('done');
    expect(rec.isLock).toMatch(/^01/);
    expect(rec.identityId).toBe(r.identityId);
    expect(rec.identityId).toBe(identityIdFromOutpoint(rec.lock!.txid, 0));
    // no key material in the record
    const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
    const json = JSON.stringify(rec);
    for (const secret of [w.derive(registrationFundingPath('testnet', 0)).privateKey, w.identityKey(0, 2).privateKey]) {
      expect(json).not.toContain(bytesToHex(secret));
      expect(json).not.toContain(wifOf(secret, 'testnet'));
    }
    expect(json).not.toContain(bytesToHex(w.entropy()));
  });

  it('counts a payment only once it is IS-locked or mined, and reports payments after the lock as late', async () => {
    const s: Script = { events: [], deliverIsLock: true, mined: 0 };
    const dapi = fakeDapi(s);
    const store = memStore();
    let unconfirmed = '';
    let shown = false;
    const views: FundingView[] = [];
    const run = runFunding({
      wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, isLockWaitMs: 2000,
      onUpdate: (v) => {
        views.push(v);
        if (v.state === 'awaiting-deposit' && !shown) {
          shown = true;
          unconfirmed = dapi.pay(payTo(v.address, 1_000_000n), { lock: false });
        }
      },
    });
    await new Promise((r) => setTimeout(r, 2500));
    expect(views.at(-1)!.state).toBe('awaiting-deposit');
    expect(views.at(-1)!.pendingDuffs).toBe(1_000_000n);
    expect(views.at(-1)!.receivedDuffs).toBe(0n);
    dapi.confirm(unconfirmed); // now it is in a block
    await new Promise((r) => setTimeout(r, 1700));
    const rec0 = store.m.get(keyFor(PHRASE))!;
    expect(rec0.lock).toBeDefined();
    dapi.pay(payTo(rec0.address, 70_000n)); // after the lock: late
    await run;
    const rec = store.m.get(keyFor(PHRASE))!;
    expect(rec.lateDeposits).toHaveLength(1);
    expect(views.at(-1)!.lateDuffs).toBe(70_000n);
  });

  it('falls back to a chain-lock proof when Platform refuses the IS-lock', async () => {
    const s: Script = { events: [], deliverIsLock: true, mined: 0 };
    const dapi = fakeDapi(s);
    const store = memStore();
    const platform = fakePlatform({ refuseInstant: true, onRefuse: () => (s.mined = 1500) });
    const r = await runFunding({
      wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform, store, kind: 'create', identityIndex: 0, isLockWaitMs: 2000, pollMs: 10,
      onUpdate: (v) => v.state === 'awaiting-deposit' && !v.receivedDuffs && !v.pendingDuffs && dapi.pay(payTo(v.address, 1_000_000n)),
    });
    expect(platform.calls).toEqual(['instant', 'chain']);
    expect((platform.created.get(r.identityId) as { coreChainLockedHeight: number }).coreChainLockedHeight).toBe(2000);
    expect(s.events.filter((e) => e === 'broadcast')).toHaveLength(1);
  });

  it('never re-sends a lock the network already knows, whatever state was saved (resume in "locking")', async () => {
    const s: Script = { events: [], deliverIsLock: false, mined: 0 };
    const dapi = fakeDapi(s);
    const store = memStore();
    const wallet = SeedWallet.fromPhrase(PHRASE, 'testnet');
    const ac = new AbortController();
    await runFunding({
      wallet, dapi: dapi as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, isLockWaitMs: 60_000, signal: ac.signal,
      onUpdate: (v) => {
        if (v.state === 'awaiting-deposit' && !v.receivedDuffs && !v.pendingDuffs) dapi.pay(payTo(v.address, 1_000_000n));
        if (v.state === 'locked') ac.abort();
      },
    }).catch(() => {});
    // the tab closed after the broadcast but before 'locked' was saved; meanwhile the lock was mined
    const rec = store.m.get(keyFor(PHRASE))!;
    store.save({ ...rec, state: 'locking' });
    s.mined = 1500;
    s.rejectNextBroadcast = 'bad-txns-inputs-missingorspent';
    s.rejectCount = 99;
    const platform = fakePlatform();
    await runFunding({ wallet, dapi: dapi as unknown as Dapi, platform, store, kind: 'create', identityIndex: 0, isLockWaitMs: 100, pollMs: 10 });
    expect(platform.calls).toEqual(['chain']);
    expect(s.events.filter((e) => e === 'broadcast')).toHaveLength(1);
    expect(store.m.get(keyFor(PHRASE))!.lock!.txid).toBe(rec.lock!.txid);
  });

  it('does not re-send or wait for an IS-lock when the lock is already mined', async () => {
    const s: Script = { events: [], deliverIsLock: false, mined: 0 };
    const dapi = fakeDapi(s);
    const store = memStore();
    const wallet = SeedWallet.fromPhrase(PHRASE, 'testnet');
    const ac = new AbortController();
    await runFunding({
      wallet, dapi: dapi as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, isLockWaitMs: 60_000, signal: ac.signal,
      onUpdate: (v) => {
        if (v.state === 'awaiting-deposit' && !v.receivedDuffs && !v.pendingDuffs) dapi.pay(payTo(v.address, 1_000_000n));
        if (v.state === 'locked') ac.abort();
      },
    }).catch(() => {});
    s.mined = 1500;
    const platform = fakePlatform();
    await runFunding({ wallet, dapi: dapi as unknown as Dapi, platform, store, kind: 'create', identityIndex: 0, isLockWaitMs: 100, pollMs: 10 });
    expect(platform.calls).toEqual(['chain']);
    expect(s.events.filter((e) => e === 'broadcast')).toHaveLength(1);
  });

  it('rebuilds the lock only when every attempt is refused and no node knows it', async () => {
    const s: Script = { events: [], deliverIsLock: true, mined: 0, rejectNextBroadcast: 'bad-txns-inputs-missingorspent', rejectCount: 3 };
    const dapi = fakeDapi(s);
    const store = memStore();
    let paid = 0;
    await runFunding({
      wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, isLockWaitMs: 2000,
      onUpdate: (v) => {
        if (v.state === 'awaiting-deposit' && !v.receivedDuffs && !v.pendingDuffs && paid < 2) {
          paid++;
          dapi.pay(payTo(v.address, 1_000_000n));
        }
      },
    });
    expect(paid).toBe(2);
    expect(s.events.filter((e) => e === 'broadcast')).toHaveLength(4); // three refusals of the first lock, then the rebuilt one
    const rec = store.m.get(keyFor(PHRASE))!;
    expect(rec.state).toBe('done');
    expect(rec.rejectedLocks).toHaveLength(1);
    expect(rec.rejectedLocks![0]).not.toBe(rec.lock!.txid);
  });

  it('a failed lookup is never taken for "the lock does not exist": no rebuild, the run stops and a resume retries', async () => {
    const s: Script = { events: [], deliverIsLock: false, mined: 0, rejectNextBroadcast: 'bad-txns-inputs-missingorspent', rejectCount: 99 };
    const dapi = fakeDapi(s);
    const store = memStore();
    let shown = false;
    const run = runFunding({
      wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, isLockWaitMs: 100, pollMs: 10,
      onUpdate: (v) => {
        if (v.state === 'awaiting-deposit' && !shown) {
          shown = true;
          dapi.pay(payTo(v.address, 1_000_000n));
        }
        if (v.state === 'locking' && v.lockTxid) s.lookupFails = true;
      },
    });
    await expect(run).rejects.toThrow(/upstream connect error/);
    const rec = store.m.get(keyFor(PHRASE))!;
    expect(rec.lock).toBeDefined();
    expect(rec.rejectedLocks ?? []).toHaveLength(0);
  });

  it('an IS-lock seen while the broadcast is being refused means the lock is out there: no rebuild', async () => {
    const s: Script = { events: [], deliverIsLock: false, mined: 1500, rejectNextBroadcast: 'bad-txns-inputs-missingorspent', rejectCount: 99, isLockOnRefusal: true };
    const dapi = fakeDapi(s);
    const store = memStore();
    const platform = fakePlatform();
    await runFunding({
      wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform, store, kind: 'create', identityIndex: 0, isLockWaitMs: 500, pollMs: 10,
      onUpdate: (v) => v.state === 'awaiting-deposit' && !v.receivedDuffs && !v.pendingDuffs && dapi.pay(payTo(v.address, 1_000_000n)),
    });
    const rec = store.m.get(keyFor(PHRASE))!;
    expect(rec.rejectedLocks ?? []).toHaveLength(0);
    expect(rec.isLock).toBeDefined();
    expect(platform.calls).toEqual(['instant']);
  });

  it('M5: a key conflict is its own error, and a transient error is never taken for "already used"', async () => {
    const store = memStore();
    const s: Script = { events: [], deliverIsLock: true, mined: 1500 };
    const dapi = fakeDapi(s);
    const conflict = Object.assign(new Error('DuplicatedIdentityPublicKeyStateError: public key already in use'), { code: 40206 });
    await expect(
      runFunding({
        wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform: fakePlatform({ failWith: conflict }), store, kind: 'create', identityIndex: 0, isLockWaitMs: 500, pollMs: 10,
        onUpdate: (v) => v.state === 'awaiting-deposit' && !v.receivedDuffs && !v.pendingDuffs && dapi.pay(payTo(v.address, 1_000_000n)),
      }),
    ).rejects.toThrow(/already registered to another identity/);
    expect(classifyRegistrationError(Object.assign(new Error('x'), { code: 10504 }))).toBe('used');
    expect(classifyRegistrationError(new Error('IdentityAlreadyExistsError: identity exists'))).toBe('used');
    expect(classifyRegistrationError(new Error('connection already closed'))).toBe('other');
    expect(classifyRegistrationError(new Error('the request has already been used by another stream'))).toBe('other');
    expect(classifyRegistrationError(new Error('InvalidInstantAssetLockProofSignatureError'))).toBe('instant-refused');
    // a transient error is surfaced on both proofs, never treated as success
    const s2: Script = { events: [], deliverIsLock: true, mined: 1500 };
    const d2 = fakeDapi(s2);
    const p2 = fakePlatform({ failWith: new Error('deadline exceeded; the request was already retried') });
    await expect(
      runFunding({
        wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: d2 as unknown as Dapi, platform: p2, store: memStore(), kind: 'create', identityIndex: 0, isLockWaitMs: 500, pollMs: 10,
        onUpdate: (v) => v.state === 'awaiting-deposit' && !v.receivedDuffs && !v.pendingDuffs && d2.pay(payTo(v.address, 1_000_000n)),
      }),
    ).rejects.toThrow(/Platform refused the registration/);
    expect(p2.calls).toEqual(['instant', 'chain']);
  });

  it('M1: refuses a lock below Platform minimum after fees and more than 100 inputs', () => {
    const k = hexToBytes('11'.repeat(32));
    const h = hash160(publicKeyOf(k));
    expect(() => buildAssetLock({ utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: BigInt(MIN_CREATE_LOCK_DUFFS) }], fundingKey: k, creditPubKeyHash: h, minLockDuffs: BigInt(MIN_CREATE_LOCK_DUFFS) })).toThrow(AssetLockError);
    const many = Array.from({ length: 101 }, (_, i) => ({ txid: i.toString(16).padStart(64, '0'), vout: 0, value: 10_000n }));
    expect(() => buildAssetLock({ utxos: many, fundingKey: k, creditPubKeyHash: h })).toThrow(/at most 100/);
  });

  it('M1: keeps waiting while the counted deposits would lock less than the minimum after fees', async () => {
    const s: Script = { events: [], deliverIsLock: true, mined: 0 };
    const dapi = fakeDapi(s);
    const store = memStore();
    const views: FundingView[] = [];
    let n = 0;
    const ac = new AbortController();
    const run = runFunding({
      wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, minDepositDuffs: 1, signal: ac.signal,
      onUpdate: (v) => {
        views.push(v);
        if (v.state === 'awaiting-deposit' && n++ === 0) dapi.pay(payTo(v.address, BigInt(MIN_CREATE_LOCK_DUFFS) + 10n)); // fee eats it
      },
    }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 300));
    expect(views.at(-1)!.state).toBe('awaiting-deposit');
    expect(views.at(-1)!.receivedDuffs).toBe(BigInt(MIN_CREATE_LOCK_DUFFS) + 10n);
    ac.abort();
    await run;
    expect(store.m.get(keyFor(PHRASE))!.lock).toBeUndefined();
  });
});

describe('H1: records per funding key', () => {
  it('two seeds in one browser never share a record; a stale record does not block another seed; discard only without payments', async () => {
    const store = memStore();
    // a stale, unpaid record of phrase B at identity index 0
    const ac = new AbortController();
    const dapiB = fakeDapi({ events: [], deliverIsLock: true, mined: 0 });
    const runB = runFunding({ wallet: SeedWallet.fromPhrase(PHRASE_B, 'testnet'), dapi: dapiB as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, signal: ac.signal, onUpdate: () => ac.abort() }).catch(() => {});
    await runB;
    expect(pendingFundings(store, 'testnet')).toHaveLength(1);
    // phrase A, same index, same store: its own record, completes
    const s: Script = { events: [], deliverIsLock: true, mined: 0 };
    const dapi = fakeDapi(s);
    await runFunding({
      wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, isLockWaitMs: 2000,
      onUpdate: (v) => v.state === 'awaiting-deposit' && !v.receivedDuffs && !v.pendingDuffs && dapi.pay(payTo(v.address, 1_000_000n)),
    });
    expect(store.m.size).toBe(2);
    expect(store.m.get(keyFor(PHRASE))!.state).toBe('done');
    // the unpaid stale one can be discarded, the paid one cannot
    expect(discardFunding(store, keyFor(PHRASE))).toBe(false);
    expect(discardFunding(store, keyFor(PHRASE_B))).toBe(true);
    expect(pendingFundings(store, 'testnet')).toHaveLength(0);
  });

  it('picks the next top-up index after the ones made in this browser', () => {
    const store = memStore();
    const id = 'FUfinhTAJRUff12BbJLZa7ZUqjJne8Xqyh9aiJdeKiXh';
    const base = { v: 2 as const, kind: 'topup' as const, network: 'testnet' as const, identityIndex: 0, identityId: id, address: 'y', deposits: [], createdAt: 0, updatedAt: 0 };
    expect(nextTopUpIndex(store, 'testnet', id)).toBe(0);
    store.save({ ...base, key: 'a', topUpIndex: 0, state: 'done' });
    store.save({ ...base, key: 'b', topUpIndex: 1, state: 'done' });
    expect(nextTopUpIndex(store, 'testnet', id)).toBe(2);
    store.save({ ...base, key: 'c', topUpIndex: 2, state: 'locked' });
    expect(nextTopUpIndex(store, 'testnet', id)).toBe(2);
  });
});

describe('H2: ended sessions', () => {
  const id = 'FUfinhTAJRUff12BbJLZa7ZUqjJne8Xqyh9aiJdeKiXh';
  it('sessionTopUpKey is deterministic, differs per index, and refuses a wiped (all-zero) key', () => {
    const k = hexToBytes('44'.repeat(32));
    expect(bytesToHex(sessionTopUpKey(k, id, 0).privateKey)).toBe(bytesToHex(sessionTopUpKey(k, id, 0).privateKey));
    expect(bytesToHex(sessionTopUpKey(k, id, 0).privateKey)).not.toBe(bytesToHex(sessionTopUpKey(k, id, 1).privateKey));
    expect(() => sessionTopUpKey(new Uint8Array(32), id, 0)).toThrow(/Sign in again/);
  });

  it('runFunding refuses a session that has ended', async () => {
    const s = makeSession({ network: 'testnet', identityId: id, identityIndex: null, keyId: 2, securityLevel: 2, source: 'key', privateKey: hexToBytes('44'.repeat(32)), wallet: null });
    s.end();
    expect(s.ended).toBe(true);
    await expect(
      runFunding({ wallet: null, session: s, dapi: fakeDapi({ events: [], deliverIsLock: false, mined: 0 }) as unknown as Dapi, platform: fakePlatform(), store: memStore(), kind: 'topup', identityIndex: 0, topUp: { identityId: id, index: 0 } }),
    ).rejects.toThrow(/ended/);
  });
});

describe('pickInputs', () => {
  it('a flood of dust cannot block a funding: largest outputs first, at most 100, dust skipped', () => {
    const dust = Array.from({ length: 150 }, (_, i) => ({ txid: String(i), value: '100' }));
    const real = { txid: 'real', value: '500000' };
    expect(pickInputs([...dust, real], BigInt(MIN_CREATE_LOCK_DUFFS), 201_000n)).toEqual([real]);
    expect(pickInputs(dust, 1n, 1n)).toBeNull();
    const many = Array.from({ length: 150 }, (_, i) => ({ txid: String(i), value: '5000' }));
    expect(pickInputs(many, BigInt(MIN_CREATE_LOCK_DUFFS), 201_000n)).toHaveLength(100);
  });
});
