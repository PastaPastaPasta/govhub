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
import { MAX_PIN_SPAN, type StoredPinned } from '../src/pinned.ts';
import type { PinTable } from '../src/quorumpins.ts';
import { type ProofAnchorState, SAVED_SOURCE, anchorByProof } from '../src/proofanchor.ts';
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

interface Lies { headers?: boolean; /** this height's header is altered in every answer */ flip?: number }
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
          if ((lies.headers && k === last - 3) || k === lies.flip) x[0]! ^= 1;
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
    // a source that cannot serve from the saved state is said so (not "no newer one exists")
    expect(b.trust).toMatchObject({ newerUnavailable: 'bridge.test: HTTP 404' });
    expect(b.chainLock).toMatchObject({ height: f.target.height, blockHash: f.target.blockHash });

    // D-065: a source that fails (HTTP 502) is said to have failed, named once, not hidden behind "no newer one available"
    const down = source('quorums.test', { fail: new ProofSourceError('quorums.test: HTTP 502', 502) });
    const c = await dapiFor([N(1), N(2), N(3)]).anchorChain({ ...base, proofSources: [down], proofStore });
    expect(c.trust).toMatchObject({ kind: 'quorum-proof', source: SAVED_SOURCE, newerUnavailable: 'quorums.test: HTTP 502' });

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
    await expect(anchorByProof(d, { down: new Map() }, { ...base, proofSources: [source()], proofStore }, v, x11Many, () => fetchSml(d, { signal }), signal))
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

describe('old blocks through pinned hashes', () => {
  // the anchor's own run goes down to T - 602 (the ChainLock quorums' base blocks); pins sit below it, as below a real quorum checkpoint
  const reachLo = f.target.height - 602;
  const pins = (lie?: number): PinTable => ({
    network: 'testnet', checkpoint: { height: reachLo - 3, blockHash: hashAt(reachLo - 3) },
    pins: [reachLo - 7, reachLo - 3].map((h) => [h, h === lie ? hashAt(h - 1) : hashAt(h)] as const),
  });
  const headersAsked = () => fake!.calls.filter((c) => c.endsWith('subscribeToBlockHeadersWithChainLocks')).length;

  it('verifies a block below the run with only the headers up to the pin above it, then reuses them', async () => {
    fake = installFakeDapi({ [N(1)]: node(), [N(2)]: node() });
    const table = pins(), pinStore = memoryStore<StoredPinned>(), proofStore = memoryStore<StoredLinkedChain>();
    const o = { ...base, proofSources: [source()], proofStore, pinStore, pins: table };
    // before (no pins): every header from the block up to the ChainLock
    const before = await dapiFor([N(1), N(2)]).anchorChain({ ...base, proofSources: [source()], from: reachLo - 9 });
    expect(before.stats.fetchedHeaders).toBe(f.target.height - (reachLo - 9) + 1);

    const d = dapiFor([N(1), N(2)]);
    const a = await d.anchorChain({ ...o, from: reachLo - 9 });
    // the run down from T (603 headers) plus reachLo-9..reachLo-7 (3 headers, linked to the pin at reachLo-7): not the 2 between
    expect(a.chain.lo).toBe(reachLo);
    expect(a.stats.fetchedHeaders).toBe(603 + 3);
    expect(a.stats.pinned).toEqual({ segments: 1, heights: 3, fetched: 3 });
    expect(a.chain.hashHexAt(reachLo - 9)).toBe(hashAt(reachLo - 9));
    expect(a.chain.hashHexAt(reachLo - 6)).toBeNull(); // between the pins, not needed, not fetched
    expect(a.chain.pinOf?.(reachLo - 9)).toEqual({ height: reachLo - 7, hash: hashAt(reachLo - 7) });
    expect(pinStore.saved?.segments).toEqual([expect.objectContaining({ pin: reachLo - 7, lo: reachLo - 9 })]);

    // the same block again within the minute: nothing at all is fetched
    const n0 = headersAsked();
    expect(await d.anchorChain({ ...o, from: reachLo - 9 })).toBe(a);
    expect(headersAsked()).toBe(n0);
    // a deeper block under the same pin: only the one header below what is held; no new proof, no new list
    const asked = fake.calls.length;
    const b = await d.anchorChain({ ...o, from: reachLo - 10 });
    expect(b.stats.pinned).toEqual({ segments: 1, heights: 4, fetched: 4 });
    expect(b.chain.hashHexAt(reachLo - 10)).toBe(hashAt(reachLo - 10));
    expect(fake.calls.slice(asked).every((c) => c.endsWith('subscribeToBlockHeadersWithChainLocks'))).toBe(true);
    // a block that is itself pinned: no headers
    const n1 = headersAsked();
    expect((await d.anchorChain({ ...o, from: reachLo - 3 })).chain.hashHexAt(reachLo - 3)).toBe(hashAt(reachLo - 3));
    expect(headersAsked()).toBe(n1);

    // another session (a reload): the saved run and the saved segment serve; no header is downloaded
    const c = await dapiFor([N(1), N(2)]).anchorChain({ ...o, from: reachLo - 10 });
    expect(c.stats.fetchedHeaders).toBe(0);
    expect(c.chain.hashHexAt(reachLo - 10)).toBe(hashAt(reachLo - 10));
  });

  it('rejects the run when it does not link to the pinned hash, and stores nothing', async () => {
    fake = installFakeDapi({ [N(1)]: node(), [N(2)]: node(), [N(3)]: node() });
    const pinStore = memoryStore<StoredPinned>();
    await expect(dapiFor([N(1), N(2), N(3)]).anchorChain({ ...base, proofSources: [source()], pinStore, pins: pins(reachLo - 7), from: reachLo - 9 }))
      .rejects.toThrow(/is not the pinned block/);
    expect(pinStore.saved).toBeNull();
  });

  it('fails when every node tampers with a header of the run (and passes over one that does)', async () => {
    fake = installFakeDapi({ [N(1)]: node({ flip: reachLo - 8 }), [N(2)]: node({ flip: reachLo - 8 }) });
    const pinStore = memoryStore<StoredPinned>();
    await expect(dapiFor([N(1), N(2)]).anchorChain({ ...base, proofSources: [source()], pinStore, pins: pins(), from: reachLo - 9 })).rejects.toThrow(/no node left|link/);
    expect(pinStore.saved).toBeNull();
    fake.restore();
    fake = installFakeDapi({ [N(1)]: node({ flip: reachLo - 8 }), [N(2)]: node(), [N(3)]: node() });
    const a = await dapiFor([N(1), N(2), N(3)]).anchorChain({ ...base, proofSources: [source()], pinStore, pins: pins(), from: reachLo - 9 });
    expect(a.chain.hashHexAt(reachLo - 8)).toBe(hashAt(reachLo - 8));
  });

  it('fails closed once when a stored run disagrees with the ChainLocked run, drops it, and links it afresh next time', async () => {
    fake = installFakeDapi({ [N(1)]: node(), [N(2)]: node() });
    // a pin above the run's bottom (as right after a checkpoint release), and a stored run up to it that overlaps the ChainLocked run
    const table: PinTable = { network: 'testnet', checkpoint: { height: reachLo + 5, blockHash: hashAt(reachLo + 5) }, pins: [[reachLo - 7, hashAt(reachLo - 7)], [reachLo + 5, hashAt(reachLo + 5)]] };
    const lo = reachLo - 2, seg = new Uint8Array((reachLo + 5 - lo + 1) * 32);
    for (let h = lo; h <= reachLo + 5; h++) seg.set(hashes.subarray((h - f.from) * 32, (h - f.from + 1) * 32), (h - lo) * 32);
    seg[(reachLo + 1 - lo) * 32]! ^= 1; // damaged at a height the ChainLocked run also has
    const pinStore = memoryStore<StoredPinned>();
    pinStore.saved = { version: 1, kind: 'pinned', network: 'testnet', checkpoint: reachLo + 5, segments: [{ pin: reachLo + 5, pinHash: hashAt(reachLo + 5), lo, prevOfLo: hashes.slice((lo - 1 - f.from) * 32, (lo - f.from) * 32), hashes: seg }] };
    const d = dapiFor([N(1), N(2)]);
    const o = { ...base, proofSources: [source()], pinStore, pins: table, from: lo };
    await expect(d.anchorChain(o)).rejects.toThrow(/disagree/);
    expect(pinStore.saved?.segments).toEqual([]);
    const a = await d.anchorChain(o);
    expect(a.chain.hashHexAt(lo)).toBe(hashAt(lo));
    expect(a.chain.hashHexAt(reachLo + 1)).toBe(hashAt(reachLo + 1));
    expect(pinStore.saved?.segments.map((x) => x.lo)).toEqual([lo]);
  });

  it('a block below the reach of any pin still walks down from the ChainLock, under the depth limit', async () => {
    fake = installFakeDapi({ [N(1)]: node(), [N(2)]: node() });
    const table: PinTable = { network: 'testnet', checkpoint: { height: f.from, blockHash: hashAt(f.from) }, pins: [[f.from, hashAt(f.from)]] };
    const a = await dapiFor([N(1), N(2)]).anchorChain({ ...base, proofSources: [source()], pins: table, from: f.from + 1 });
    expect(a.chain.lo).toBe(f.from + 1); // above the highest pin: the contiguous run, as before
    expect(a.stats.pinned?.fetched).toBe(0);
    // below every pin's reach: the old depth limit decides, as before
    await expect(dapiFor([N(1), N(2)]).anchorChain({ ...base, proofSources: [source()], pins: table, from: f.from - MAX_PIN_SPAN - 1, maxStoredHeights: 100 }))
      .rejects.toThrow(/too old to verify here/);
  });
});

describe('the masternode list within one session', () => {
  it('serves the next anchor again while its block stays within 8 of the new ChainLock, and is proven against the chain again', async () => {
    fake = installFakeDapi({ [N(1)]: node(), [N(2)]: node() });
    const d = dapiFor([N(1), N(2)]);
    const proofStore = memoryStore<StoredLinkedChain>();
    const a = await d.anchorChain({ ...base, proofSources: [source()], proofStore });
    const lists = () => fake!.calls.filter((c) => c.endsWith('subscribeToMasternodeList')).length;
    const n = lists();
    expect(n).toBeGreaterThan(0);
    const b = await d.anchorChain({ ...base, proofSources: [source()], proofStore, maxAgeMs: 0 });
    expect(b).not.toBe(a);
    expect(lists()).toBe(n);
    expect(b.stats.ms.smlReused).toBe(1);
    expect(b.sml.proof).toEqual(a.sml.proof);
    expect(b.chainLock).toMatchObject({ height: a.chainLock.height, blockHash: a.chainLock.blockHash });
  });

  it('downloads a new list once the ChainLock is more than 8 blocks above the kept one', async () => {
    fake = installFakeDapi({ [N(1)]: node(), [N(2)]: node() });
    const d = dapiFor([N(1), N(2)]);
    const v = await d.crypto();
    const signal = new AbortController().signal;
    const st: ProofAnchorState = { down: new Map() };
    const o = { ...base, proofSources: [source()] };
    let downloads = 0;
    const download = () => { downloads++; return fetchSml(d, { signal }); };
    await anchorByProof(d, st, o, v, x11Many, download, signal);
    expect(downloads).toBe(1);
    await anchorByProof(d, st, o, v, x11Many, download, signal);
    expect(downloads).toBe(1); // S = T: kept
    st.sml = { ...st.sml!, proof: { ...st.sml!.proof, height: f.target.height - 9 } };
    const c = await anchorByProof(d, st, o, v, x11Many, download, signal);
    expect(downloads).toBe(2);
    expect(c.sml.proof.height).toBe(f.target.height);
    expect(c.stats.ms.smlReused).toBeUndefined();
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
