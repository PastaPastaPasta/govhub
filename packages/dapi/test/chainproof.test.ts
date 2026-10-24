// Header rules (PoW, DGW, MTP), the verified header run, and SML proofs, against recorded mainnet and testnet data.
import { describe, expect, it } from 'vitest';
import { hashBytes, hashHex, hex, unhex } from '../src/bytes.ts';
import { parseBlock, parseHeader, parseTx } from '../src/dash.ts';
import { CHECKPOINTS, DGW_WINDOW, HeaderChain } from '../src/headerchain.ts';
import { POW_PARAMS, checkProofOfWork, compactToTarget, medianTimePast, nextWorkRequired, targetToCompact, type HeaderTiming } from '../src/pow.ts';
import { commitmentBytes, mnListMerkleRoot, parseCbTx, proveSml, quorumsMerkleRoot, smlEntryBytes } from '../src/smlproof.ts';
import { x11Many } from '../src/x11.ts';
import { loadAnchorFixture, runOf } from './anchor-fixtures.ts';

const nets = { mainnet: loadAnchorFixture('mainnet'), testnet: loadAnchorFixture('testnet') };
const clone = <T>(x: T): T => structuredClone(x);
const timing = (h: Uint8Array): HeaderTiming => { const p = parseHeader(h); return { bits: p.bits, time: p.time }; };

describe('compact targets (arith_uint256 SetCompact/GetCompact)', () => {
  it('matches Bitcoin Core arith_uint256_tests vectors', () => {
    expect(compactToTarget(0x01123456).target).toBe(0x12n);
    expect(compactToTarget(0x02123456).target).toBe(0x1234n);
    expect(compactToTarget(0x04123456).target).toBe(0x12345600n);
    expect(compactToTarget(0x05009234).target).toBe(0x92340000n);
    expect(compactToTarget(0x04923456)).toMatchObject({ target: 0x12345600n, negative: true });
    expect(compactToTarget(0x20123456).target).toBe(0x1234560000000000000000000000000000000000000000000000000000000000n);
    expect(compactToTarget(0xff123456).overflow).toBe(true);
    expect(compactToTarget(0x00123456).target).toBe(0n);
    expect(targetToCompact(0x12345600n)).toBe(0x04123456);
    expect(targetToCompact(0x92340000n)).toBe(0x05009234);
    expect(targetToCompact(POW_PARAMS.mainnet.powLimit)).toBe(0x1e0fffff);
  });
});

describe.each(Object.entries(nets))('%s header rules on recorded headers', (net, f) => {
  const pow = POW_PARAMS[net as 'mainnet'];
  it('every header after the first 24 has exactly the nBits DGW computes, valid work and a time above MTP', () => {
    const ts: HeaderTiming[] = [];
    let minDiffRule = 0;
    for (let h = f.from; h <= f.top; h++) {
      const t = timing(f.header(h));
      if (ts.length >= DGW_WINDOW) {
        expect(nextWorkRequired(ts, t.time, pow), `bits at ${h}`).toBe(t.bits);
        expect(t.time).toBeGreaterThan(medianTimePast(ts));
        if (pow.allowMinDifficulty && t.time > ts[ts.length - 1]!.time + 600) minDiffRule++;
      }
      expect(checkProofOfWork(hashBytes(f.hashAt(h)), t.bits, pow)).toBe(true);
      ts.push(t);
    }
    if (net === 'testnet') expect(minDiffRule).toBeGreaterThan(0); // the testnet run exercises the min-difficulty rule
  });

  it('rejects a hash above the target and a target above powLimit', () => {
    const t = timing(f.header(f.top));
    expect(checkProofOfWork(new Uint8Array(32).fill(0xff), t.bits, pow)).toBe(false);
    expect(checkProofOfWork(new Uint8Array(32), 0x1f0fffff, pow)).toBe(false);
  });
});

describe.each(Object.entries(nets))('%s HeaderChain', (net, f) => {
  const o = { pow: POW_PARAMS[net as 'mainnet'], now: f.now };
  const network = net as 'mainnet';
  it('verifies a run from a checkpoint and extends down and up', () => {
    const mid = f.from + 600;
    const cp = { height: mid, hash: f.hashAt(mid) };
    const c = HeaderChain.fromCheckpoint(network, cp, runOf(f, mid - DGW_WINDOW, mid + 400), o);
    expect([c.lo, c.hi]).toEqual([mid - DGW_WINDOW, mid + 400]);
    c.extendUp(runOf(f, mid + 401, f.top), o);
    c.extendDown(runOf(f, f.from, mid - DGW_WINDOW - 1));
    expect([c.lo, c.hi]).toEqual([f.from, f.top]);
    for (const h of [f.from, mid, f.top]) expect(c.hashHexAt(h)).toBe(f.hashAt(h));
    expect(c.hashAt(f.top + 1)).toBeNull();
    expect(c.rawAt(f.top)).toEqual(f.header(f.top));
  });

  it('refuses a wrong pin, a broken link, wrong bits, bad work, an early or a future timestamp', () => {
    const cp = f.checkpoint;
    expect(() => HeaderChain.fromCheckpoint(network, { ...cp, hash: f.hashAt(cp.height + 1) }, runOf(f, f.from, f.from + 100), o)).toThrow(/not the pinned checkpoint/);
    expect(() => HeaderChain.fromCheckpoint(network, cp, runOf(f, f.from + 1, f.from + 100), o)).toThrow(/24 headers below/);
    const tamper = (h: number, at: number, v: number) => {
      const r = runOf(f, f.from, f.from + 200);
      r.headers[(h - f.from) * 80 + at] = v;
      return r;
    };
    // a changed header no longer hashes to its successor's prevHash: the failure names the successor
    const link = tamper(f.from + 100, 0, f.header(f.from + 100)[0]! ^ 1);
    link.hashes = x11Many(link.headers); // hashes are always computed locally from the headers
    expect(() => HeaderChain.fromCheckpoint(network, cp, link, o)).toThrow(expect.objectContaining({ height: f.from + 101 }));
    // the same change with consistent hashes (a node that mined its own header): the rules catch it at that height
    const bits = runOf(f, f.from, f.from + 200);
    const at = 150, view = new DataView(bits.headers.buffer);
    view.setUint32(at * 80 + 72, view.getUint32(at * 80 + 72, true) + 1, true);
    const c = HeaderChain.fromCheckpoint(network, cp, runOf(f, f.from, f.from + at - 1), o);
    expect(() => c.extendUp({ from: f.from + at, headers: bits.headers.slice(at * 80, (at + 1) * 80), hashes: bits.hashes.slice(at * 32, (at + 1) * 32) }, o)).toThrow(/Dark Gravity Wave/);
    expect(() => c.extendUp(runOf(f, f.from + at, f.from + at + 5), { ...o, now: parseHeader(f.header(f.from + at)).time - 3 * 3600 })).toThrow(/future/);
    const fake = runOf(f, f.from + at, f.from + at);
    fake.hashes.fill(0xff); // hash way above target
    expect(() => c.extendUp(fake, o)).toThrow(/proof of work/);
    expect(() => c.extendUp(runOf(f, f.from + at + 1, f.from + at + 2), o)).toThrow(/expected/);
  });

  it('stores only up to the ChainLock and resumes from the store', () => {
    const c = HeaderChain.fromCheckpoint(network, f.checkpoint, runOf(f, f.from, f.top), o);
    const lock = { height: f.top - 3, blockHash: f.hashAt(f.top - 3) };
    const s = c.toStored(lock, 500)!;
    expect(s.lo).toBe(lock.height - 499);
    expect(s.hashes.length).toBe(500 * 32);
    expect(hex(s.prevOfLo)).toBe(hex(hashBytes(f.hashAt(s.lo - 1))));
    const r = HeaderChain.fromStored(s, f.checkpoint)!;
    expect([r.lo, r.hi]).toEqual([lock.height - 499, lock.height]);
    r.extendUp(runOf(f, lock.height + 1, f.top), o); // the stored DGW window continues exactly
    r.extendDown(runOf(f, f.from, s.lo - 1));
    expect(r.hashHexAt(f.from)).toBe(f.hashAt(f.from));
    expect(HeaderChain.fromStored(s, CHECKPOINTS[network])).toBeNull(); // a different pin invalidates the cache
    expect(c.toStored({ ...lock, blockHash: f.hashAt(f.top) })).toBeNull();
  });
});

describe.each(Object.entries(nets))('%s SML proof', (net, f) => {
  it('recomputes merkleRootMNList and merkleRootQuorums and proves the coinbase into the block', () => {
    const p = proveSml(f.sml);
    expect(p.blockHash).toBe(f.sml.blockHash);
    expect(f.hashAt(p.height)).toBe(p.blockHash);
    expect(parseHeader(f.header(p.height)).merkleRoot).toBe(p.blockMerkleRoot);
    expect(p.mnListRoot).toBe(f.sml.merkleRootMNList);
    expect(p.quorumsRoot).toBe(f.sml.merkleRootQuorums);
    expect(p.cbTx.version).toBe(net === 'mainnet' ? 3 : 4); // testnet runs v24 (CbTx v4 with the asset-unlock root)
  });

  it('does not commit the type of version-1 entries (proven separately, by the ProRegTx)', () => {
    const d = clone(f.sml);
    const e = (d.mnList as Record<string, unknown>[]).find((x) => x.nVersion === 1 && x.nType === 0)!;
    e.nType = 1;
    expect(proveSml(d).mnListRoot).toBe(f.sml.merkleRootMNList);
  });

  it('covers every entry version in use', () => {
    const versions = new Set((f.sml.mnList as Array<{ nVersion: number; nType: number }>).map((m) => `${m.nVersion}/${m.nType}`));
    expect(versions).toEqual(new Set(net === 'mainnet' ? ['1/0', '1/1', '2/0', '2/1'] : ['1/0', '1/1', '2/0', '2/1', '3/0', '3/1']));
  });

  it.each([
    ['a voting key', (e: Record<string, unknown>, all: Record<string, unknown>[]) => { e.votingAddress = all.find((x) => x.votingAddress !== e.votingAddress)!.votingAddress; }],
    ['validity', (e: Record<string, unknown>) => { e.isValid = !e.isValid; }],
    ['the type of a version-2 entry', (e: Record<string, unknown>) => { e.nType = e.nType === 1 ? 0 : 1; }],
    ['the operator key', (e: Record<string, unknown>) => { e.pubKeyOperator = (e.pubKeyOperator as string).replace(/^../, 'aa'); }],
  ])('fails when %s of one masternode changes', (_, edit) => {
    const d = clone(f.sml);
    const list = d.mnList as Record<string, unknown>[];
    edit(list.filter((e) => e.nVersion === 2)[7]!, list);
    expect(() => proveSml(d)).toThrow(/merkleRootMNList mismatch|platformNodeID|platform HTTP|not/);
  });

  it('fails when a masternode is dropped or a quorum key changes', () => {
    const d = clone(f.sml);
    (d.mnList as unknown[]).splice(3, 1);
    expect(() => proveSml(d)).toThrow(/merkleRootMNList mismatch/);
    const q = clone(f.sml);
    const quorum = (q.newQuorums as Record<string, string>[])[0]!;
    quorum.quorumPublicKey = (f.sml.newQuorums as Record<string, string>[])[1]!.quorumPublicKey!;
    expect(() => proveSml(q)).toThrow(/merkleRootQuorums mismatch/);
  });

  it('refuses a partial list, another coinbase, or a tree that does not prove the coinbase', () => {
    expect(() => proveSml({ ...clone(f.sml), baseBlockHash: f.hashAt(f.from) })).toThrow(/not a full list/);
    expect(() => proveSml({ ...clone(f.sml), deletedMNs: [f.hashAt(f.from)] })).toThrow(/cannot delete/);
    const other = parseBlock(f.superblock.block).txs[0]!;
    expect(() => proveSml({ ...clone(f.sml), cbTx: hex(other.raw) })).toThrow(/does not prove the coinbase|mismatch/);
  });

  it('serializes entries and commitments byte for byte', () => {
    const list = f.sml.mnList as Record<string, unknown>[];
    expect(hashHex(mnListMerkleRoot(list).root)).toBe(f.sml.merkleRootMNList);
    expect(hashHex(quorumsMerkleRoot(f.sml.newQuorums as Record<string, unknown>[]))).toBe(f.sml.merkleRootQuorums);
    const legacy = list.find((e) => e.nVersion === 1 && e.isValid)!;
    expect(smlEntryBytes(legacy).length).toBe(32 + 32 + 18 + 48 + 20 + 1); // no nType for version 1
    const evo2 = list.find((e) => e.nVersion === 2 && e.nType === 1 && e.isValid)!;
    expect(smlEntryBytes(evo2).length).toBe(32 + 32 + 18 + 48 + 20 + 1 + 2 + 2 + 20);
    const q = (f.sml.newQuorums as Record<string, unknown>[])[0]!;
    expect(commitmentBytes(q).subarray(0, 2)).toEqual(Uint8Array.of(q.version as number, 0));
  });
});

describe('CbTx payloads', () => {
  it('parses v3 (mainnet) and v4 (testnet) coinbases', () => {
    const v3 = parseCbTx(parseTx(unhex(nets.mainnet.sml.cbTx as string)));
    expect([v3.version, v3.bestCLSignature?.length, v3.merkleRootAssetUnlocks]).toEqual([3, 96, null]);
    const v4 = parseCbTx(parseTx(unhex(nets.testnet.sml.cbTx as string)));
    expect([v4.version, v4.merkleRootAssetUnlocks?.length]).toEqual([4, 32]);
  });
});
