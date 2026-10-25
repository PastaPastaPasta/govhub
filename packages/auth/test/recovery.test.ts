// The Recover tool's scan and actions against a scripted chain: discovery across the gap limits, only merkle-proven (and uncontradicted)
// transactions shown, spends netted out, asset locks checked against Platform's proved state, sweeps, and use through runFunding.
import { BloomFilter, parseTx, type Dapi, type Tx, type WatchHandlers } from '@govhub/dapi';
import { describe, expect, it } from 'vitest';
import { bytesToHex, concatBytes, hash160, hexToBytes, reversed, sha256d, u32le } from '../src/bytes.ts';
import { fundingRecordKey, type FundingRecord, type FundingStore } from '../src/funding.ts';
import { addressOf, publicKeyOf, wifOf } from '../src/keys.ts';
import { MIN_CREATE_DEPOSIT_DUFFS } from '../src/layout.ts';
import type { AssetLockProofInput } from '../src/platform.ts';
import {
  exportItemWif, forgetSpent, itemOptions, parseDashAddress, replayProven, RecoveryError, scanForFunds, sweepItem, fundWithItem, type KeyFamily, type RecoveryScan,
} from '../src/recovery.ts';
import { registrationFundingPath, SeedWallet, topUpFundingPath } from '../src/seed.ts';
import { makeSession } from '../src/signin.ts';
import { buildAssetLock, buildPayment, identityIdFromOutpoint, p2pkhScript } from '../src/tx.ts';
import { sessionTopUpKey } from '../src/funding.ts';
import { FakePlatform } from './fake-platform.ts';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NET = 'testnet' as const;
const BASE = 1_000_000;
const wallet = () => SeedWallet.fromPhrase(PHRASE, NET);
const pub = (path: string) => wallet().derive(path).publicKey;
const createPub = (i: number) => pub(registrationFundingPath(NET, i));
const topUpPub = (i: number, n: number) => pub(topUpFundingPath(NET, i, n));

const funder = hexToBytes('44'.repeat(32));
let seq = 0;
/** A payment of `duffs` to `toPub` from a stranger's coin. */
const pay = (toPub: Uint8Array, duffs: bigint): Tx =>
  parseTx(buildPayment({ utxos: [{ txid: (++seq).toString(16).padStart(64, 'f'), vout: 0, value: 50_000_000n }], key: funder, to: [{ pubKeyHash: hash160(toPub), duffs }] }).raw);

// ---- a scripted chain on scripted DAPI nodes -------------------------------------------------------------------------------

/** BIP37 partial merkle tree over `leaves` (internal order) with `match` flagged, serialized after an 80-byte header. */
function merkleBlock(leaves: Uint8Array[], match: (i: number) => boolean, rootOverride?: Uint8Array): Uint8Array {
  const total = leaves.length;
  let height = 0;
  while (((total + (1 << height) - 1) >> height) > 1) height++;
  const width = (h: number) => (total + (1 << h) - 1) >> h;
  const calc = (h: number, pos: number): Uint8Array => {
    if (h === 0) return leaves[pos]!;
    const l = calc(h - 1, pos * 2);
    const r = pos * 2 + 1 < width(h - 1) ? calc(h - 1, pos * 2 + 1) : l;
    return sha256d(concatBytes(l, r));
  };
  const hashes: Uint8Array[] = [];
  const bits: number[] = [];
  const walk = (h: number, pos: number) => {
    let parent = false;
    for (let p = pos << h; p < (pos + 1) << h && p < total; p++) parent ||= match(p);
    bits.push(parent ? 1 : 0);
    if (h === 0 || !parent) hashes.push(calc(h, pos));
    else {
      walk(h - 1, pos * 2);
      if (pos * 2 + 1 < width(h - 1)) walk(h - 1, pos * 2 + 1);
    }
  };
  walk(height, 0);
  const flags = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => (flags[i >> 3]! |= b << (i & 7)));
  const header = new Uint8Array(80);
  header.set(rootOverride ?? calc(height, 0), 36);
  return concatBytes(header, u32le(total), Uint8Array.of(hashes.length), ...hashes, Uint8Array.of(flags.length), flags);
}

interface Chain {
  /** Transactions per height (BASE + index). */
  blocks: Tx[][];
  /** Nodes that misbehave on the stream. */
  liars?: Record<string, { unproven?: Tx[]; badRoot?: boolean; fakeProven?: Tx[]; /** ends the stream after this many blocks */ stopAfter?: number }>;
  /** txids the unary getTransaction does not know (a contradiction). */
  unknown?: Set<string>;
  broadcasts?: Uint8Array[];
  replays?: string[];
}

function fakeDapi(c: Chain, nodes = ['honest:1', 'honest:2']) {
  const filterOf = (f: { vData: Uint8Array; nHashFuncs: number; nTweak: number; nFlags: number }) => {
    const bf = new BloomFilter(1, 0.0001, f.nTweak, f.nFlags);
    bf.vData = f.vData;
    bf.nHashFuncs = f.nHashFuncs;
    return bf;
  };
  const relevant = (bf: BloomFilter, tx: Tx) =>
    tx.outputs.some((o) => o.script.length === 25 && bf.contains(o.script.subarray(3, 23))) || tx.inputs.some((i) => i.script.length > 33 && bf.contains(i.script.subarray(i.script.length - 33)));
  const heightOf = (txid: string) => c.blocks.findIndex((b) => b.some((t) => t.txid === txid));
  const all = () => c.blocks.flat();
  const lockWatchers: WatchHandlers[] = [];
  const unary = {
    getBestBlockHeight: async () => BASE + c.blocks.length - 1,
    getTransaction: async (txid: string) => {
      const tx = all().find((t) => t.txid === txid);
      if (!tx || c.unknown?.has(txid)) throw Object.assign(new Error('not found'), { code: 5 });
      return { raw: tx.raw, height: BASE + heightOf(txid), confirmations: 1, blockHash: 'aa', isInstantLocked: true, isChainLocked: true };
    },
  };
  const d = {
    network: NET,
    options: {},
    ready: async () => nodes,
    pool: {
      size: nodes.length,
      pick: (n: number, exclude: Iterable<string> = []) => nodes.filter((x) => ![...exclude].includes(x)).slice(0, n),
      charge: () => {},
      fail: () => {},
      ok: () => {},
    },
    core: (node: string) => ({
      subscribeToTransactionsWithProofs: (f: never, s: { fromHeight: number; count: number }, onEvent: (e: unknown) => void) => {
        c.replays?.push(`${node}@${s.fromHeight}+${s.count}`);
        const bf = filterOf(f);
        const liar = c.liars?.[node];
        const end = Math.min(s.fromHeight + s.count, s.fromHeight + (liar?.stopAfter ?? Infinity));
        for (let h = s.fromHeight; h < end && h - BASE < c.blocks.length; h++) {
          const txs = [...(c.blocks[h - BASE] ?? [])];
          const extra = h === s.fromHeight ? (liar?.fakeProven ?? []) : [];
          txs.push(...extra);
          const hits = txs.filter((t) => relevant(bf, t) || extra.includes(t));
          if (hits.length) onEvent({ type: 'rawtxs', txs: hits.map((t) => t.raw) });
          if (liar?.unproven && h === s.fromHeight) onEvent({ type: 'rawtxs', txs: liar.unproven.map((t) => t.raw) });
          const leaves = txs.length ? txs.map((t) => reversed(hexToBytes(t.txid))) : [sha256d(u32le(h))];
          onEvent({ type: 'merkleblock', merkleBlock: merkleBlock(leaves, (i) => hits.includes(txs[i]!), liar?.badRoot && hits.length ? new Uint8Array(32).fill(7) : undefined) });
        }
        return { cancel: () => {}, closed: Promise.resolve({ reason: 'end', status: null }) };
      },
      getTransaction: unary.getTransaction,
    }),
    call: async (fn: (core: typeof unary) => Promise<unknown>) => ({ value: await fn(unary), node: 'honest:1' }),
    broadcastTransaction: async (raw: Uint8Array) => {
      (c.broadcasts ??= []).push(raw);
      const tx = parseTx(raw);
      const spent = new Set(all().flatMap((t) => t.inputs.map((i) => `${i.prevTxid}:${i.vout}`)));
      if (tx.inputs.some((i) => spent.has(`${i.prevTxid}:${i.vout}`))) throw new Error('bad-txns-inputs-missingorspent');
      c.blocks.push([tx]);
      // the lock watcher hears the asset lock's IS-lock
      if (tx.type === 8) for (const h of lockWatchers) void h.onIsLock({ lock: { txid: tx.txid } as never, bytes: hexToBytes('01' + 'ab'.repeat(100)), known: true, node: 'n' });
      return { txid: tx.txid, node: 'honest:1' };
    },
    watchAddressForDeposit: async (_h: Uint8Array, _w: WatchHandlers) => ({ cancel: () => {} }),
    watchTransactions: async (_f: unknown, h: WatchHandlers) => (lockWatchers.push(h), { cancel: () => {} }),
  };
  return d as unknown as Dapi & { broadcastTransaction: typeof d.broadcastTransaction };
}

/** A platform whose phrase has identity #0, which proves asset-lock use, and records registrations. */
function platformWithIdentity0() {
  const p = new FakePlatform(NET) as FakePlatform & { created: Map<string, AssetLockProofInput>; topUps: Array<{ identityId: string; proof: AssetLockProofInput }> };
  const w = wallet();
  p.addIdentity('id0', [0, 1, 2].map((k) => ({ id: k, purpose: 0, securityLevel: k, priv: w.identityKey(0, k).privateKey })));
  p.balances.set('id0', 0n);
  p.created = new Map();
  p.topUps = [];
  p.createIdentity = async ({ proof }) => {
    const txid = proof.kind === 'instant' ? parseTx(proof.tx).txid : proof.txid;
    p.created.set(identityIdFromOutpoint(txid, proof.creditIndex), proof);
    p.usedLocks.set(`${txid}:${proof.creditIndex}`, 'used');
    p.identities.set(identityIdFromOutpoint(txid, proof.creditIndex), []);
  };
  p.topUpIdentity = async ({ identityId, proof }) => {
    const txid = proof.kind === 'instant' ? parseTx(proof.tx).txid : proof.txid;
    if (p.usedLocks.has(`${txid}:${proof.creditIndex}`)) throw Object.assign(new Error('already consumed'), { code: 10504 });
    p.usedLocks.set(`${txid}:${proof.creditIndex}`, 'used');
    p.topUps.push({ identityId, proof });
    p.balances.set(identityId, (p.balances.get(identityId) ?? 0n) + 1n);
  };
  p.coreChainLockedHeight = async () => BASE + 10_000;
  return p;
}

function memStore(): FundingStore & { m: Map<string, FundingRecord> } {
  const m = new Map<string, FundingRecord>();
  return { m, load: (k) => structuredClone(m.get(k) ?? null), save: (r) => void m.set(r.key, structuredClone(r)), remove: (k) => void m.delete(k), list: () => [...m.values()] };
}

const scan = (dapi: Dapi, platform: FakePlatform, o: Partial<Parameters<typeof scanForFunds>[0]> = {}) =>
  scanForFunds({ secret: { wallet: wallet() }, dapi, platform, fromHeight: BASE, chunk: 4, ...o });

// ---- tests ---------------------------------------------------------------------------------------------------------------

describe('scan: discovery across the gap limits', () => {
  it('covers every index within the gap limit of a used one (with lookahead), and stops after a full gap of unused ones', async () => {
    // identity #0 exists. Create lane: needs 0..5 (index 0 + gap 5), takes 0..10; 3 and 7 used -> needs 0..12, takes 0..17; 13 used
    // (5 unused before it, within the gap of 7) -> needs 0..18, takes 0..23; 25 lies past a full gap of unused ones: never found.
    // Top-ups of #0: take 0..9; 4 and 8 used -> need 0..13, take 0..18; 30 never.
    const c: Chain = {
      blocks: [
        [pay(createPub(3), 100_000n)],
        [pay(createPub(7), 200_000n)],
        [pay(createPub(13), 300_000n), pay(createPub(25), 1_000_000n)],
        [pay(topUpPub(0, 4), 60_000n), pay(topUpPub(0, 8), 70_000n)],
        [pay(topUpPub(0, 30), 80_000n)],
      ],
      replays: [],
    };
    const r = await scan(fakeDapi(c), platformWithIdentity0());
    const found = r.items.map((i) => `${i.family}:${i.index}:${i.duffs}`).sort();
    expect(found).toEqual(['create:13:300000', 'create:3:100000', 'create:7:200000', 'topup:4:60000', 'topup:8:70000']);
    expect(r.identities.map((i) => i.identityIndex)).toEqual([0]);
    expect(r.keysScanned).toBe(24 + 19);
    expect(r.provenDuffs).toBe(730_000n);
    expect(r.items.every((i) => i.type === 'payments' && i.payments.every((p) => p.height! >= BASE))).toBe(true);
  });

  it('a pasted key scans its own top-up keys (HMAC lane) and no seed lane', async () => {
    const sk = hexToBytes('55'.repeat(32));
    const id = '4EfA9Jrvv3nnCFdSf7fad59851iiTRZ6Wcu6YVJ4iSeF';
    const k2 = sessionTopUpKey(sk, id, 2);
    const c: Chain = { blocks: [[pay(k2.publicKey, 90_000n)], [pay(createPub(0), 300_000n)]] };
    const session = makeSession({ network: NET, identityId: id, identityIndex: null, keyId: 2, securityLevel: 2, source: 'key', privateKey: sk.slice(), wallet: null });
    const r = await scanForFunds({ secret: { session }, dapi: fakeDapi(c), platform: new FakePlatform(NET), fromHeight: BASE });
    expect(r.items.map((i) => `${i.family}:${i.index}`)).toEqual(['key-topup:2']);
    expect(r.items[0]!.address).toBe(addressOf(k2.publicKey, NET));
    expect(r.items[0]!.funding).toEqual({ kind: 'topup', identityIndex: 0, identityId: id, session: true });
  });

  it('plugs in another key family (sweep only) next to the defaults', async () => {
    const other = hexToBytes('66'.repeat(32));
    const fee: KeyFamily = () => [
      {
        family: 'fee',
        label: 'Proposal fee',
        gap: 2,
        derive: (i) => {
          const k = i === 1 ? other.slice() : hexToBytes((0x70 + i).toString(16).repeat(32));
          return { privateKey: k, publicKey: publicKeyOf(k) };
        },
        path: (i) => `m/test/${i}`,
        funding: () => null,
      },
    ];
    const c: Chain = { blocks: [[pay(publicKeyOf(other), 400_000n)]] };
    const r = await scan(fakeDapi(c), platformWithIdentity0(), { families: [fee] });
    expect(r.items.map((i) => `${i.family}:${i.index}`)).toEqual(['fee:1']);
    const o = itemOptions(r.items[0]!, r);
    expect(o.sweep).not.toBeNull();
    expect(o.create).toBeNull();
    expect(o.topUp).toBeNull();
  });
});

describe('scan: what is still there', () => {
  it('nets out spends: a deposit locked or swept is gone; a later payment to the same address is not', async () => {
    const w = wallet();
    const k = w.derive(registrationFundingPath(NET, 1));
    const d1 = pay(k.publicKey, 300_000n);
    const lock = parseTx(buildAssetLock({ utxos: [{ txid: d1.txid, vout: 0, value: 300_000n }], fundingKey: k.privateKey, creditPubKeyHash: hash160(k.publicKey) }).raw);
    const late = pay(k.publicKey, 50_000n);
    const p = platformWithIdentity0();
    p.usedLocks.set(`${lock.txid}:0`, 'used');
    const r = await scan(fakeDapi({ blocks: [[d1], [lock], [late]] }), p);
    expect(r.items.map((i) => `${i.type}:${i.duffs}`)).toEqual(['payments:50000']);
    expect(r.usedLocks).toBe(1);
  });

  it('finds an asset lock Platform never used (proved), a partly used one, and leaves used ones out', async () => {
    const w = wallet();
    const mk = (i: number, v: bigint) => {
      const k = w.derive(registrationFundingPath(NET, i));
      const d = pay(k.publicKey, v);
      return [d, parseTx(buildAssetLock({ utxos: [{ txid: d.txid, vout: 0, value: v }], fundingKey: k.privateKey, creditPubKeyHash: hash160(k.publicKey) }).raw)] as const;
    };
    const [d1, l1] = mk(1, 250_000n);
    const [d2, l2] = mk(2, 210_000n);
    const [d3, l3] = mk(3, 400_000n);
    const p = platformWithIdentity0();
    p.usedLocks.set(`${l2.txid}:0`, 'partial');
    p.usedLocks.set(`${l3.txid}:0`, 'used');
    const r = await scan(fakeDapi({ blocks: [[d1, l1], [d2, l2], [d3, l3]] }), p);
    const locks = r.items.filter((i) => i.type === 'lock');
    expect(locks.map((i) => [i.index, i.lock!.status])).toEqual([
      [1, 'unused'],
      [2, 'partial'],
    ]);
    expect(r.usedLocks).toBe(1);
    // proven: only the unused one counts
    expect(r.provenDuffs).toBe(locks[0]!.duffs);
    // a partly used lock: its remainder is unknown, so only a top-up is offered
    const po = itemOptions(locks[1]!, r);
    expect(po.create).toBeNull();
    expect(po.topUp).toBe('any');
    const o = itemOptions(locks[0]!, r);
    expect(o.sweep).toBeNull();
    expect(o.notes.join(' ')).toMatch(/never sent back to a Dash address/);
    expect(o.create).toBe(1);
    expect(o.topUp).toBe('any');
  });

  it('a tampered claim is never shown: no merkle proof, a bad merkle root, or a second node that does not know it', async () => {
    const real = pay(createPub(0), 300_000n);
    const unproven = pay(createPub(1), 9_000_000n);
    const fake = pay(createPub(2), 8_000_000n);
    const c: Chain = {
      blocks: [[real], []],
      liars: { 'liar:1': { unproven: [unproven], fakeProven: [fake] }, 'liar:2': { badRoot: true } },
      unknown: new Set([fake.txid]),
      replays: [],
    };
    // liar:2 serves the first chunk (bad root: replayed elsewhere), liar:1 the rest
    const dapi = fakeDapi(c, ['liar:2', 'liar:1', 'honest:1']);
    const r = await scanForFunds({ secret: { wallet: wallet() }, dapi, platform: new FakePlatform(NET), fromHeight: BASE, chunk: 100 });
    expect(r.items.map((i) => i.payments.map((p) => p.txid)).flat()).toEqual([real.txid]);
    expect(r.dropped).toBeGreaterThanOrEqual(2);
    expect(c.replays![0]).toMatch(/^liar:2@/);
    expect(c.replays![1]).toMatch(/^liar:1@/);
  });

  it('a node that ends the stream early never makes the scan look complete: the chunk is replayed elsewhere', async () => {
    const blocks: Tx[][] = Array.from({ length: 10 }, () => []);
    blocks[8] = [pay(createPub(0), 300_000n)];
    const c: Chain = { blocks, liars: { 'lazy:1': { stopAfter: 3 } }, replays: [] };
    const r = await scanForFunds({ secret: { wallet: wallet() }, dapi: fakeDapi(c, ['lazy:1', 'honest:1', 'honest:2']), platform: new FakePlatform(NET), fromHeight: BASE, chunk: 100 });
    expect(r.items.map((i) => i.duffs)).toEqual([300_000n]);
    expect(c.replays!.slice(0, 2)).toEqual([`lazy:1@${BASE}+10`, `honest:1@${BASE}+10`]);
    expect(r.toHeight).toBe(BASE + 9);
    // a last chunk a block or two short of the reported tip is accepted, and the scan says how far it got
    const lag: Chain = { blocks, liars: { 'lag:1': { stopAfter: 8 } } };
    const r2 = await scanForFunds({ secret: { wallet: wallet() }, dapi: fakeDapi(lag, ['lag:1', 'honest:1']), platform: new FakePlatform(NET), fromHeight: BASE, chunk: 100 });
    expect(r2.toHeight).toBe(BASE + 7);
  });

  it('replayProven keeps only transactions a valid merkleblock proves', async () => {
    const real = pay(createPub(0), 1n);
    const fake = pay(createPub(0), 2n);
    const f = new BloomFilter(2).insert(hash160(createPub(0))).toJSON();
    const r = await replayProven(fakeDapi({ blocks: [[real]], liars: { 'liar:1': { unproven: [fake] } } }, ['liar:1']), f, BASE, BASE);
    expect([...r.txs.keys()]).toEqual([real.txid]);
    expect(r.dropped).toBe(1);
  });
});

describe('sweep', () => {
  it('checks the network prefix of the destination', () => {
    const h = hash160(publicKeyOf(funder));
    expect(parseDashAddress(addressOf(publicKeyOf(funder), NET), NET).hash160).toEqual(h);
    expect(() => parseDashAddress(addressOf(publicKeyOf(funder), 'mainnet'), NET)).toThrow(/mainnet address; these funds are on testnet/);
    expect(() => parseDashAddress(addressOf(publicKeyOf(funder), NET), 'mainnet')).toThrow(/testnet address; these funds are on mainnet/);
    expect(() => parseDashAddress('tdash1qqqqqq', NET)).toThrow(/not a Dash address/);
    expect(() => parseDashAddress(wifOf(funder, NET), NET)).toThrow(/not a Dash address/);
  });

  it('sends every payment of the address to the destination less the fee, then forgets them in this browser', async () => {
    const d1 = pay(createPub(2), 30_000n);
    const d2 = pay(createPub(2), 20_000n);
    const c: Chain = { blocks: [[d1], [d2]] };
    const dapi = fakeDapi(c);
    const r = await scan(dapi, platformWithIdentity0());
    const item = r.items[0]!;
    const store = memStore();
    const recKey = fundingRecordKey(NET, 'create', hexToBytes(item.keyHash));
    store.save({ v: 2, key: recKey, kind: 'create', network: NET, identityIndex: 2, address: item.address, deposits: [{ txid: d1.txid, vout: 0, value: '30000', confirmed: true }], state: 'awaiting-deposit', createdAt: 0, updatedAt: 0 });
    const to = addressOf(publicKeyOf(funder), NET);
    const s = await sweepItem({ item, scan: r, secret: { wallet: wallet() }, to, dapi, store });
    const tx = parseTx(c.broadcasts![0]!);
    expect(tx.txid).toBe(s.txid);
    expect(tx.inputs.map((i) => `${i.prevTxid}:${i.vout}`).sort()).toEqual([`${d1.txid}:0`, `${d2.txid}:0`].sort());
    expect(tx.outputs).toHaveLength(1);
    expect(bytesToHex(tx.outputs[0]!.script)).toBe(bytesToHex(p2pkhScript(hash160(publicKeyOf(funder)))));
    expect(tx.outputs[0]!.value).toBe(50_000n - s.feeDuffs);
    expect(s.feeDuffs).toBeGreaterThanOrEqual(BigInt(tx.raw.length));
    expect(s.feeDuffs).toBeLessThan(BigInt(tx.raw.length) + 10n);
    // the browser's record no longer counts the swept payment, and is hidden (nothing left to lock)
    expect(store.m.get(recKey)!.deposits).toEqual([]);
    expect(store.m.get(recKey)!.discarded).toBe(true);
    // a second sweep of the same item is refused by the network: nothing is sent twice
    await expect(sweepItem({ item, scan: r, secret: { wallet: wallet() }, to, dapi })).rejects.toThrow(/already spent/);
  });

  it('refuses dust, asset locks, another network, and a phrase that does not hold the address', async () => {
    const tiny = pay(createPub(1), 700n);
    const r = await scan(fakeDapi({ blocks: [[tiny]] }), platformWithIdentity0());
    const item = r.items[0]!;
    expect(itemOptions(item, r).sweep).toBeNull();
    const to = addressOf(publicKeyOf(funder), NET);
    await expect(sweepItem({ item, scan: r, secret: { wallet: wallet() }, to, dapi: fakeDapi({ blocks: [] }) })).rejects.toThrow(/dust/);
    await expect(sweepItem({ item: { ...item, type: 'lock' }, scan: r, secret: { wallet: wallet() }, to, dapi: fakeDapi({ blocks: [] }) })).rejects.toThrow(/cannot be sent to an address/);
    await expect(sweepItem({ item, scan: r, secret: { wallet: wallet() }, to: addressOf(publicKeyOf(funder), 'mainnet'), dapi: fakeDapi({ blocks: [] }) })).rejects.toThrow(RecoveryError);
    const otherPhrase = SeedWallet.fromPhrase('legal winner thank year wave sausage worth useful legal winner thank yellow', NET);
    await expect(sweepItem({ item, scan: r, secret: { wallet: otherPhrase }, to, dapi: fakeDapi({ blocks: [] }) })).rejects.toThrow(/does not hold that address/);
  });

  it('exports the one-time key as WIF only for the key that holds the item', async () => {
    const r = await scan(fakeDapi({ blocks: [[pay(createPub(1), 70_000n)]] }), platformWithIdentity0());
    expect(exportItemWif({ item: r.items[0]!, scan: r, secret: { wallet: wallet() } })).toBe(wifOf(wallet().derive(registrationFundingPath(NET, 1)).privateKey, NET));
  });

  it('forgetSpent drops late payments too and keeps a finished record visible', () => {
    const store = memStore();
    store.save({ v: 2, key: 'k', kind: 'topup', network: NET, identityIndex: 0, address: 'y', deposits: [], lateDeposits: [{ txid: 'aa', vout: 1, value: '5' }], state: 'done', createdAt: 0, updatedAt: 0 });
    forgetSpent(store, 'k', [{ txid: 'aa', vout: 1 }]);
    expect(store.m.get('k')!.lateDeposits).toBeUndefined();
    expect(store.m.get('k')!.discarded).toBeUndefined();
  });
});

describe('use on Platform', () => {
  /** A scan whose only item is an unused create lock at index 1, mined in the chain. */
  async function lockAt1(v = 250_000n) {
    const w = wallet();
    const k = w.derive(registrationFundingPath(NET, 1));
    const d = pay(k.publicKey, v);
    const lock = parseTx(buildAssetLock({ utxos: [{ txid: d.txid, vout: 0, value: v }], fundingKey: k.privateKey, creditPubKeyHash: hash160(k.publicKey) }).raw);
    const c: Chain = { blocks: [[d], [lock]] };
    const dapi = fakeDapi(c);
    const platform = platformWithIdentity0();
    const r: RecoveryScan = await scan(dapi, platform);
    return { dapi, platform, r, lock, item: r.items.find((i) => i.type === 'lock')! };
  }

  it('finishes creating the account from an unused lock on a fresh device (chain proof), and saves the finished record', async () => {
    const { dapi, platform, r, lock, item } = await lockAt1();
    const store = memStore();
    const out = await fundWithItem({ item, scan: r, secret: { wallet: wallet() }, target: { create: true }, dapi, platform, store });
    expect(out.identityId).toBe(identityIdFromOutpoint(lock.txid, 0));
    expect(platform.created.get(out.identityId)).toMatchObject({ kind: 'chain', txid: lock.txid, creditIndex: 0 });
    expect(store.m.get(fundingRecordKey(NET, 'create', hexToBytes(item.keyHash)))!.state).toBe('done');
  });

  it('refuses to create when the identity was made since the scan (it would be a key conflict)', async () => {
    const { dapi, platform, r, item } = await lockAt1();
    const w = wallet();
    platform.addIdentity('made-elsewhere', [0, 1, 2].map((k) => ({ id: k, purpose: 0, securityLevel: k, priv: w.identityKey(1, k).privateKey })));
    await expect(fundWithItem({ item, scan: r, secret: { wallet: wallet() }, target: { create: true }, dapi, platform, store: memStore() })).rejects.toThrow(/exists now/);
    expect(platform.created.size).toBe(0);
  });

  it('a lock large enough to create can top up any identity instead when the user chooses it', async () => {
    const { dapi, platform, r, item } = await lockAt1();
    const out = await fundWithItem({ item, scan: r, secret: { wallet: wallet() }, target: { topUp: 'id0' }, dapi, platform, store: memStore() });
    expect(out.identityId).toBe('id0');
    expect(out.record.recoveredInto).toBe('id0');
    expect(platform.topUps).toHaveLength(1);
    // used now: a second attempt is refused before anything is sent
    await expect(fundWithItem({ item, scan: r, secret: { wallet: wallet() }, target: { topUp: 'id0' }, dapi, platform, store: memStore() })).rejects.toThrow(/already used/);
  });

  it('payments of an account setup are locked and create the account', async () => {
    const d = pay(createPub(2), BigInt(MIN_CREATE_DEPOSIT_DUFFS));
    const c: Chain = { blocks: [[d]] };
    const dapi = fakeDapi(c);
    const platform = platformWithIdentity0();
    const r = await scan(dapi, platform);
    const item = r.items[0]!;
    expect(itemOptions(item, r).create).toBe(2);
    const out = await fundWithItem({ item, scan: r, secret: { wallet: wallet() }, target: { create: true }, dapi, platform, store: memStore() });
    const lock = parseTx(c.broadcasts![0]!);
    expect(lock.type).toBe(8);
    expect(lock.inputs.map((i) => i.prevTxid)).toEqual([d.txid]);
    expect(out.identityId).toBe(identityIdFromOutpoint(lock.txid, 0));
  });

  it('a top-up payment only tops up the identity it was for; a create key needs the phrase', async () => {
    const d = pay(topUpPub(0, 1), 100_000n);
    const dapi = fakeDapi({ blocks: [[d]] });
    const platform = platformWithIdentity0();
    const r = await scan(dapi, platform);
    const item = r.items[0]!;
    expect(itemOptions(item, r).topUp).toBe('id0');
    await expect(fundWithItem({ item, scan: r, secret: { wallet: wallet() }, target: { topUp: 'someone-else' }, dapi, platform, store: memStore() })).rejects.toThrow(/only tops up the identity it was for/);
    await expect(fundWithItem({ item, scan: r, secret: { wallet: wallet() }, target: { create: true }, dapi, platform, store: memStore() })).rejects.toThrow(/cannot create/);
  });

  it('an index that already has an identity offers a top-up, not a create', async () => {
    const r = await scan(fakeDapi({ blocks: [[pay(createPub(0), 900_000n)]] }), platformWithIdentity0());
    const o = itemOptions(r.items[0]!, r);
    expect(o.create).toBeNull();
    expect(o.topUp).toBe('any');
    expect(o.notes.join(' ')).toMatch(/#0 of this phrase already exists/);
  });
});
