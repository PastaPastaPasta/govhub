// anchorChain on the quorum-proof path, end to end against fake nodes and fake proof sources serving a recorded testnet snapshot
// (scripts/record-proof-fixtures.mjs): the masternode list at S, a DIP 175 proof from the pinned checkpoint to a ChainLock at T >= S
// (from the public testnet quorum list server), and the headers below T. Testnet is the point: its proof of work protects nothing,
// and here nothing rests on it.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyChainLock } from '../src/bls.ts';
import { hashHex, unhex } from '../src/bytes.ts';
import { Dapi } from '../src/client.ts';
import { verifyQuorumProof } from '../src/coreproof.ts';
import type { StoredLinkedChain } from '../src/linkedchain.ts';
import { SAVED_SOURCE, anchorByProof } from '../src/proofanchor.ts';
import { fetchSml } from '../src/anchor.ts';
import { num } from '../src/pb.ts';
import { type ProofSource, ProofSourceError, type ProofState } from '../src/quorumproof.ts';
import type { HeaderStore, Verifiers } from '../src/types.ts';
import { x11, x11Many } from '../src/x11.ts';
import { type FakeDapi, type FakeNode, installFakeDapi, resp } from './fake-dapi.ts';
import { loadAnchorFixture } from './anchor-fixtures.ts';

const verifiers: Verifiers = { hashHeader: x11, hashHeaders: x11Many, verifyChainLock, verifyQuorumProof };
const N = (i: number) => `10.0.0.${i}:443`;
let fake: FakeDapi | undefined;
afterEach(() => fake?.restore());

const j = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/proof-anchor-testnet.json.gz', import.meta.url))).toString('utf8'));
const f = {
  now: j.now as number, from: j.from as number, headers: new Uint8Array(Buffer.from(j.headersB64, 'base64')), smlBytes: new Uint8Array(Buffer.from(j.smlB64, 'base64')),
  proof: unhex(j.proofHex), checkpoint: j.checkpoint as ProofState, target: j.target as ProofState,
};
const hashes = x11Many(f.headers);
const top = f.from + f.headers.length / 80 - 1;
const header = (h: number) => f.headers.subarray((h - f.from) * 80, (h - f.from + 1) * 80);
const hashAt = (h: number) => hashHex(hashes.subarray((h - f.from) * 32, (h - f.from + 1) * 32));

interface Lies { headers?: boolean }
function node(lies: Lies = {}): FakeNode {
  return {
    unary: {
      getBlockchainStatus: () => resp.status({ height: top, hash: new Uint8Array(32) }),
      getBlock: () => { throw new Error('no blocks here'); },
    },
    streams: {
      subscribeToBlockHeadersWithChainLocks: (req, ctl) => {
        const from = num(req, 2), count = num(req, 3);
        if (count === 0) throw new Error('the proof path never asks for the newest ChainLock');
        const last = Math.min(from + count - 1, top);
        const hs: Uint8Array[] = [];
        for (let k = from; k <= last; k++) {
          const x = Uint8Array.from(header(k));
          if (lies.headers && k === last - 3) x[0]! ^= 1;
          hs.push(x);
        }
        ctl.send(resp.headers(hs));
        ctl.end();
      },
      subscribeToMasternodeList: (_req, ctl) => { ctl.send(resp.sml(f.smlBytes)); },
    },
  };
}

/** A proof source that serves the recorded proof from the pin, and answers like a bridge otherwise. */
function source(name = 'bridge.test', o: { bytes?: Uint8Array; fail?: ProofSourceError } = {}): ProofSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    name, asked,
    async fetch(r) {
      asked.push(r.checkpoint);
      if (o.fail) throw o.fail;
      if (r.checkpoint !== f.checkpoint.blockHash) throw new ProofSourceError(`${name}: HTTP 404`, 404, 'checkpoint-unknown');
      if (r.height > f.target.height) throw new ProofSourceError(`${name}: HTTP 409`, 409, 'not-yet');
      return o.bytes ?? f.proof;
    },
  };
}

function memoryStore<T extends { network: 'mainnet' | 'testnet' }>(): HeaderStore<T> & { saved: T | null } {
  const s = { saved: null as T | null, load: async () => s.saved, save: async (c: T) => { s.saved = c; } };
  return s;
}

const dapiFor = (nodes: string[]) => new Dapi({ network: 'testnet', nodes, verifiers, timeoutMs: 2000 });
const base = { now: () => f.now, quorumCheckpoint: f.checkpoint };

describe('testnet anchorChain on a quorum proof', () => {
  it('anchors on the proven ChainLock with no proof of work, proves the list against it, and keeps the state for a delta proof', async () => {
    fake = installFakeDapi({ [N(1)]: node(), [N(2)]: node(), [N(3)]: node() });
    const proofStore = memoryStore<StoredLinkedChain>();
    const src = source();
    const a = await dapiFor([N(1), N(2), N(3)]).anchorChain({ ...base, proofSources: [src], proofStore });
    expect(a.weak).toBeNull();
    expect(a.trust).toEqual({
      kind: 'quorum-proof', checkpoint: { height: f.checkpoint.height, hash: f.checkpoint.blockHash }, from: { height: f.checkpoint.height, hash: f.checkpoint.blockHash },
      source: 'bridge.test', links: j.links, proofBytes: f.proof.length,
    });
    // a ChainLock 13 blocks into a testnet DKG cycle, checked with a list from that block: Core's set at h - 8 may include a quorum the
    // list already dropped, so Core's exact pick cannot always be reproduced (anchor.ts README note); the signer is a quorum of the set
    expect(a.chainLock).toMatchObject({ height: f.target.height, blockHash: f.target.blockHash, exact: expect.any(Boolean) });
    expect(a.sml.quorums.some((q) => q.llmqType === 1 && q.quorumHash === a.chainLock.quorumHash)).toBe(true);
    expect(a.tip).toBe(f.target.height);
    expect(a.chain.hashHexAt(f.target.height)).toBe(f.target.blockHash);
    expect(a.chain.hashHexAt(top - 400)).toBe(hashAt(top - 400));
    expect(a.sml.proof.height).toBe(f.target.height); // S = T in this recording
    expect(a.sml.proof.mnListRoot).toBe(f.target.masternodeRoot);
    expect(a.sml.proof.quorumsRoot).toBe(f.target.quorumRoot);
    expect(fake.calls.some((c) => c.endsWith('getBlock'))).toBe(false); // every ChainLock quorum's base block came from the linked run
    expect(proofStore.saved).toMatchObject({ version: 2, kind: 'chainlock', chainLock: { height: f.target.height, blockHash: f.target.blockHash }, state: f.target });

    // the next session asks for a proof from the saved state first; there is no newer ChainLock, so the saved one (still under an
    // hour old) serves again, with no proof from the pin and no headers downloaded
    const b = await dapiFor([N(1), N(2), N(3)]).anchorChain({ ...base, proofSources: [src], proofStore });
    expect(src.asked).toEqual([f.checkpoint.blockHash, f.target.blockHash]);
    expect(b.stats).toMatchObject({ cachedHeaders: a.chain.hi - a.chain.lo + 1, fetchedHeaders: 0 });
    expect(b.trust).toMatchObject({ kind: 'quorum-proof', source: SAVED_SOURCE, from: { height: f.target.height }, links: 0 });
    expect(b.chainLock).toMatchObject({ height: f.target.height, blockHash: f.target.blockHash });

    // once the saved ChainLock is over an hour old it cannot serve: the pin is asked again
    src.asked.length = 0;
    const later = f.now + 3600 + 60;
    await expect(dapiFor([N(1), N(2), N(3)]).anchorChain({ ...base, now: () => later, proofSources: [src], proofStore })).rejects.toThrow();
    expect(src.asked).toEqual([f.target.blockHash, f.checkpoint.blockHash]);
  });

  it('reuses a result for a minute within one client', async () => {
    fake = installFakeDapi({ [N(1)]: node(), [N(2)]: node() });
    const src = source();
    const d = dapiFor([N(1), N(2)]);
    const a = await d.anchorChain({ ...base, proofSources: [src] });
    expect(await d.anchorChain({ ...base, proofSources: [src] })).toBe(a);
    expect(src.asked.length).toBe(1);
  });

  it('refuses a ChainLock that conflicts with one verified earlier, and keeps what is stored', async () => {
    fake = installFakeDapi({ [N(1)]: node(), [N(2)]: node() });
    const proofStore = memoryStore<StoredLinkedChain>();
    await dapiFor([N(1), N(2)]).anchorChain({ ...base, proofSources: [source()], proofStore });
    // the stored top at T is another block (as if a quorum had signed two blocks at one height)
    const s = proofStore.saved!;
    const other = Uint8Array.from(s.hashes);
    other[other.length - 1]! ^= 1;
    const otherHash = hashHex(other.subarray(other.length - 32));
    proofStore.saved = { ...s, hashes: other, chainLock: { ...s.chainLock, blockHash: otherHash }, state: { ...s.state, blockHash: otherHash } };
    const before = proofStore.saved;
    const d = dapiFor([N(1), N(2)]);
    const v = await d.crypto();
    const signal = new AbortController().signal;
    await expect(anchorByProof(d, { down: new Map() }, { ...base, proofSources: [source()], proofStore }, v, x11Many, fetchSml(d, { signal }), signal))
      .rejects.toThrow(/conflicts with the one this browser verified earlier/);
    expect(proofStore.saved).toBe(before);
    // anchorChain fails closed: a conflict is not a reason to fall back to proof of work
    await expect(dapiFor([N(1), N(2)]).anchorChain({ ...base, proofSources: [source()], proofStore })).rejects.toThrow(/conflicts with the one this browser verified earlier/);
    expect(proofStore.saved).toBe(before);
  });

  it('starts over from the pin when the stored entry is damaged', async () => {
    fake = installFakeDapi({ [N(1)]: node(), [N(2)]: node() });
    const proofStore = memoryStore<StoredLinkedChain>();
    await dapiFor([N(1), N(2)]).anchorChain({ ...base, proofSources: [source()], proofStore });
    proofStore.saved = { ...proofStore.saved!, hashes: proofStore.saved!.hashes.subarray(0, 31) };
    const src = source();
    const a = await dapiFor([N(1), N(2)]).anchorChain({ ...base, proofSources: [src], proofStore });
    expect(src.asked).toEqual([f.checkpoint.blockHash]);
    expect(a.trust).toMatchObject({ kind: 'quorum-proof', from: { height: f.checkpoint.height } });
  });

  it('reaches down to an older block of interest by linkage alone', async () => {
    fake = installFakeDapi({ [N(1)]: node(), [N(2)]: node() });
    const a = await dapiFor([N(1), N(2)]).anchorChain({ ...base, proofSources: [source()], from: f.from });
    expect(a.chain.lo).toBe(f.from);
    expect(a.chain.hashHexAt(f.from)).toBe(hashAt(f.from));
  });

  it('passes over a source whose proof does not verify, and one that cannot serve proofs', async () => {
    fake = installFakeDapi({ [N(1)]: node(), [N(2)]: node() });
    const forged = Uint8Array.from(f.proof);
    forged[forged.length - 400]! ^= 1;
    const old = source('mainnet-bridge', { fail: new ProofSourceError('HTTP 501', 501, 'unsupported') });
    const bad = source('liar', { bytes: forged });
    const good = source('honest');
    const a = await dapiFor([N(1), N(2)]).anchorChain({ ...base, proofSources: [old, bad, good] });
    expect(a.trust).toMatchObject({ kind: 'quorum-proof', source: 'honest' });
  });

  it('survives a node that sends a bad header', async () => {
    fake = installFakeDapi({ [N(1)]: node({ headers: true }), [N(2)]: node(), [N(3)]: node() });
    const a = await dapiFor([N(1), N(2), N(3)]).anchorChain({ ...base, proofSources: [source()] });
    expect(a.tip).toBe(f.target.height);
  });

  it('never calls a ChainLock older than an hour current: the proof path gives up and says why', async () => {
    fake = installFakeDapi({ [N(1)]: node(), [N(2)]: node() });
    await expect(dapiFor([N(1), N(2)]).anchorChain({ ...base, now: () => f.now + 2 * 3600, proofSources: [source()] })).rejects.toThrow();
  });
});

describe('falling back to proof of work', () => {
  const g = loadAnchorFixture('testnet');
  const powNode = (): FakeNode => ({
    unary: { getBlockchainStatus: () => resp.status({ height: g.top, hash: new Uint8Array(32) }), getBlock: () => { throw new Error('none'); } },
    streams: {
      subscribeToBlockHeadersWithChainLocks: (req, ctl) => {
        const from = num(req, 2), count = num(req, 3);
        if (count === 0) { ctl.send(resp.chainLock(g.chainLockBytes)); return; }
        const hs: Uint8Array[] = [];
        for (let k = from; k <= Math.min(from + count - 1, g.top); k++) hs.push(g.header(k));
        ctl.send(resp.headers(hs));
        ctl.end();
      },
      subscribeToMasternodeList: (_req, ctl) => { ctl.send(resp.sml(g.smlBytes)); },
    },
  });

  it('uses proof of work with its honest testnet label when no source has a proof, and records why', async () => {
    fake = installFakeDapi({ [N(1)]: powNode(), [N(2)]: powNode() });
    const down = source('old-bridge', { fail: new ProofSourceError('old-bridge: HTTP 501: this bridge\'s dashd has no getquorumproofchain', 501, 'unsupported') });
    const a = await dapiFor([N(1), N(2)]).anchorChain({ checkpoint: g.checkpoint, now: () => g.now, proofSources: [down] });
    expect(a.trust).toMatchObject({ kind: 'proof-of-work', fallback: expect.stringContaining('no getquorumproofchain') });
    expect(a.weak).toEqual(expect.stringContaining('difficulty is too low'));
  });

  it('says so when no source is configured', async () => {
    fake = installFakeDapi({ [N(1)]: powNode() });
    const a = await dapiFor([N(1)]).anchorChain({ checkpoint: g.checkpoint, now: () => g.now });
    expect(a.trust).toEqual({ kind: 'proof-of-work', checkpoint: { height: g.checkpoint.height, hash: g.checkpoint.hash }, fallback: 'no quorum proof source is configured' });
  });
});

describe('the recorded proof', () => {
  it('verifies from the pin to the recorded target', () => {
    expect(verifyQuorumProof(f.proof, f.checkpoint).state).toEqual(f.target);
    expect(hashHex(x11(header(f.target.height)))).toBe(f.target.blockHash);
  });
});
