// anchorChain end to end against fake nodes that serve recorded mainnet / testnet data: headers from a checkpoint, the SML proven into
// a block of that chain, the ChainLock verified with a quorum the SML proves, the cache, and lying nodes.
import { afterEach, describe, expect, it } from 'vitest';
import { verifyChainLock } from '../src/bls.ts';
import { hashBytes, hex } from '../src/bytes.ts';
import { Dapi } from '../src/client.ts';
import { encodeCbor } from './helpers/cbor-encode.ts';
import { parseBlock } from '../src/dash.ts';
import type { StoredChain } from '../src/headerchain.ts';
import { num, text, bytes } from '../src/pb.ts';
import type { HeaderStore, Verifiers } from '../src/types.ts';
import { x11, x11Many } from '../src/x11.ts';
import { type FakeDapi, type FakeNode, installFakeDapi, resp } from './fake-dapi.ts';
import { type AnchorFixture, loadAnchorFixture } from './anchor-fixtures.ts';
import { fx } from './fixtures.ts';
import type { CborIn } from './helpers/cbor-encode.ts';

const verifiers: Verifiers = { hashHeader: x11, hashHeaders: x11Many, verifyChainLock };
const N = (i: number) => `10.0.0.${i}:443`;
let fake: FakeDapi | undefined;
afterEach(() => fake?.restore());

interface Lies { headers?: boolean; sml?: boolean; chainLock?: boolean }

/** A node that serves the fixture (optionally lying about one thing). */
function node(f: AnchorFixture, lies: Lies = {}, tip = f.top): FakeNode {
  const smlBytes = lies.sml ? tamperedSml(f) : f.smlBytes;
  return {
    unary: {
      getBlockchainStatus: () => resp.status({ height: tip, hash: new Uint8Array(32) }),
      getBlock: (req) => {
        const hash = text(bytes(req, 2));
        if (hash === f.hashAt(f.superblock.height)) return resp.block(f.superblock.block);
        if (hash === fx.blockHash) return resp.block(fx.block);
        throw new Error(`no block ${hash}`);
      },
      getTransaction: () => resp.tx({ raw: fx.rawTx, blockHash: fx.blockHash, height: fx.height, confirmations: 99, cl: true }),
    },
    streams: {
      subscribeToBlockHeadersWithChainLocks: (req, ctl) => {
        const from = num(req, 2), count = num(req, 3);
        if (count === 0) {
          const cl = Uint8Array.from(f.chainLockBytes);
          if (lies.chainLock) cl[10]! ^= 1;
          ctl.send(resp.chainLock(cl));
          return; // live stream stays open
        }
        const last = Math.min(from + count - 1, tip);
        for (let h = from; h <= last; h += 500) {
          const hs: Uint8Array[] = [];
          for (let k = h; k <= Math.min(h + 499, last); k++) {
            const x = Uint8Array.from(f.header(k));
            if (lies.headers && k === from + 7) x[0]! ^= 1;
            hs.push(x);
          }
          ctl.send(resp.headers(hs));
        }
        ctl.end();
      },
      subscribeToMasternodeList: (_req, ctl) => { ctl.send(resp.sml(smlBytes)); },
    },
  };
}

function tamperedSml(f: AnchorFixture): Uint8Array {
  const d = structuredClone(f.sml) as { mnList: Array<Record<string, unknown>> };
  const valid = d.mnList.filter((m) => m.isValid);
  valid[0]!.votingAddress = valid[1]!.votingAddress; // a node that hands someone else's voting key to a masternode
  return encodeCbor(d as unknown as CborIn);
}

function memoryStore(): HeaderStore & { saved: StoredChain | null } {
  const s = { saved: null as StoredChain | null, load: async () => s.saved, save: async (c: StoredChain) => { s.saved = c; } };
  return s;
}

const dapiFor = (nodes: string[], network: 'mainnet' | 'testnet') => new Dapi({ network, nodes, verifiers, timeoutMs: 2000 });

describe.each(['mainnet', 'testnet'] as const)('%s anchorChain', (network) => {
  const f = loadAnchorFixture(network);
  const base = { checkpoint: f.checkpoint, now: () => f.now };

  it('verifies headers from the checkpoint, proves the SML into the chain and checks the ChainLock with a proven quorum', async () => {
    fake = installFakeDapi({ [N(1)]: node(f), [N(2)]: node(f), [N(3)]: node(f) });
    const store = memoryStore();
    const a = await dapiFor([N(1), N(2), N(3)], network).anchorChain({ ...base, store });
    expect([a.chain.lo, a.tip]).toEqual([f.checkpoint.height - 24, f.top]);
    expect(a.chainLock).toMatchObject({ height: f.chainLock.height, blockHash: f.chainLock.blockHash, exact: true });
    expect(a.sml.proof.blockHash).toBe(f.sml.blockHash);
    expect(a.sml.masternodes.length).toBe((f.sml.mnList as unknown[]).length);
    expect(a.stats).toMatchObject({ cachedHeaders: 0, fetchedHeaders: f.count });
    // stored up to the ChainLock (here the tip), nothing above it
    expect(store.saved!.chainLock.height).toBe(f.chainLock.height);
    expect(store.saved!.lo).toBe(f.from);

    // a new session resumes from the store and downloads nothing it already has
    const b = await dapiFor([N(1), N(2), N(3)], network).anchorChain({ ...base, store });
    expect(b.stats).toMatchObject({ cachedHeaders: f.count, fetchedHeaders: 0 });
    expect(b.chain.hashHexAt(f.from + 5)).toBe(f.hashAt(f.from + 5));
  });

  it('extends the cached run down to an older block of interest', async () => {
    fake = installFakeDapi({ [N(1)]: node(f), [N(2)]: node(f) });
    const store = memoryStore();
    const cp = { height: f.from + 600, hash: f.hashAt(f.from + 600) };
    await dapiFor([N(1), N(2)], network).anchorChain({ ...base, checkpoint: cp, store });
    expect(store.saved!.lo).toBe(cp.height - 24);
    const b = await dapiFor([N(1), N(2)], network).anchorChain({ ...base, checkpoint: cp, store, from: f.from });
    expect(b.chain.lo).toBe(f.from);
    expect(b.stats.fetchedHeaders).toBe(cp.height - 24 - f.from);
    expect(store.saved!.lo).toBe(f.from);
  });

  it('survives a node that sends a bad header and one that sends a doctored masternode list', async () => {
    fake = installFakeDapi({ [N(1)]: node(f, { headers: true, sml: true }), [N(2)]: node(f), [N(3)]: node(f) });
    const a = await dapiFor([N(1), N(2), N(3)], network).anchorChain(base);
    expect(a.tip).toBe(f.top);
    expect(a.sml.node).not.toBe(N(1));
  });

  it('refuses when every node lies about the masternode list or the ChainLock', async () => {
    fake = installFakeDapi({ [N(1)]: node(f, { sml: true }), [N(2)]: node(f, { sml: true }) });
    await expect(dapiFor([N(1), N(2)], network).anchorChain(base)).rejects.toThrow(/merkleRootMNList mismatch/);
    fake.restore();
    fake = installFakeDapi({ [N(1)]: node(f, { chainLock: true }), [N(2)]: node(f, { chainLock: true }) });
    await expect(dapiFor([N(1), N(2)], network).anchorChain(base)).rejects.toThrow(/ChainLock|chain/);
  });

  it('serves blocks of the anchored chain only when they hash to the verified hash', async () => {
    fake = installFakeDapi({ [N(1)]: node(f) });
    const d = dapiFor([N(1)], network);
    const a = await d.anchorChain(base);
    const { block } = await d.getAnchoredBlock(a, f.superblock.height);
    expect(hex(block.header.raw)).toBe(hex(f.header(f.superblock.height)));
    await expect(d.getAnchoredBlock(a, f.top + 1)).rejects.toThrow(/outside the verified chain/);
    await expect(d.getAnchoredBlock(a, f.superblock.height + 1)).rejects.toThrow(); // the node has no such block here
  });
});

describe('getVerifiedTransaction with an anchored chain (mainnet)', () => {
  const f = loadAnchorFixture('mainnet');
  it('proves inclusion, height and depth against the verified chain without another header stream', async () => {
    expect(fx.height).toBeGreaterThanOrEqual(f.from);
    expect(f.hashAt(fx.height)).toBe(fx.blockHash);
    fake = installFakeDapi({ [N(1)]: node(f), [N(2)]: node(f) });
    const d = dapiFor([N(1), N(2)], 'mainnet');
    const anchor = await d.anchorChain({ checkpoint: f.checkpoint, now: () => f.now });
    const before = fake.calls.filter((c) => c.endsWith('subscribeToBlockHeadersWithChainLocks')).length;
    const v = await d.getVerifiedTransaction(fx.txid, { anchor });
    expect(fake.calls.filter((c) => c.endsWith('subscribeToBlockHeadersWithChainLocks')).length).toBe(before);
    expect(v.chainLocked).toBe('verified');
    expect(v.proof.anchor).toEqual({ tip: f.top, confirmations: f.top - fx.height + 1, chainLockHeight: f.chainLock.height });
    expect(v.proof.chainLock).toMatchObject({ height: f.chainLock.height, verifiedConfirmations: f.chainLock.height - fx.height + 1 });
    // a block that is not the verified one at that height is a lie, not a fallback
    const wrong = { ...anchor, chain: Object.create(anchor.chain, { hashHexAt: { value: () => hex(hashBytes(f.hashAt(f.from))) } }) };
    await expect(d.getVerifiedTransaction(fx.txid, { anchor: wrong, attempts: 1 })).rejects.toThrow(/verified chain/);
    expect(parseBlock(fx.block).merkleOk).toBe(true);
  });
});


