// runFunding against a scripted DAPI and Platform: ordering (watch before showing the address, watch before broadcast), deposits
// counted only once IS-locked or mined, IS-lock persistence, the chain-lock fallback, resume without rebuilding the lock, records keyed
// per funding key (no collisions between seeds), error classification, ended sessions, and records that hold no secrets.
import { parseTx, type Dapi, type WatchHandlers } from '@govhub/dapi';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hash160, hexToBytes } from '../src/bytes.ts';
import {
  classifyRegistrationError, createFundingPath, discardFunding, FundingError, KeyConflictError, fundingRecordKey, LockTooSmallError, lockTooSmall, nextCreateIndex, nextTopUpIndex, pendingFundings, pickInputs, runFunding,
  sessionTopUpKey, stillNeededDuffs,
  type FundingRecord, type FundingStore, type FundingView,
} from '../src/funding.ts';
import { addressOf, publicKeyOf, wifOf } from '../src/keys.ts';
import {
  CREATE_KEYS, createRequiredCredits, MIN_CREATE_DEPOSIT_DUFFS, MIN_CREATE_LOCK_DUFFS, MIN_TOPUP_DEPOSIT_DUFFS, MIN_TOPUP_LOCK_DUFFS, topUpRequiredCredits,
} from '../src/layout.ts';
import type { AssetLockProofInput, PlatformPort } from '../src/platform.ts';
import { legacyRegistrationFundingPath, registrationFundingPath, SeedWallet, topUpFundingPath } from '../src/seed.ts';
import { makeSession } from '../src/signin.ts';
import { AssetLockError, buildAssetLock, buildPayment, estimateAssetLockFee, identityIdFromOutpoint } from '../src/tx.ts';

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
  /** Transactions nodes already know (mined at `mined`). */
  known?: string[];
}

/** A DAPI whose deposit watcher reports payments (IS-locked unless told otherwise) and which IS-locks whatever is broadcast. */
function fakeDapi(s: Script) {
  const deposits: WatchHandlers[] = [];
  const locks: WatchHandlers[] = [];
  let broadcast: Uint8Array | null = null;
  const known = new Set<string>(s.known ?? []);
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
    assetLockStatus: async () => 'unused',
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
    ).rejects.toBeInstanceOf(KeyConflictError);
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

// D-006: Platform's real floor (PV13 v4.1.1 = PV14 v5.0.0-rc.8): 2,000,000 base + 200,000 duffs x 1000 + 3 keys x 6,500,000.
describe('D-006: the create minimum is what Platform needs for the 3-key identity', () => {
  it('derives 221,500,000 credits (the number testnet refused a 209,646-duff lock with) and asks a depositor for more', () => {
    expect(CREATE_KEYS).toHaveLength(3);
    expect(createRequiredCredits(3)).toBe(221_500_000n);
    expect(topUpRequiredCredits()).toBe(50_500_000n);
    expect(MIN_CREATE_LOCK_DUFFS).toBe(221_500);
    expect(MIN_TOPUP_LOCK_DUFFS).toBe(50_500);
    // a single payment of the advertised amount locks at least the floor after the Core fee, with room for more payments
    expect(MIN_CREATE_DEPOSIT_DUFFS).toBe(224_000);
    expect(MIN_TOPUP_DEPOSIT_DUFFS).toBe(53_000);
    for (const [deposit, floor] of [[MIN_CREATE_DEPOSIT_DUFFS, MIN_CREATE_LOCK_DUFFS], [MIN_TOPUP_DEPOSIT_DUFFS, MIN_TOPUP_LOCK_DUFFS]] as const)
      expect(BigInt(deposit) - estimateAssetLockFee(10)).toBeGreaterThanOrEqual(BigInt(floor));
  });

  it('classifies "needs N credits to start processing" as permanent', () => {
    // as evo-sdk rc.8 threw it on testnet (a WasmSdkError: not an Error, code -1)
    const s3 = { name: 'ProtocolError', code: -1, message: 'Failed to create identity: Protocol error: Asset lock transaction [hex] output 0 only has 209646000 credits left out of 209646000 initial credits on the asset lock but needs 221500000 credits to start processing' };
    expect(classifyRegistrationError(s3)).toBe('too-small');
    expect(classifyRegistrationError({ code: 10530, message: 'x' })).toBe('too-small');
    expect(classifyRegistrationError(new Error('IdentityAssetLockTransactionOutPointNotEnoughBalanceError'))).toBe('too-small');
  });
});

/** A create record whose lock (built under the old 200,000-duff floor) holds `lockDuffs`, IS-locked and broadcast, as S3's s3-G left it. */
function stuckRecord(lockDuffs: bigint): FundingRecord {
  const fk = SeedWallet.fromPhrase(PHRASE, 'testnet').derive(registrationFundingPath('testnet', 0));
  const h = hash160(fk.publicKey);
  const dep = { txid: 'dd'.repeat(32), vout: 0, value: (lockDuffs + estimateAssetLockFee(1)).toString(), confirmed: true };
  const b = buildAssetLock({ utxos: [{ txid: dep.txid, vout: 0, value: BigInt(dep.value) }], fundingKey: fk.privateKey, creditPubKeyHash: h });
  expect(b.lockDuffs).toBe(lockDuffs);
  return {
    v: 2, key: keyFor(PHRASE), kind: 'create', network: 'testnet', identityIndex: 0, identityId: identityIdFromOutpoint(b.txid, b.creditIndex), address: addressOf(fk.publicKey, 'testnet'),
    watchFromHeight: 990, deposits: [dep], lock: { raw: bytesToHex(b.raw), txid: b.txid, creditIndex: b.creditIndex, burnVout: b.burnVout, lockDuffs: b.lockDuffs.toString(), feeDuffs: b.feeDuffs.toString() },
    isLock: '01' + 'ab'.repeat(100), proofKind: 'instant', state: 'registering', createdAt: 1, updatedAt: 1,
  };
}

/** A Platform with one existing identity whose balance a top-up raises by the lock's credits. */
function topUpPlatform(target: string, balance: bigint) {
  const base = fakePlatform();
  const topUps: Array<{ identityId: string; proof: AssetLockProofInput; keyHash: string }> = [];
  const balances = new Map([[target, balance]]);
  const p: PlatformPort & { topUps: typeof topUps; calls: string[] } = {
    ...base,
    calls: base.calls,
    topUps,
    balance: async (id) => balances.get(id) ?? null,
    identityKeys: async (id) => (balances.has(id) ? [] : null),
    topUpIdentity: async ({ identityId, proof, assetLockKey }) => {
      topUps.push({ identityId, proof, keyHash: bytesToHex(hash160(publicKeyOf(assetLockKey))) });
      balances.set(identityId, balances.get(identityId)! + 209_646_000n);
    },
  };
  return p;
}

describe('D-006: a lock too small to create an identity', () => {
  const S3_REFUSAL = { name: 'ProtocolError', code: -1, message: 'Failed to create identity: Protocol error: Asset lock transaction [hex] output 0 only has 1000000000 credits left out of 1000000000 initial credits on the asset lock but needs 1500000000 credits to start processing' };

  it('Platform refusing it is final: no chain-lock wait, no second proof, a LockTooSmallError with Platform\'s number', async () => {
    // never mined: a chain-lock wait would hang the test
    const s: Script = { events: [], deliverIsLock: true, mined: 0 };
    const dapi = fakeDapi(s);
    const platform = fakePlatform({ failWith: S3_REFUSAL });
    const t0 = Date.now();
    const e = await runFunding({
      wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform, store: memStore(), kind: 'create', identityIndex: 0, isLockWaitMs: 2000, pollMs: 10,
      onUpdate: (v) => v.state === 'awaiting-deposit' && !v.receivedDuffs && !v.pendingDuffs && dapi.pay(payTo(v.address, 1_000_000n)),
    }).catch((x) => x);
    expect(e).toBeInstanceOf(LockTooSmallError);
    expect(e).toBeInstanceOf(FundingError);
    expect((e as LockTooSmallError).requiredCredits).toBe(1_500_000_000n);
    expect((e as LockTooSmallError).canTopUp).toBe(true);
    expect(platform.calls).toEqual(['instant']);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('a stored lock below the floor is refused before anything is sent, and says it can still top up', async () => {
    const store = memStore();
    store.save(stuckRecord(209_646n));
    const platform = fakePlatform();
    const e = await runFunding({ wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: fakeDapi({ events: [], deliverIsLock: false, mined: 0 }) as unknown as Dapi, platform, store, kind: 'create', identityIndex: 0 }).catch((x) => x);
    expect(e).toBeInstanceOf(LockTooSmallError);
    expect((e as LockTooSmallError).lockCredits).toBe(209_646_000n);
    expect((e as LockTooSmallError).requiredCredits).toBe(221_500_000n);
    expect((e as Error).message).toMatch(/0\.00209646 DASH.*0\.002215 DASH.*top up an account that already exists/);
    expect(platform.calls).toEqual([]);
  });

  it('recoverInto spends the stored lock with its own key as a top-up of an existing identity, once', async () => {
    const target = '8GqCCpTFpgPREMUTqHESkuDMvkrfwBEd45fVeLUEYKYL';
    const store = memStore();
    const rec0 = stuckRecord(209_646n);
    store.save(rec0);
    const platform = topUpPlatform(target, 7n);
    const dapi = fakeDapi({ events: [], deliverIsLock: false, mined: 0 });
    const opts = { wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform, store, kind: 'create' as const, identityIndex: 0 };
    // an unknown identity is refused, and nothing is sent
    const missing = await runFunding({ ...opts, recoverInto: 'EzZz'.repeat(11) }).catch((x) => x);
    expect(missing).toBeInstanceOf(FundingError);
    expect((missing as Error).message).toMatch(/no identity/);
    expect(platform.topUps).toHaveLength(0);
    expect(store.m.get(keyFor(PHRASE))!.recoveredInto).toBeUndefined();

    const r = await runFunding({ ...opts, recoverInto: target });
    expect(r.identityId).toBe(target);
    expect(platform.topUps).toHaveLength(1);
    expect(platform.topUps[0]!.identityId).toBe(target);
    expect(platform.topUps[0]!.proof.kind).toBe('instant');
    expect(platform.topUps[0]!.keyHash).toBe(bytesToHex(hash160(SeedWallet.fromPhrase(PHRASE, 'testnet').derive(registrationFundingPath('testnet', 0)).publicKey)));
    expect(platform.calls).toEqual([]); // never a create
    const rec = store.m.get(keyFor(PHRASE))!;
    expect(rec).toMatchObject({ state: 'done', recoveredInto: target, balanceBefore: '7' });
    expect(pendingFundings(store, 'testnet')).toEqual([]);
    // the same lock is never pointed at a second identity
    store.save({ ...rec, state: 'registering' });
    await expect(runFunding({ ...opts, recoverInto: 'other' })).rejects.toThrow(/already being added to identity/);
  });

  it('recoverInto is refused before a lock exists', async () => {
    const store = memStore();
    const ac = new AbortController();
    const e = await runFunding({
      wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: fakeDapi({ events: [], deliverIsLock: false, mined: 0 }) as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, signal: ac.signal,
      onUpdate: () => ac.abort(),
    }).catch((x) => x);
    expect(e).not.toBeInstanceOf(LockTooSmallError);
    await expect(
      runFunding({ wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: fakeDapi({ events: [], deliverIsLock: false, mined: 0 }) as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, recoverInto: 'x' }),
    ).rejects.toThrow(/no unused asset lock/);
  });
});

describe('D-032: an underpayment asks only for what is missing', () => {
  it('received 0.001 of 0.00224: the view and the QR ask for 0.00124, and paying that finishes', async () => {
    const s: Script = { events: [], deliverIsLock: true, mined: 0 };
    const dapi = fakeDapi(s);
    const views: FundingView[] = [];
    let step = 0;
    const r = await runFunding({
      wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform: fakePlatform(), store: memStore(), kind: 'create', identityIndex: 0, isLockWaitMs: 2000,
      onUpdate: (v) => {
        views.push(v);
        if (v.state !== 'awaiting-deposit') return;
        if (step === 0) {
          step = 1;
          expect(v.remainingDuffs).toBe(224_000n);
          expect(v.uri).toBe(`dash:${v.address}?amount=0.00224`);
          dapi.pay(payTo(v.address, 100_000n));
        } else if (step === 1 && v.receivedDuffs === 100_000n) {
          step = 2;
          expect(v.remainingDuffs).toBe(124_000n);
          expect(v.uri).toBe(`dash:${v.address}?amount=0.00124`);
          dapi.pay(payTo(v.address, v.remainingDuffs));
        }
      },
    });
    expect(step).toBe(2);
    expect(r.record.state).toBe('done');
    expect(BigInt(r.record.lock!.lockDuffs)).toBeGreaterThanOrEqual(BigInt(MIN_CREATE_LOCK_DUFFS));
  });

  it('stillNeededDuffs: the minimum, the rest of it, the fee of one more input, never dust', () => {
    const min = BigInt(MIN_CREATE_DEPOSIT_DUFFS);
    const floor = BigInt(MIN_CREATE_LOCK_DUFFS);
    expect(stillNeededDuffs([], floor, min)).toBe(min);
    expect(stillNeededDuffs([{ value: '100000' }], floor, min)).toBe(124_000n);
    expect(stillNeededDuffs([{ value: '224000' }], floor, min)).toBe(0n);
    // enough in total but many inputs eat it in fees: one more payment covering the floor plus the bigger fee
    const many = Array.from({ length: 20 }, () => ({ value: '11200' }));
    const need = stillNeededDuffs(many, floor, min);
    expect(pickInputs([...many, { value: need.toString() }], floor, min)).not.toBeNull();
    expect(pickInputs([...many, { value: (need - 1n).toString() }], floor, min)).toBeNull();
    expect(stillNeededDuffs([{ value: '223990' }], floor, min)).toBeGreaterThan(estimateAssetLockFee(2) - estimateAssetLockFee(1));
  });
});

describe('D-006 review: recovery edge cases', () => {
  const target = '8GqCCpTFpgPREMUTqHESkuDMvkrfwBEd45fVeLUEYKYL';
  const w = () => SeedWallet.fromPhrase(PHRASE, 'testnet');
  const dapi = () => fakeDapi({ events: [], deliverIsLock: false, mined: 0 }) as unknown as Dapi;

  it('a balance change before anything was submitted is not taken for the top-up', async () => {
    const store = memStore();
    // pinned earlier with a baseline of 7; the identity was topped up by something else meanwhile (now 100)
    store.save({ ...stuckRecord(209_646n), recoveredInto: target, balanceBefore: '7', proofKind: undefined });
    const platform = topUpPlatform(target, 100n);
    const r = await runFunding({ wallet: w(), dapi: dapi(), platform, store, kind: 'create', identityIndex: 0 });
    expect(r.identityId).toBe(target);
    expect(platform.topUps).toHaveLength(1); // submitted, not skipped as "already landed"
  });

  it('a recovery whose lock Platform reports already used (from another device) says so instead of naming this identity', async () => {
    const store = memStore();
    store.save({ ...stuckRecord(209_646n), recoveredInto: target });
    const platform = topUpPlatform(target, 500n);
    platform.topUpIdentity = async () => {
      throw Object.assign(new Error('IdentityAssetLockTransactionOutPointAlreadyConsumedError'), { code: 10504 });
    };
    await expect(runFunding({ wallet: w(), dapi: dapi(), platform, store, kind: 'create', identityIndex: 0 })).rejects.toThrow(/already used.*another browser or device/);
    expect(store.m.get(keyFor(PHRASE))!.state).not.toBe('done');
  });

  it('an ordinary top-up Platform reports consumed has landed, even when the balance has since been spent below the baseline', async () => {
    const id = 'EmY5Lj9tq1pzJoNTi1KTyY9sLDWWmbnRczdHr1WAZjUW';
    const p = topUpPlatform(id, 500n);
    p.topUpIdentity = async () => {
      throw Object.assign(new Error('IdentityAssetLockTransactionOutPointAlreadyConsumedError'), { code: 10504 });
    };
    const s: Script = { events: [], deliverIsLock: true, mined: 0 };
    const d = fakeDapi(s);
    const r = await runFunding({
      wallet: w(), dapi: d as unknown as Dapi, platform: p, store: memStore(), kind: 'topup', identityIndex: 0, topUp: { identityId: id, index: 0 }, isLockWaitMs: 2000,
      onUpdate: (v) => v.state === 'awaiting-deposit' && !v.receivedDuffs && !v.pendingDuffs && d.pay(buildPayment({ utxos: [{ txid: 'ee'.repeat(32), vout: 0, value: 10_000_000n }], key: funderKey, to: [{ pubKeyHash: hash160(SeedWallet.fromPhrase(PHRASE, 'testnet').derive(topUpFundingPath('testnet', 0, 0)).publicKey), duffs: 100_000n }] }).raw),
    });
    expect(r.record.state).toBe('done');
  });

  it('a recovered record resumes (without recoverInto) as done for its target', async () => {
    const store = memStore();
    store.save({ ...stuckRecord(209_646n), recoveredInto: target, state: 'done' });
    const r = await runFunding({ wallet: w(), dapi: dapi(), platform: topUpPlatform(target, 1n), store, kind: 'create', identityIndex: 0 });
    expect(r).toMatchObject({ identityId: target, record: { recoveredInto: target } });
  });

  it('recoverInto is refused for a lock big enough to create, and once the create landed', async () => {
    const store = memStore();
    store.save(stuckRecord(300_000n));
    await expect(runFunding({ wallet: w(), dapi: dapi(), platform: topUpPlatform(target, 1n), store, kind: 'create', identityIndex: 0, recoverInto: target })).rejects.toThrow(/large enough/);
    const small = stuckRecord(209_646n);
    store.save(small);
    const p = topUpPlatform(target, 1n);
    p.identityKeys = async () => []; // every identity exists, the would-be created one too
    await expect(runFunding({ wallet: w(), dapi: dapi(), platform: p, store, kind: 'create', identityIndex: 0, recoverInto: target })).rejects.toThrow(/already created/);
    expect(store.m.get(small.key)!.recoveredInto).toBeUndefined();
  });

  it('a lock whose identity index is taken (KeyConflictError) can top up an existing identity; a free index still refuses', async () => {
    const store = memStore();
    store.save(stuckRecord(300_000n));
    const p = topUpPlatform(target, 1n);
    p.identityByUniqueKeyHash = async () => 'someone'; // the phrase's identity #0 exists (made on another device)
    const r = await runFunding({ wallet: w(), dapi: dapi(), platform: p, store, kind: 'create', identityIndex: 0, recoverInto: target });
    expect(r.identityId).toBe(target);
    expect(p.topUps).toHaveLength(1);
  });

  it('restore (the Recover tool) replaces a stale record, but resumes a lock this browser has in flight', async () => {
    const store = memStore();
    const s0 = stuckRecord(300_000n);
    // stale: a finished record for the key; the chain says the lock is unused -> replaced, registered with the chain proof
    store.save({ ...s0, state: 'done', lock: undefined, isLock: undefined });
    const restore: FundingRecord = { ...s0, isLock: undefined, proofKind: undefined, createdAt: 2, updatedAt: 2 };
    const p = fakePlatform();
    const r = await runFunding({ wallet: w(), dapi: fakeDapi({ events: [], deliverIsLock: false, mined: 1500, known: [s0.lock!.txid] }) as unknown as Dapi, platform: p, store, kind: 'create', identityIndex: 0, restore, pollMs: 10 });
    expect(r.identityId).toBe(s0.identityId);
    expect(p.calls).toEqual(['chain']);
    // in flight with its IS-lock: never replaced. Other funds at the address (a later payment) wait until it is finished, and nothing
    // is sent for them; the same lock is resumed as saved, so the instant proof is used.
    const store2 = memStore();
    store2.save(s0);
    const p2 = fakePlatform();
    const later = { ...restore, lock: undefined, state: 'awaiting-deposit' as const };
    await expect(runFunding({ wallet: w(), dapi: dapi(), platform: p2, store: store2, kind: 'create', identityIndex: 0, restore: later, recoverInto: target })).rejects.toThrow(/middle of a funding/);
    expect(p2.calls).toEqual([]);
    expect(store2.m.get(s0.key)!.isLock).toBe(s0.isLock);
    await runFunding({ wallet: w(), dapi: dapi(), platform: p2, store: store2, kind: 'create', identityIndex: 0, restore });
    expect(p2.calls).toEqual(['instant']);
    // a saved recovery into another identity is never turned into a create (or another target)
    const store3 = memStore();
    store3.save({ ...s0, recoveredInto: target });
    await expect(runFunding({ wallet: w(), dapi: dapi(), platform: p2, store: store3, kind: 'create', identityIndex: 0, restore })).rejects.toThrow(/already being added/);
    // a record for another key is refused
    await expect(runFunding({ wallet: w(), dapi: dapi(), platform: p2, store: memStore(), kind: 'create', identityIndex: 1, restore })).rejects.toThrow(/another key/);
  });

  it('restore lets the Recover tool turn an account setup\'s payments into a top-up before any lock (top-up minimum)', async () => {
    const store = memStore();
    const fk = w().derive(registrationFundingPath('testnet', 0));
    const restore: FundingRecord = {
      v: 2, key: keyFor(PHRASE), kind: 'create', network: 'testnet', identityIndex: 0, address: addressOf(fk.publicKey, 'testnet'), watchFromHeight: 990,
      deposits: [{ txid: 'ee'.repeat(32), vout: 0, value: '100000', confirmed: true }], state: 'awaiting-deposit', createdAt: 1, updatedAt: 1,
    };
    const s: Script = { events: [], deliverIsLock: true, mined: 0 };
    const p = topUpPlatform(target, 1n);
    const r = await runFunding({ wallet: w(), dapi: fakeDapi(s) as unknown as Dapi, platform: p, store, kind: 'create', identityIndex: 0, recoverInto: target, restore, isLockWaitMs: 2000 });
    expect(r.identityId).toBe(target);
    expect(p.topUps).toHaveLength(1);
    expect(p.calls).toEqual([]);
    // without the Recover tool, still refused before a lock exists
    await expect(runFunding({ wallet: w(), dapi: dapi(), platform: p, store: memStore(), kind: 'create', identityIndex: 0, recoverInto: target })).rejects.toThrow(/no unused asset lock/);
  });

  it('a record saved in "locking" without a lock under an older floor waits for more instead of failing', async () => {
    const store = memStore();
    const s0 = stuckRecord(209_646n);
    store.save({ ...s0, lock: undefined, isLock: undefined, proofKind: undefined, state: 'locking' });
    const views: FundingView[] = [];
    const ac = new AbortController();
    const e = await runFunding({
      wallet: w(), dapi: dapi(), platform: fakePlatform(), store, kind: 'create', identityIndex: 0, signal: ac.signal,
      onUpdate: (v) => (views.push(v), v.state === 'awaiting-deposit' && setTimeout(() => ac.abort(), 50)),
    }).catch((x) => x);
    expect(e).not.toBeInstanceOf(FundingError);
    expect(views.some((v) => v.state === 'awaiting-deposit')).toBe(true);
  });

  it('a lock under the floor that was never sent is dropped and rebuilt, not broadcast', async () => {
    const store = memStore();
    store.save({ ...stuckRecord(209_646n), isLock: undefined, proofKind: undefined, state: 'locking' });
    const s: Script = { events: [], deliverIsLock: false, mined: 0 };
    const ac = new AbortController();
    await runFunding({
      wallet: w(), dapi: fakeDapi(s) as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, signal: ac.signal,
      onUpdate: (v) => v.state === 'awaiting-deposit' && setTimeout(() => ac.abort(), 50),
    }).catch(() => {});
    expect(s.events).not.toContain('broadcast');
    expect(store.m.get(keyFor(PHRASE))!.lock).toBeUndefined();
  });

  it('a too-small top-up record does not hold the top-up index; a recovered create index is skipped for new identities', () => {
    const store = memStore();
    const rec: FundingRecord = { ...stuckRecord(50_000n), key: 'testnet.topup.x', kind: 'topup', identityId: target, topUpIndex: 0 };
    store.save(rec);
    expect(lockTooSmall(rec)).toBe(true);
    expect(nextTopUpIndex(store, 'testnet', target)).toBe(1);
    expect(nextCreateIndex(store, w())).toBe(0);
    store.save(stuckRecord(209_646n)); // index 0 holds a too-small lock
    expect(nextCreateIndex(store, w())).toBe(1);
    store.save({ ...stuckRecord(209_646n), recoveredInto: target, state: 'done' });
    expect(nextCreateIndex(store, w())).toBe(1);
    store.save({ ...stuckRecord(300_000n) });
    expect(nextCreateIndex(store, w())).toBe(0); // big enough: index 0 can still create
  });

  it('fromRefusal takes what Platform says is left; a voucher is never offered for a top-up', () => {
    const e = LockTooSmallError.fromRefusal('create', 300_000_000n, 221_500_000n, new Error('Asset lock transaction [hex] output 0 only has 100000000 credits left out of 300000000 initial credits on the asset lock but needs 221500000 credits to start processing'));
    expect(e.lockCredits).toBe(100_000_000n);
    expect(new LockTooSmallError('create', 209_646_000n, 221_500_000n, false).canTopUp).toBe(false);
    expect(new LockTooSmallError('create', 209_646_000n, 221_500_000n, false).message).not.toMatch(/top up/);
  });
});

describe('account-setup key: key-wallet path, and the hardened one used until 2026-10-25', () => {
  const w = () => SeedWallet.fromPhrase(PHRASE_B, 'testnet');
  const legacyKey = () => w().derive(legacyRegistrationFundingPath('testnet', 0));
  /** An unfinished create at the legacy address of identity #0, as a browser saved it before the change. */
  const legacyRecord = (patch: Partial<FundingRecord> = {}): FundingRecord => ({
    v: 2, key: fundingRecordKey('testnet', 'create', hash160(legacyKey().publicKey)), kind: 'create', network: 'testnet', identityIndex: 0,
    address: addressOf(legacyKey().publicKey, 'testnet'), watchFromHeight: 990, deposits: [], state: 'awaiting-deposit', createdAt: 1, updatedAt: 1, ...patch,
  });
  /** The address runFunding shows first, then stops. */
  const firstAddress = async (store: FundingStore, legacy?: boolean) => {
    const ac = new AbortController();
    let address = '';
    await runFunding({
      wallet: w(), dapi: fakeDapi({ events: [], deliverIsLock: true, mined: 0 }) as unknown as Dapi, platform: fakePlatform(), store, kind: 'create', identityIndex: 0, legacy, signal: ac.signal,
      onUpdate: (v) => {
        if (v.state === 'awaiting-deposit' && !address) {
          address = v.address;
          ac.abort();
        }
      },
    }).catch(() => {});
    return address;
  };

  it("a new account setup pays rs-platform-wallet's next registration address (IdentityRegistration pool index 0)", async () => {
    expect(await firstAddress(memStore())).toBe('yM5Wg7qxSi4sMiZuwrx37FxRdacdCyraaB');
  });

  it('an unfinished funding this browser began at the legacy address finishes there (end to end)', async () => {
    const store = memStore();
    store.save(legacyRecord());
    expect(createFundingPath(store, w(), 0)).toBe("m/9'/1'/5'/1'/0'");
    const s: Script = { events: [], deliverIsLock: true, mined: 0 };
    const dapi = fakeDapi(s);
    const platform = fakePlatform();
    let paid = false;
    const r = await runFunding({
      wallet: w(), dapi: dapi as unknown as Dapi, platform, store, kind: 'create', identityIndex: 0, isLockWaitMs: 2000,
      onUpdate: (v) => {
        if (v.state !== 'awaiting-deposit' || paid) return;
        paid = true;
        expect(v.address).toBe('yR8PUe4jSZ37A4HUtFwtLfe9WhB7braYG2');
        dapi.pay(buildPayment({ utxos: [{ txid: 'ce'.repeat(32), vout: 0, value: 10_000_000n }], key: funderKey, to: [{ pubKeyHash: hash160(legacyKey().publicKey), duffs: 1_000_000n }] }).raw);
      },
    });
    expect(r.record.key).toBe(legacyRecord().key);
    expect(r.record.state).toBe('done');
    expect(r.identityId).toBe(identityIdFromOutpoint(r.record.lock!.txid, 0));
  });

  it('a finished or discarded legacy record, or an explicit choice, leaves new fundings on the key-wallet path', async () => {
    for (const patch of [{ state: 'done' as const }, { discarded: true }]) {
      const store = memStore();
      store.save(legacyRecord(patch));
      expect(createFundingPath(store, w(), 0)).toBe("m/9'/1'/5'/1'/0");
    }
    const store = memStore();
    store.save(legacyRecord());
    expect(await firstAddress(store, false)).toBe('yM5Wg7qxSi4sMiZuwrx37FxRdacdCyraaB');
    expect(await firstAddress(memStore(), true)).toBe('yR8PUe4jSZ37A4HUtFwtLfe9WhB7braYG2');
  });

  it('nextCreateIndex skips an index whose legacy lock is too small, as before', () => {
    const store = memStore();
    const fk = legacyKey();
    const dep = { txid: 'dd'.repeat(32), vout: 0, value: (209_646n + estimateAssetLockFee(1)).toString(), confirmed: true };
    const b = buildAssetLock({ utxos: [{ txid: dep.txid, vout: 0, value: BigInt(dep.value) }], fundingKey: fk.privateKey, creditPubKeyHash: hash160(fk.publicKey) });
    store.save(legacyRecord({ deposits: [dep], lock: { raw: bytesToHex(b.raw), txid: b.txid, creditIndex: b.creditIndex, burnVout: b.burnVout, lockDuffs: b.lockDuffs.toString(), feeDuffs: b.feeDuffs.toString() }, state: 'registering' }));
    expect(nextCreateIndex(store, w())).toBe(1);
  });
});

describe('payments spent elsewhere', () => {
  it('a payment swept from another device (a confirmed spend) stops counting; an unconfirmed claim of a spend changes nothing', async () => {
    const s: Script = { events: [], deliverIsLock: true, mined: 0 };
    const dapi = fakeDapi(s);
    const views: FundingView[] = [];
    const ac = new AbortController();
    const fk = SeedWallet.fromPhrase(PHRASE, 'testnet').derive(registrationFundingPath('testnet', 0));
    let step = 0;
    await runFunding({
      wallet: SeedWallet.fromPhrase(PHRASE, 'testnet'), dapi: dapi as unknown as Dapi, platform: fakePlatform(), store: memStore(), kind: 'create', identityIndex: 0, signal: ac.signal,
      onUpdate: (v) => {
        views.push(v);
        if (v.state !== 'awaiting-deposit') return;
        if (step === 0) {
          step = 1;
          const dep = parseTx(payTo(v.address, 100_000n));
          dapi.pay(dep.raw);
          const sweep = buildPayment({ utxos: [{ txid: dep.txid, vout: 0, value: 100_000n }], key: fk.privateKey, to: [{ pubKeyHash: hash160(publicKeyOf(funderKey)), duffs: 99_500n }] }).raw; // no change output
          setTimeout(() => {
            dapi.pay(sweep, { lock: false }); // seen, not confirmed: still counted
            setTimeout(() => dapi.confirm(parseTx(sweep).txid), 20); // mined: gone
            setTimeout(() => ac.abort(), 60);
          }, 20);
        }
      },
    }).catch(() => {});
    const received = views.map((v) => v.receivedDuffs);
    expect(received).toContain(100_000n);
    expect(views.at(-1)!.receivedDuffs).toBe(0n);
    expect(views.some((v) => /spent by/.test(v.note ?? ''))).toBe(true);
  });
});
