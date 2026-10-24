// The high-level client against a fake DAPI gateway that replays recorded mainnet data (no network).
import { afterEach, describe, expect, it } from 'vitest';
import { bytesToHex as hex } from '@noble/hashes/utils.js';
import { BloomFilter } from '../src/bloom.ts';
import { verifyChainLock } from '../src/bls.ts';
import { Dapi } from '../src/client.ts';
import type { Verifiers } from '../src/types.ts';
import { type Cbor, decodeCbor } from '../src/cbor.ts';
import { NodePool } from '../src/pool.ts';
import { AllNodesFailedError, GrpcError, VerificationError } from '../src/errors.ts';
import { parseTx } from '../src/dash.ts';
import { bytes, decode, num, text } from '../src/pb.ts';
import { x11 } from '../src/x11.ts';
import { type FakeDapi, FakeGrpcStatus, type FakeNode, flush, installFakeDapi, resp, until } from './fake-dapi.ts';
import { fx } from './fixtures.ts';
import { type CborIn, encodeCbor } from './helpers/cbor-encode.ts';

const N = (i: number) => `10.0.0.${i}:443`;
const nodes = (n: number) => Array.from({ length: n }, (_, i) => N(i + 1));
const verifiers: Verifiers = { hashHeader: x11, verifyChainLock };
const tipHashInternal = fx.chainLock.blockHashInternal;

// ---- default honest node behaviour ----
const blocksByHash = new Map<string, Uint8Array>([[fx.blockHash, fx.block], ...Object.entries(fx.quorumBlocks)]);
const honest = (over: { claims?: Partial<Parameters<typeof resp.tx>[0]>; block?: (hash: string) => Uint8Array | undefined; sml?: Uint8Array; chainLock?: Uint8Array; headers?: Uint8Array[] } = {}): FakeNode => ({
  unary: {
    getBlockchainStatus: () => resp.status({ height: fx.chainLock.height, hash: tipHashInternal }),
    getTransaction: (req) => {
      if (text(bytes(req, 1)) !== fx.txid) throw new FakeGrpcStatus(5, 'not found');
      return resp.tx({ raw: fx.rawTx, blockHash: fx.blockHash, height: fx.height, confirmations: fx.headers.length, cl: true, ...over.claims });
    },
    getBlock: (req) => {
      const hash = req.has(2) ? text(bytes(req, 2)) : undefined;
      const raw = hash ? (over.block ? over.block(hash) : blocksByHash.get(hash)) : undefined;
      if (!raw) throw new FakeGrpcStatus(5, 'block not found');
      return resp.block(raw);
    },
    broadcastTransaction: () => resp.broadcast(fx.txid),
  },
  streams: {
    subscribeToBlockHeadersWithChainLocks: (_req, ctl) => { ctl.send(resp.headers(over.headers ?? fx.headers)); ctl.send(resp.chainLock(over.chainLock ?? fx.chainLockBytes)); },
    subscribeToMasternodeList: (_req, ctl) => ctl.send(resp.sml(over.sml ?? fx.smlBytes)),
  },
});
const net = (n: number, spec: (i: number) => FakeNode = () => honest()) => Object.fromEntries(nodes(n).map((a, i) => [a, spec(i)]));

let fake: FakeDapi | undefined;
afterEach(() => { fake?.restore(); fake = undefined; });

describe('node bootstrap', () => {
  it('uses a static list without fetching anything', async () => {
    fake = installFakeDapi(net(2));
    const d = new Dapi({ nodes: nodes(2) });
    expect(await d.ready()).toEqual(nodes(2));
  });
  it('bootstraps from a user-supplied URL, and a custom source function wins over the URL', async () => {
    const body = JSON.stringify({ data: [{ status: 'ENABLED', versionCheck: 'success', addresses: { platform_https: [N(1)] } }] });
    let fetched = '';
    fake = installFakeDapi(net(1), { text: { 'https://my-quorums.example/nodes': () => { fetched = 'url'; return new Response(body); } } });
    const d = new Dapi({ nodeListUrl: 'https://my-quorums.example/nodes' });
    expect(await d.ready()).toEqual([N(1)]); expect(fetched).toBe('url');
    const d2 = new Dapi({ nodeListUrl: 'https://never.example/', fetchNodes: async () => [N(2)] });
    expect(await d2.ready()).toEqual([N(2)]);
  });
  it('a failed bootstrap can be retried', async () => {
    let calls = 0;
    const d = new Dapi({ fetchNodes: async () => { if (calls++ === 0) throw new Error('down'); return [N(1)]; } });
    await expect(d.ready()).rejects.toThrow('down');
    expect(await d.ready()).toEqual([N(1)]);
  });
  it('an empty node source is an error', async () => {
    await expect(new Dapi({ fetchNodes: async () => [] }).ready()).rejects.toThrow(/no usable nodes/);
  });
});

describe('call(): failover, budget, retry policy', () => {
  it('treats network errors and HTTP 5xx as "try another node" and finds the live one', async () => {
    fake = installFakeDapi({ [N(1)]: { dead: true }, [N(2)]: { http: 503 }, [N(3)]: { dead: true }, [N(4)]: honest() });
    const d = new Dapi({ nodes: nodes(4), attempts: 4 });
    const r = await d.getBestBlockHeight();
    expect(r).toMatchObject({ height: fx.chainLock.height, node: N(4) });
    const tried = new Set(fake.calls.map((c) => c.split(' ')[0]!)); // nodes were picked at random: every failed one cools down
    for (const n of tried) if (n !== N(4)) expect(d.pool.cooling(n)).toBe(true);
  });
  it('gives up with AllNodesFailedError listing every attempt', async () => {
    fake = installFakeDapi(net(3, () => ({ dead: true })));
    const err = await new Dapi({ nodes: nodes(3), attempts: 3 }).getBestBlockHeight().catch((e) => e);
    expect(err).toBeInstanceOf(AllNodesFailedError);
    expect(err.errors.length).toBe(3);
    expect(err.errors.every((e: { error: GrpcError }) => e.error.network)).toBe(true);
  });
  it('skips a node that reports itself unsynced', async () => {
    fake = installFakeDapi({ [N(1)]: { unary: { getBlockchainStatus: () => resp.status({ height: 5, hash: tipHashInternal, synced: false }) } }, [N(2)]: honest() });
    const r = await new Dapi({ nodes: [N(1), N(2)], attempts: 2 }).getBestBlockHeight();
    expect(r.node).toBe(N(2));
  });
  it('does not retry INVALID_ARGUMENT; retries NOT_FOUND on exactly one more node', async () => {
    fake = installFakeDapi(net(5, () => ({ unary: { getBlock: () => { throw new FakeGrpcStatus(3, 'bad'); }, getTransaction: () => { throw new FakeGrpcStatus(5, 'nf'); } } })));
    const d = new Dapi({ nodes: nodes(5), attempts: 5 });
    await expect(d.getBlock({ height: 1 })).rejects.toMatchObject({ code: 3 });
    expect(fake.calls.filter((c) => c.endsWith('getBlock')).length).toBe(1);
    await expect(d.getVerifiedTransaction(fx.txid)).rejects.toMatchObject({ code: 5 });
    expect(fake.calls.filter((c) => c.endsWith('getTransaction')).length).toBe(2);
  });
  it('never sends more than the per-node budget: an exhausted node is not contacted', async () => {
    fake = installFakeDapi(net(1));
    const d = new Dapi({ nodes: [N(1)], maxPerMinute: 3, attempts: 1 });
    for (let i = 0; i < 3; i++) await d.getBestBlockHeight();
    const err = await d.getBestBlockHeight().catch((e) => e);
    expect(err).toBeInstanceOf(AllNodesFailedError);
    expect(fake.count(N(1))).toBe(3);
  });
  it('spreads load: one node cannot be asked more than 150 times a minute even across calls', async () => {
    fake = installFakeDapi(net(2));
    const d = new Dapi({ nodes: nodes(2), attempts: 1 });
    for (let i = 0; i < 300; i++) await d.getBestBlockHeight();
    expect(fake.count(N(1))).toBeLessThanOrEqual(150);
    expect(fake.count(N(2))).toBeLessThanOrEqual(150);
    await expect(d.getBestBlockHeight()).rejects.toBeInstanceOf(AllNodesFailedError);
  }, 20_000);
  it('an abort propagates instead of being retried', async () => {
    fake = installFakeDapi(net(3, () => ({ delayMs: 200, unary: { getBlockchainStatus: () => resp.status({ height: 1, hash: tipHashInternal }) } })));
    const ac = new AbortController();
    const p = new Dapi({ nodes: nodes(3) }).getBestBlockHeight({ signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow(/abort/i);
    expect(fake.calls.length).toBe(1);
  });
});

describe('getBlock / resolveBlockHeight', () => {
  it('rejects a block whose merkle root does not match its header, then succeeds on an honest node', async () => {
    const bad = Uint8Array.from(fx.block); bad[40]! ^= 1;
    fake = installFakeDapi({ [N(1)]: honest({ block: () => bad }), [N(2)]: honest() });
    const d = new Dapi({ nodes: [N(1), N(2)], attempts: 2 });
    const r = await d.getBlock({ hash: fx.blockHash });
    expect(r.node).toBe(N(2));
    expect(r.block.merkleOk).toBe(true);
  });
  it('resolves and caches the height of a block from its coinbase, checking X11 when available', async () => {
    fake = installFakeDapi(net(1));
    const d = new Dapi({ nodes: [N(1)], verifiers });
    expect(await d.resolveBlockHeight(fx.blockHash)).toBe(fx.height);
    await d.resolveBlockHeight(fx.blockHash);
    expect(fake.calls.filter((c) => c.endsWith('getBlock')).length).toBe(1);
  });
  it('a node answering with a different block than the requested hash is rejected (X11)', async () => {
    const other = Object.values(fx.quorumBlocks)[0]!;
    fake = installFakeDapi({ [N(1)]: honest({ block: () => other }) });
    await expect(new Dapi({ nodes: [N(1)], verifiers, attempts: 1 }).resolveBlockHeight(fx.blockHash)).rejects.toBeInstanceOf(AllNodesFailedError);
  });
});

describe('getVerifiedTransaction', () => {
  it('verifies everything offline: merkle, height, X11 block hash, header chain, BLS ChainLock with the exact quorum', async () => {
    fake = installFakeDapi(net(4));
    const d = new Dapi({ nodes: nodes(4), verifiers });
    const v = await d.getVerifiedTransaction(fx.txid);
    expect(v).toMatchObject({
      txid: fx.txid, height: fx.height, blockHash: fx.blockHash, chainLocked: 'verified', instantLocked: 'no',
      proof: { merkle: true, blockHash: 'verified', notes: [], chainLock: { height: fx.chainLock.height, blockHash: fx.chainLock.blockHash, exact: true, verifiedConfirmations: fx.chainLock.height - fx.height + 1 } },
    });
    expect(v.tx.txid).toBe(fx.txid);
    expect(v.raw).toEqual(fx.rawTx);
  });
  it('degrades to the node claim when no verifiers are configured, and says why', async () => {
    fake = installFakeDapi(net(1));
    const v = await new Dapi({ nodes: [N(1)] }).getVerifiedTransaction(fx.txid);
    expect(v).toMatchObject({ chainLocked: 'claimed', proof: { merkle: true, blockHash: 'claimed', chainLock: null } });
    expect(v.proof.notes[0]).toMatch(/X11/);
    const v2 = await new Dapi({ nodes: [N(1)], verifiers: { hashHeader: x11 } }).getVerifiedTransaction(fx.txid);
    expect(v2).toMatchObject({ chainLocked: 'claimed', proof: { blockHash: 'verified' } });
    expect(v2.proof.notes[0]).toMatch(/BLS/);
  });
  it('reports "no" when the node does not claim a ChainLock and none can be proven', async () => {
    fake = installFakeDapi(net(1, () => honest({ claims: { cl: false } })));
    const v = await new Dapi({ nodes: [N(1)] }).getVerifiedTransaction(fx.txid, { chainLock: false });
    expect(v.chainLocked).toBe('no');
  });
  it('verifies "verified" even if the node under-claims (the proof stands on its own)', async () => {
    fake = installFakeDapi(net(2, () => honest({ claims: { cl: false } })));
    expect((await new Dapi({ nodes: nodes(2), verifiers }).getVerifiedTransaction(fx.txid)).chainLocked).toBe('verified');
  });
  it('treats a node returning a different tx, a wrong height, a foreign block or a corrupted block as lying and moves on', async () => {
    const wrongTx = fx.blockParsed.txs[1]!.raw;
    const corrupted = Uint8Array.from(fx.block); corrupted[36]! ^= 1;
    const liars: FakeNode[] = [
      honest({ claims: { raw: wrongTx } }),
      honest({ claims: { height: fx.height + 1 } }),
      honest({ block: () => Object.values(fx.quorumBlocks)[0] }),
      honest({ block: () => corrupted }),
    ];
    for (const liar of liars) {
      fake = installFakeDapi({ [N(1)]: liar, [N(2)]: honest() });
      const v = await new Dapi({ nodes: [N(1), N(2)], verifiers, attempts: 2 }).getVerifiedTransaction(fx.txid);
      expect(v.node).toBe(N(2));
      expect(v.chainLocked).toBe('verified');
      fake.restore();
    }
  });
  it('fails when every node lies', async () => {
    const corrupted = Uint8Array.from(fx.block); corrupted[36]! ^= 1;
    fake = installFakeDapi(net(3, () => honest({ block: () => corrupted })));
    const err = await new Dapi({ nodes: nodes(3), attempts: 3 }).getVerifiedTransaction(fx.txid).catch((e) => e);
    expect(err).toBeInstanceOf(AllNodesFailedError);
    expect(err.errors[0].error).toBeInstanceOf(VerificationError);
  });
  it('a tx claimed in a block that does not contain it is rejected', async () => {
    const other = Object.values(fx.quorumBlocks)[1]!; // a real block, but not the claimed one: its X11 hash differs too
    fake = installFakeDapi({ [N(1)]: honest({ block: () => other }) });
    await expect(new Dapi({ nodes: [N(1)], attempts: 1 }).getVerifiedTransaction(fx.txid)).rejects.toBeInstanceOf(AllNodesFailedError);
  });
  it('a mempool tx has no block: height 0, chainLocked "no", IS-lock only claimed', async () => {
    fake = installFakeDapi(net(1, () => honest({ claims: { blockHash: undefined, height: 0, confirmations: 0, il: true, cl: false } })));
    const v = await new Dapi({ nodes: [N(1)], verifiers }).getVerifiedTransaction(fx.txid);
    expect(v).toMatchObject({ height: 0, blockHash: null, confirmations: 0, chainLocked: 'no', instantLocked: 'claimed', proof: { merkle: false } });
  });
  it('an unknown txid is NOT_FOUND (code 5) and a malformed one is rejected locally', async () => {
    fake = installFakeDapi(net(2));
    const d = new Dapi({ nodes: nodes(2) });
    await expect(d.getVerifiedTransaction('ab'.repeat(32))).rejects.toMatchObject({ code: 5 });
    await expect(d.getVerifiedTransaction('xyz')).rejects.toThrow(/64 hex/);
  });
  it('a ChainLock older than the block leaves the claim in place with a note', async () => {
    const old = Uint8Array.from(fx.chainLockBytes); new DataView(old.buffer).setInt32(0, fx.height - 1, true);
    fake = installFakeDapi(net(3, () => honest({ chainLock: old })));
    const v = await new Dapi({ nodes: nodes(3), verifiers }).getVerifiedTransaction(fx.txid);
    expect(v.chainLocked).toBe('claimed');
    expect(v.proof.notes[0]).toMatch(/predates/);
  });
  it('waitForChainLockMs waits for a newer ChainLock than the one sent first', async () => {
    const old = Uint8Array.from(fx.chainLockBytes); new DataView(old.buffer).setInt32(0, fx.height - 1, true);
    const node: FakeNode = { ...honest(), streams: { subscribeToBlockHeadersWithChainLocks: (_r, ctl) => {
      ctl.send(resp.headers(fx.headers)); ctl.send(resp.chainLock(old));
      setTimeout(() => ctl.send(resp.chainLock(fx.chainLockBytes)), 150);
    }, subscribeToMasternodeList: (_r, ctl) => ctl.send(resp.sml(fx.smlBytes)) } };
    fake = installFakeDapi({ [N(1)]: node, [N(2)]: node, [N(3)]: node });
    const d = new Dapi({ nodes: nodes(3), verifiers });
    expect((await d.getVerifiedTransaction(fx.txid)).chainLocked).toBe('claimed'); // no waiting by default
    const v = await d.getVerifiedTransaction(fx.txid, { waitForChainLockMs: 2000 });
    expect(v.chainLocked).toBe('verified');
  });
  it('an SML that cannot be agreed on is a note, not a failure of the header-stream node', async () => {
    fake = installFakeDapi(net(3, (i) => honest({ sml: smlVariant((d) => { d.merkleRootMNList = String(i + 1).repeat(64); }) })));
    const d = new Dapi({ nodes: nodes(3), verifiers });
    const v = await d.getVerifiedTransaction(fx.txid);
    expect(v).toMatchObject({ chainLocked: 'claimed' });
    expect(v.proof.notes[0]).toMatch(/sml|SML/);
    expect(fake.calls.filter((c) => c.endsWith('subscribeToBlockHeadersWithChainLocks')).length).toBe(0); // never opened a header stream
  }, 20_000);
  it('an invalid ChainLock signature is never "verified"', async () => {
    const bad = Uint8Array.from(fx.chainLockBytes); bad[60]! ^= 1;
    fake = installFakeDapi(net(2, () => honest({ chainLock: bad })));
    const v = await new Dapi({ nodes: nodes(2), verifiers }).getVerifiedTransaction(fx.txid);
    expect(v.chainLocked).toBe('claimed');
    expect(v.proof.notes[0]).toMatch(/signature not accepted|chainlock proof failed/);
  });
  it('a header chain that does not reach the ChainLocked block is rejected', async () => {
    const broken = fx.headers.slice(); broken[10] = fx.headers[11]!;
    fake = installFakeDapi(net(2, () => honest({ headers: broken })));
    const v = await new Dapi({ nodes: nodes(2), verifiers }).getVerifiedTransaction(fx.txid);
    expect(v.chainLocked).toBe('claimed');
    expect(v.proof.notes[0]).toMatch(/header chain breaks/);
  });
  it('refuses to hash more than maxHeaderSpan headers', async () => {
    fake = installFakeDapi(net(3));
    const v = await new Dapi({ nodes: nodes(3), verifiers }).getVerifiedTransaction(fx.txid, { maxHeaderSpan: 5 });
    expect(v.chainLocked).toBe('claimed');
    expect(v.proof.notes[0]).toMatch(/maxHeaderSpan/);
  });
  it('closes its header stream when done', async () => {
    fake = installFakeDapi(net(1));
    await new Dapi({ nodes: [N(1)], verifiers }).getVerifiedTransaction(fx.txid);
    await until(() => fake!.open.size === 0);
  });
});

const smlVariant = (mut: (d: Record<string, CborIn>) => void): Uint8Array => {
  const d = decodeCbor(fx.smlBytes) as Record<string, Cbor>;
  mut(d as unknown as Record<string, CborIn>);
  return encodeCbor(d as unknown as CborIn);
};

describe('getSml: cross-node agreement', () => {
  it('accepts when 2 of 3 nodes agree, names them, and cancels the third stream', async () => {
    const odd = smlVariant((d) => { d.merkleRootMNList = '99'.repeat(32); });
    fake = installFakeDapi(net(3, (i) => honest({ sml: i === 1 ? odd : fx.smlBytes })));
    const d = new Dapi({ nodes: nodes(3) });
    const s = await d.getSml();
    expect(s.agreedBy.length).toBe(2);
    expect(s.agreedBy).not.toContain(N(2));
    expect(s.asked.length).toBe(3);
    expect(s.digest).toBe(fx.sml.digest);
    await until(() => fake!.open.size === 0);
  });
  it('rejects when no two nodes agree', async () => {
    fake = installFakeDapi(net(3, (i) => honest({ sml: smlVariant((d) => { d.merkleRootMNList = String(i + 1).repeat(64); }) })));
    await expect(new Dapi({ nodes: nodes(3) }).getSml({ rounds: 1 })).rejects.toMatchObject({ code: 'sml-disagree' });
  });
  it('asks more nodes when the first three are slow, instead of waiting for them', async () => {
    const slow = () => ({ ...honest(), delayMs: 5000 });
    fake = installFakeDapi({ [N(1)]: slow(), [N(2)]: slow(), [N(3)]: slow(), [N(4)]: honest(), [N(5)]: honest() });
    // random() ~ 1 keeps the pool in list order, so the first batch is the three slow nodes
    const d = new Dapi({ nodes: nodes(5), pool: new NodePool(nodes(5), { random: () => 0.999999 }) });
    const t0 = Date.now();
    const s = await d.getSml({ hedgeAfterMs: 60 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(s.agreedBy.sort()).toEqual([N(4), N(5)]);
    expect(s.asked.length).toBe(5);
    await until(() => fake!.open.size === 0);
  });
  it('one caller aborting does not fail another caller sharing the fetch, and the cache still fills', async () => {
    fake = installFakeDapi(net(3, () => ({ ...honest(), delayMs: 60 })));
    const d = new Dapi({ nodes: nodes(3) });
    const ac = new AbortController();
    const a = d.getSml({ signal: ac.signal });
    const b = d.getSml();
    setTimeout(() => ac.abort(), 10);
    await expect(a).rejects.toThrow(/abort/i);
    expect((await b).agreedBy.length).toBe(2);
    const calls = fake.calls.length;
    await d.getSml();
    expect(fake.calls.length).toBe(calls); // served from the cache the surviving fetch filled
  });
  it('a pre-aborted signal rejects immediately without touching the network', async () => {
    fake = installFakeDapi(net(3));
    const ac = new AbortController(); ac.abort();
    await expect(new Dapi({ nodes: nodes(3) }).getSml({ signal: ac.signal })).rejects.toThrow(/abort/i);
  });
  it('a single reachable node cannot satisfy the default agreement of 2', async () => {
    fake = installFakeDapi({ [N(1)]: honest(), [N(2)]: { dead: true }, [N(3)]: { dead: true } });
    await expect(new Dapi({ nodes: nodes(3) }).getSml({ rounds: 1 })).rejects.toBeInstanceOf(VerificationError);
  });
  it('is cached for the ttl and shared by concurrent callers; force refetches', async () => {
    fake = installFakeDapi(net(3));
    const d = new Dapi({ nodes: nodes(3) });
    const [a, b] = await Promise.all([d.getSml(), d.getSml()]);
    expect(a).toBe(b);
    const streams = () => fake!.calls.filter((c) => c.endsWith('subscribeToMasternodeList')).length;
    expect(streams()).toBe(3);
    await d.getSml(); expect(streams()).toBe(3);
    await d.getSml({ force: true }); expect(streams()).toBeGreaterThan(3);
  });
  it('refreshNodesFromSml appends (service nodes first) or replaces', async () => {
    fake = installFakeDapi(net(3));
    const d = new Dapi({ nodes: nodes(3) });
    const r = await d.refreshNodesFromSml();
    expect(d.pool.list().slice(0, 3)).toEqual(nodes(3));
    expect(r.added).toBeGreaterThan(0);
    expect(d.pool.list()).toEqual(expect.arrayContaining(fx.sml.evonodes.map((e) => e.endpoint)));
    await d.refreshNodesFromSml({ mode: 'replace' });
    expect(d.pool.list()).toEqual(fx.sml.evonodes.map((e) => e.endpoint));
  });
});

describe('verifyChainLock (client)', () => {
  it('resolves quorum base heights through getBlock and verifies exactly', async () => {
    fake = installFakeDapi(net(3));
    const d = new Dapi({ nodes: nodes(3), verifiers });
    expect(await d.verifyChainLock(fx.chainLock)).toMatchObject({ ok: true, exact: true });
    expect(fake.calls.filter((c) => c.endsWith('getBlock')).length).toBe(4);
  });
  it('refuses without a verifier configured', async () => {
    await expect(new Dapi({ nodes: [N(1)] }).verifyChainLock(fx.chainLock)).rejects.toThrow(/verifier not configured/);
  });
  it('verifiers can be loaded lazily', async () => {
    fake = installFakeDapi(net(3));
    let loaded = 0;
    const d = new Dapi({ nodes: nodes(3), verifiers: async () => { loaded++; return verifiers; } });
    expect(loaded).toBe(0);
    expect((await d.verifyChainLock(fx.chainLock)).ok).toBe(true);
    await d.verifyChainLock(fx.chainLock);
    expect(loaded).toBe(1);
  });
});

describe('broadcastTransaction (mocked: nothing is ever sent to a real node)', () => {
  const raw = fx.rawTx;
  it('returns the txid after checking it against the locally computed one', async () => {
    fake = installFakeDapi(net(1));
    expect(await new Dapi({ nodes: [N(1)] }).broadcastTransaction(raw)).toEqual({ txid: fx.txid, node: N(1) });
  });
  it('sends the raw bytes and the flags in the request', async () => {
    let seen: ReturnType<typeof decode> | undefined;
    fake = installFakeDapi({ [N(1)]: { unary: { broadcastTransaction: (req) => { seen = req; return resp.broadcast(fx.txid); } } } });
    await new Dapi({ nodes: [N(1)] }).broadcastTransaction(raw, { allowHighFees: true });
    expect([...bytes(seen!, 1)]).toEqual([...raw]);
    expect(num(seen!, 2)).toBe(1);
    expect(num(seen!, 3)).toBe(0);
  });
  it('a node reporting a different txid is rejected', async () => {
    fake = installFakeDapi({ [N(1)]: { unary: { broadcastTransaction: () => resp.broadcast('00'.repeat(32)) } } });
    const err = await new Dapi({ nodes: [N(1)], attempts: 1 }).broadcastTransaction(raw).catch((e) => e);
    expect(err.errors[0].error).toBeInstanceOf(VerificationError);
  });
  it('retries network failures on another node (re-sending is harmless)', async () => {
    fake = installFakeDapi({ [N(1)]: { dead: true }, [N(2)]: honest() });
    const r = await new Dapi({ nodes: [N(1), N(2)], attempts: 2 }).broadcastTransaction(raw);
    expect(r.node).toBe(N(2));
  });
  it('does not retry a rejection (INVALID_ARGUMENT) on other nodes', async () => {
    fake = installFakeDapi(net(3, () => ({ unary: { broadcastTransaction: () => { throw new FakeGrpcStatus(3, 'bad-txns-inputs-missingorspent'); } } })));
    await expect(new Dapi({ nodes: nodes(3) }).broadcastTransaction(raw)).rejects.toMatchObject({ code: 3, message: expect.stringMatching(/missingorspent/) });
    expect(fake.calls.length).toBe(1);
  });
  it('"already in mempool/known" counts as success', async () => {
    fake = installFakeDapi(net(1, () => ({ unary: { broadcastTransaction: () => { throw new FakeGrpcStatus(3, 'txn-already-in-mempool'); } } })));
    expect((await new Dapi({ nodes: [N(1)] }).broadcastTransaction(raw)).txid).toBe(fx.txid);
  });
  it('garbage never reaches the network', async () => {
    fake = installFakeDapi(net(1));
    await expect(new Dapi({ nodes: [N(1)] }).broadcastTransaction(Uint8Array.of(1, 2, 3))).rejects.toThrow();
    expect(fake.calls.length).toBe(0);
  });
});

// ---- deposit watching ----
const hash160 = (() => {
  const t = fx.txParsed;
  const out = t.outputs.find((o) => o.script.length === 25 && o.script[0] === 0x76)!;
  return out.script.subarray(3, 23);
})();
const islock = fx.rec.firehose.islocks[0]!;
const isBytes = Uint8Array.from(Buffer.from(islock.hex, 'hex'));
const isTx = Uint8Array.from(Buffer.from(islock.rawTxHex, 'hex'));
const merkleBlockBytes = Uint8Array.from(Buffer.from(fx.rec.merkleblock.hex, 'hex'));

/** A node that, once subscribed, emits the given messages (optionally after a delay) and stays open. */
const watcherNode = (msgs: () => Uint8Array[], o: { delayMs?: number; endAfterMs?: number; at?: number } = {}): FakeNode => ({
  delayMs: o.delayMs,
  unary: { getBlockchainStatus: () => resp.status({ height: 1000, hash: tipHashInternal }) },
  streams: {
    subscribeToTransactionsWithProofs: (_req, ctl) => {
      setTimeout(() => { for (const m of msgs()) ctl.send(m); }, o.at ?? 5);
      if (o.endAfterMs !== undefined) setTimeout(() => ctl.end(14), o.endAfterMs);
    },
  },
});

describe('watchAddressForDeposit', () => {
  const handlers = () => {
    const ev = { txs: [] as { txid: string; matches: number[]; node: string }[], locks: [] as { txid: string; bytes: Uint8Array; known: boolean }[], blocks: 0, errors: [] as { phase: string; e: unknown }[] };
    return {
      ev,
      h: {
        onTx: (e: { tx: { txid: string }; matches: number[]; node: string }) => { ev.txs.push({ txid: e.tx.txid, matches: e.matches, node: e.node }); },
        onIsLock: (e: { lock: { txid: string }; bytes: Uint8Array; known: boolean }) => { ev.locks.push({ txid: e.lock.txid, bytes: e.bytes, known: e.known }); },
        onBlock: () => { ev.blocks++; },
        onError: (e: unknown, ctx: { phase: string }) => { ev.errors.push({ phase: ctx.phase, e }); },
      },
    };
  };

  it('is ready only after subscriptions are open on several nodes, and the filter is >= 200 bytes with the hash in it', async () => {
    let req: ReturnType<typeof decode> | undefined;
    const spec = (): FakeNode => ({ ...watcherNode(() => [], { delayMs: 60 }), streams: { subscribeToTransactionsWithProofs: (r) => { req ??= r; } } });
    fake = installFakeDapi(net(4, spec));
    const d = new Dapi({ nodes: nodes(4) });
    const { h } = handlers();
    let ready = false;
    const p = d.watchAddressForDeposit(hash160, h).then((w) => { ready = true; return w; });
    await flush(20);
    expect(ready).toBe(false); // streams requested but no response headers yet
    const w = await p;
    expect(fake.calls.filter((c) => c.endsWith('subscribeToTransactionsWithProofs')).length).toBeGreaterThanOrEqual(2);
    expect(fake.open.size).toBeGreaterThanOrEqual(2);
    expect(w.stats().opened.length).toBe(3);
    expect(w.filter.vData.length).toBeGreaterThanOrEqual(200);
    const bf = decode(bytes(req!, 1));
    const wire = { vData: bytes(bf, 1), nHashFuncs: num(bf, 2), nTweak: num(bf, 3), nFlags: num(bf, 4) };
    expect(wire.vData.length).toBeGreaterThanOrEqual(200);
    const probe = new BloomFilter(1, 0.0001, wire.nTweak); probe.vData = wire.vData; probe.nHashFuncs = wire.nHashFuncs;
    expect(probe.contains(hash160)).toBe(true);
    expect(num(req!, 3)).toBe(1000 - 3); // fromHeight = best - lookback
    w.cancel(); await w.closed;
    expect(fake.open.size).toBe(0);
  });

  it('merges 3 nodes: each tx, IS-lock and block is delivered once; IS-lock bytes arrive intact for persistence', async () => {
    fake = installFakeDapi(net(3, () => watcherNode(() => [resp.rawTxs([isTx]), resp.isLocks([isBytes]), resp.merkleBlock(merkleBlockBytes)])));
    const { h, ev } = handlers();
    // the recorded IS-lock's tx must pay our hash for the matcher: use its own p2pkh output
    const payee = parseTx(isTx).outputs.find((o) => o.script.length === 25 && o.script[0] === 0x76);
    const target = payee ? payee.script.subarray(3, 23) : hash160;
    const d = new Dapi({ nodes: nodes(3) });
    const w = await d.watchAddressForDeposit(target, h);
    await until(() => ev.locks.length === 1 && ev.blocks === 1);
    await flush(60);
    expect(ev.txs.length).toBe(payee ? 1 : 0);
    expect(ev.locks.length).toBe(1);
    expect(hex(ev.locks[0]!.bytes)).toBe(islock.hex);
    expect(ev.locks[0]!.known).toBe(!!payee);
    expect(ev.blocks).toBe(1);
    expect(w.stats().dupes).toBeGreaterThanOrEqual(3);
    w.cancel(); await w.closed;
  });

  it('delivers deposits with the paying output indexes and ignores bloom false positives', async () => {
    const payTx = fx.rawTx, otherTx = fx.blockParsed.txs.find((t) => t.txid !== fx.txid && t.outputs.every((o) => !(o.script.length === 25 && o.script.subarray(3, 23).every((b, i) => b === hash160[i]))))!.raw;
    fake = installFakeDapi(net(3, () => watcherNode(() => [resp.rawTxs([otherTx, payTx])])));
    const { h, ev } = handlers();
    const w = await new Dapi({ nodes: nodes(3) }).watchAddressForDeposit(hash160, h);
    await until(() => ev.txs.length >= 1); await flush(40);
    expect(ev.txs).toHaveLength(1);
    expect(ev.txs[0]).toMatchObject({ txid: fx.txid });
    expect(ev.txs[0]!.matches.length).toBeGreaterThanOrEqual(1);
    w.cancel(); await w.closed;
  });

  it('reports persistence failures and bad messages through onError without dying', async () => {
    const badMb = Uint8Array.from(merkleBlockBytes); badMb[40]! ^= 1;
    fake = installFakeDapi(net(3, () => watcherNode(() => [resp.isLocks([Uint8Array.of(9, 9, 9)]), resp.merkleBlock(badMb), resp.isLocks([isBytes])])));
    const errs: string[] = [];
    let persisted = 0;
    const w = await new Dapi({ nodes: nodes(3) }).watchAddressForDeposit(hash160, {
      onTx: () => {}, onIsLock: () => { persisted++; throw new Error('disk full'); }, onError: (_e, c) => errs.push(c.phase),
    });
    await until(() => errs.includes('islock-persist') && errs.includes('islock-parse') && errs.includes('stream-event'));
    expect(persisted).toBe(1);
    expect(w.stats().live).toBeGreaterThan(0);
    w.cancel(); await w.closed;
  });

  it('replaces a stream that ends from the rest of the pool and keeps delivering', async () => {
    // nodes 1-3 end their stream after 30 ms, so any initial pick of 3 loses at least one stream; 4 and 5 stay and deliver
    const specs = [1, 2, 3].map(() => watcherNode(() => [], { endAfterMs: 30 })).concat([4, 5].map(() => watcherNode(() => [resp.rawTxs([fx.rawTx])], { at: 400 })));
    fake = installFakeDapi(Object.fromEntries(nodes(5).map((a, i) => [a, specs[i]!])));
    const { h, ev } = handlers();
    const w = await new Dapi({ nodes: nodes(5) }).watchAddressForDeposit(hash160, h, { streams: 3 });
    await until(() => w.stats().opened.length >= 4 && ev.txs.length >= 1, 5000);
    expect(w.stats().failed.length).toBeGreaterThanOrEqual(1);
    expect(ev.txs).toHaveLength(1);
    w.cancel(); await w.closed;
    expect(ev.errors.some((e) => e.phase === 'stream-closed')).toBe(true);
  });

  it('a replacement stream starts near the tip instead of replaying from the original height', async () => {
    const heights: number[] = [];
    const blockVariant = (i: number): Uint8Array => { const b = Uint8Array.from(merkleBlockBytes); b[76] = i + 1; return resp.merkleBlock(b); };
    const rec = (msgs: () => Uint8Array[], endAfterMs?: number): FakeNode => ({
      unary: {},
      streams: { subscribeToTransactionsWithProofs: (req, ctl) => {
        heights.push(num(req, 3));
        setTimeout(() => { for (const m of msgs()) ctl.send(m); }, 5);
        if (endAfterMs) setTimeout(() => ctl.end(14), endAfterMs);
      } },
    });
    fake = installFakeDapi({ [N(1)]: rec(() => [0, 1, 2, 3, 4, 5].map(blockVariant), 80), [N(2)]: rec(() => []), [N(3)]: rec(() => []), [N(4)]: rec(() => []), [N(5)]: rec(() => []) });
    const d = new Dapi({ nodes: nodes(5), pool: new NodePool(nodes(5), { random: () => 0.999999 }) });
    let seen = 0;
    const w = await d.watchAddressForDeposit(hash160, { ...handlers().h, onBlock: () => { seen++; } }, { fromHeight: 1000 });
    await until(() => heights.length >= 4, 4000);
    expect(seen).toBe(6);
    expect(heights.slice(0, 3)).toEqual([1000, 1000, 1000]);
    expect(heights[3]).toBe(1003); // 6 blocks seen, minus a 3 block margin
    w.cancel(); await w.closed;
  });

  it('an idle stream is replaced without blaming the node or reporting an error', async () => {
    fake = installFakeDapi(net(5, () => watcherNode(() => [])));
    const { h, ev } = handlers();
    const d = new Dapi({ nodes: nodes(5) });
    const w = await d.watchAddressForDeposit(hash160, h, { idleTimeoutMs: 60 });
    await until(() => w.stats().opened.length >= 5, 4000);
    expect(ev.errors.filter((e) => e.phase === 'stream-closed')).toEqual([]);
    expect(nodes(5).some((n) => d.pool.cooling(n))).toBe(false);
    w.cancel(); await w.closed;
  });

  it('a throwing onError never breaks the watcher; a pre-aborted signal never starts it', async () => {
    fake = installFakeDapi(net(3, () => watcherNode(() => [resp.isLocks([Uint8Array.of(9)])])));
    const w = await new Dapi({ nodes: nodes(3) }).watchAddressForDeposit(hash160, { onTx: () => {}, onIsLock: () => {}, onError: () => { throw new Error('observer bug'); } });
    await flush(60);
    expect(w.stats().live).toBeGreaterThan(0);
    w.cancel(); await w.closed;
    const ac = new AbortController(); ac.abort();
    await expect(new Dapi({ nodes: nodes(3) }).watchAddressForDeposit(hash160, handlers().h, { signal: ac.signal, fromHeight: 5 })).rejects.toThrow(/abort/i);
  });

  it('a single-node pool can still become ready', async () => {
    fake = installFakeDapi({ [N(1)]: watcherNode(() => []) });
    const w = await new Dapi({ nodes: [N(1)] }).watchAddressForDeposit(hash160, handlers().h, { fromHeight: 5 });
    expect(w.stats().live).toBe(1);
    w.cancel(); await w.closed;
  });

  it('fails clearly when no streams can be opened, and leaves nothing running', async () => {
    fake = installFakeDapi(net(3, () => ({ dead: true })));
    const err = await new Dapi({ nodes: nodes(3) }).watchAddressForDeposit(hash160, handlers().h, { readyTimeoutMs: 500, streams: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(AllNodesFailedError);
    expect(fake.open.size).toBe(0);
  });

  it('cancel() through an AbortSignal closes every stream', async () => {
    fake = installFakeDapi(net(3, () => watcherNode(() => [])));
    const ac = new AbortController();
    const w = await new Dapi({ nodes: nodes(3) }).watchAddressForDeposit(hash160, handlers().h, { signal: ac.signal });
    ac.abort();
    await w.closed;
    expect(fake.open.size).toBe(0);
  });

  it('validates inputs: 20-byte hash, >= 200 byte filters', async () => {
    const d = new Dapi({ nodes: [N(1)] });
    expect(() => d.watchAddressForDeposit(new Uint8Array(19), handlers().h)).toThrow(/20 bytes/);
    await expect(d.watchTransactions({ vData: new Uint8Array(3), nHashFuncs: 5, nTweak: 0, nFlags: 0 }, handlers().h)).rejects.toThrow(/200 bytes/);
  });

  it('honours an explicit fromHeight and skips the height lookup', async () => {
    let req: ReturnType<typeof decode> | undefined;
    fake = installFakeDapi(net(3, () => ({ streams: { subscribeToTransactionsWithProofs: (r) => { req ??= r; } } })));
    const w = await new Dapi({ nodes: nodes(3) }).watchAddressForDeposit(hash160, handlers().h, { fromHeight: 12345 });
    expect(num(req!, 3)).toBe(12345);
    expect(fake.calls.some((c) => c.endsWith('getBlockchainStatus'))).toBe(false);
    w.cancel(); await w.closed;
  });
});
