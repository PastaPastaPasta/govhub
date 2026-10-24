// Parsers, X11, ChainLock selection and BLS verification against data recorded from live mainnet (see scripts/record-fixtures.mjs).
import { describe, expect, it } from 'vitest';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { bytesToHex as hex, hexToBytes as unhex } from '@noble/hashes/utils.js';
import { blsVerify, verifyChainLock } from '../src/bls.ts';
import { hashBytes, hashHex, sha256d } from '../src/bytes.ts';
import { CHAINLOCK_PARAMS, chainLockCandidateSets, chainLockRequestId, chainLockSignHash, quorumScore, selectQuorum } from '../src/chainlock.ts';
import {
  classifyScript, coinbaseHeight, parseBlock, parseChainLock, parseHeader, parseInstantLock, parseMerkleBlock, parseTx,
} from '../src/dash.ts';
import { LLMQ_TYPE, parseSml, quorumsOfType, type SmlQuorum } from '../src/sml.ts';
import { blockHashHex, x11 } from '../src/x11.ts';
import { collateralRaw, fx } from './fixtures.ts';
import { encodeCbor } from './helpers/cbor-encode.ts';

const bls = bls12_381.longSignatures;

describe('transactions and blocks', () => {
  it('parses the mainnet governance collateral tx (txid, OP_RETURN, value)', () => {
    const tx = parseTx(collateralRaw);
    expect(tx.txid).toBe('3451d292d461d1255007392a43d0da7b47eed938ff9a1234fb06ae19157fa365');
    expect(tx.outputs.length).toBe(2);
    const op = classifyScript(tx.outputs[1]!.script);
    expect(op.type).toBe('op_return');
    expect(op.type === 'op_return' && hex(op.data!)).toBe('cbc458f8a65a1f607f3acfa825b39f2f9b2748bdd0893bd5c0b911881eaf2fe9');
    expect(tx.outputs[1]!.value).toBe(100000000n);
  });
  it('rejects trailing bytes and truncated transactions', () => {
    expect(() => parseTx(new Uint8Array([...collateralRaw, 0]))).toThrow(/trailing/);
    expect(() => parseTx(collateralRaw.subarray(0, 100))).toThrow(/truncated/);
  });
  it('classifies p2pkh and p2sh scripts', () => {
    const h = new Uint8Array(20).fill(7);
    expect(classifyScript(Uint8Array.from([0x76, 0xa9, 0x14, ...h, 0x88, 0xac])).type).toBe('p2pkh');
    expect(classifyScript(Uint8Array.from([0xa9, 0x14, ...h, 0x87])).type).toBe('p2sh');
    expect(classifyScript(Uint8Array.of(0x51)).type).toBe('other');
  });
  it('recomputes a real block merkle root and finds the tx; a flipped byte breaks it', () => {
    expect(fx.blockParsed.merkleOk).toBe(true);
    expect(fx.blockParsed.txs.some((t) => t.txid === fx.txid)).toBe(true);
    const bad = Uint8Array.from(fx.block);
    bad[bad.length - 5]! ^= 1;
    expect(parseBlock(bad).merkleOk).toBe(false); // a changed tx changes its txid
    expect(() => parseBlock(new Uint8Array([...fx.block, 0]))).toThrow(/trailing/);
    const flipped = Uint8Array.from(fx.block); flipped[36]! ^= 1; // merkle root byte in the header
    expect(parseBlock(flipped).merkleOk).toBe(false);
  });
  it('the coinbase commits to the block height (DIP4 payload)', () => {
    expect(coinbaseHeight(fx.blockParsed.txs[0]!)).toBe(fx.height);
    for (const [hash, raw] of Object.entries(fx.quorumBlocks)) {
      const h = coinbaseHeight(parseBlock(raw).txs[0]!);
      expect(h! % 288).toBe(0); // quorum base blocks sit on DKG interval boundaries
      expect(blockHashHex(parseHeader(raw.subarray(0, 80)).raw)).toBe(hash);
    }
  });
  it('parses a real merkleblock: partial tree reaches the header root and contains the tx', () => {
    const mb = parseMerkleBlock(unhex(fx.rec.merkleblock.hex));
    expect(mb.rootOk).toBe(true);
    expect(mb.matched).toContain(fx.rec.merkleblock.txid);
    const bad = unhex(fx.rec.merkleblock.hex); bad[40]! ^= 1; // merkle root byte
    expect(parseMerkleBlock(bad).rootOk).toBe(false);
  });
  it('rejects hostile merkleblock tx counts', () => {
    const b = new Uint8Array(80 + 4 + 1 + 1); new DataView(b.buffer).setUint32(80, 0xffffffff, true);
    expect(() => parseMerkleBlock(b)).toThrow(/bad tx count/);
    new DataView(b.buffer).setUint32(80, 0, true);
    expect(() => parseMerkleBlock(b)).toThrow(/bad tx count/);
  });
  it('parses real ISDLOCKs, pairs them with their tx, and rejects unknown versions and trailing bytes', () => {
    expect(fx.rec.firehose.islocks.length).toBeGreaterThan(0);
    for (const l of fx.rec.firehose.islocks) {
      const lock = parseInstantLock(unhex(l.hex));
      expect(lock.txid).toBe(l.txid);
      expect(parseTx(unhex(l.rawTxHex)).txid).toBe(l.txid);
      expect(lock.signature.length).toBe(96);
      expect(lock.inputs.length).toBe(parseTx(unhex(l.rawTxHex)).inputs.length);
      expect(() => parseInstantLock(new Uint8Array([...unhex(l.hex), 0]))).toThrow(/trailing/);
      const v2 = unhex(l.hex); v2[0] = 2;
      expect(() => parseInstantLock(v2)).toThrow(/version/);
    }
  });
  it('parses a real CLSIG: 132 bytes', () => {
    expect(fx.chainLockBytes.length).toBe(132);
    expect(fx.chainLock.height).toBeGreaterThan(fx.height);
    expect(() => parseChainLock(new Uint8Array(133))).toThrow(/trailing/);
  });
});

describe('X11', () => {
  const le = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return hex(b); };
  it('hashes the Dash mainnet genesis header to the genesis block hash', () => {
    const merkle = hashBytes('e0028eb9648db56b1ac77cf090b99048a8007e2bb64b68f092c03c7f56a662c7');
    const header = unhex(le(1) + '00'.repeat(32) + hex(merkle) + le(1390095618) + le(0x1e0ffff0) + le(28917698));
    expect(blockHashHex(header)).toBe('00000ffd590b1485b3caadc19b22e6379c733355108f107a430458cdf3407ab6');
  });
  it('real headers across eras chain: X11(header n) is header n+1 prevHash', () => {
    for (const p of fx.rec.headerPairs) {
      expect(blockHashHex(unhex(p.headerHex))).toBe(p.hash);
      expect(parseHeader(unhex(p.nextHeaderHex)).prevHash).toBe(p.hash);
    }
  });
  it('a streamed header chain links end to end and ends at the claimed tx block', () => {
    expect(blockHashHex(fx.headers[0]!)).toBe(fx.blockHash);
    for (let i = 1; i < fx.headers.length; i++) expect(parseHeader(fx.headers[i]!).prevHash).toBe(hashHex(x11(fx.headers[i - 1]!)));
    expect(hashHex(x11(fx.headers[fx.chainLock.height - fx.height]!))).toBe(fx.chainLock.blockHash);
  });
  it('rejects anything but an 80-byte header', () => {
    expect(() => x11(new Uint8Array(79))).toThrow(/80-byte/);
  });
});

describe('SML parsing', () => {
  it('parses the recorded (trimmed) SML: tip, height from cbTx, quorums, evonode endpoints, digest', () => {
    const s = fx.sml;
    expect(s.blockHash).toBe(fx.chainLock.blockHash);
    expect(s.height).toBe(fx.chainLock.height);
    expect(quorumsOfType(s, LLMQ_TYPE.LLMQ_400_60).length).toBe(4);
    expect(s.evonodes.length).toBe(4);
    expect(s.evonodes.every((e) => /^[\d.]+:\d+$/.test(e.endpoint))).toBe(true);
    expect(s.digest).toBe(parseSml(fx.smlBytes).digest);
    expect(s.digest).toMatch(/^[0-9a-f]{64}$/);
  });
  it('the digest changes when a quorum key changes', () => {
    const a = parseSml(fx.smlBytes);
    const raw = hex(fx.smlBytes), key = quorumsOfType(a, 2)[0]!.quorumPublicKey;
    const tampered = parseSml(unhex(raw.replace(hex(new TextEncoder().encode(key)), hex(new TextEncoder().encode(key.replace(/^./, key[0] === 'a' ? 'b' : 'a'))))));
    expect(tampered.digest).not.toBe(a.digest);
  });
  it('drops evonode endpoints that are not host:port, and the digest covers the tip height', () => {
    const ok = { blockHash: '00'.repeat(32), baseBlockHash: '00'.repeat(32), merkleRootMNList: '11'.repeat(32), merkleRootQuorums: '22'.repeat(32), newQuorums: [] };
    const mn = (endpoint: string) => ({ nType: 1, isValid: true, proRegTxHash: 'aa'.repeat(32), addresses: { platform_https: [endpoint] } });
    const s = parseSml(encodeCbor({ ...ok, mnList: [mn('1.2.3.4:443'), mn('evil.com/x#:443'), mn('http://a:1'), mn('a b:1')] }));
    expect(s.evonodes.map((e) => e.endpoint)).toEqual(['1.2.3.4:443']);
    expect(s.evonodeCount).toBe(4);
    const bumped = (blockHeight: number) => parseSml(encodeCbor({ ...ok, mnList: [], cbTx: hex(withHeight(blockHeight)) })).digest;
    expect(bumped(100)).not.toBe(bumped(101));
  });
  it('keeps every masternode with its voting address, type and validity, and the digest covers them (agreement across nodes means agreement on voting keys)', () => {
    const ok = { blockHash: '00'.repeat(32), baseBlockHash: '00'.repeat(32), merkleRootMNList: '11'.repeat(32), merkleRootQuorums: '22'.repeat(32), newQuorums: [] };
    const mn = (p: string, votingAddress: string, nType = 0, isValid = true) => ({ nType, isValid, proRegTxHash: p.repeat(32), votingAddress });
    const list = [mn('aa', 'Xvoting1'), mn('BB', 'Xvoting2', 1, false), { nType: 0, isValid: true, proRegTxHash: 'cc'.repeat(32) }];
    const s = parseSml(encodeCbor({ ...ok, mnList: list }));
    expect(s.masternodes).toEqual([
      { proTxHash: 'aa'.repeat(32), votingAddress: 'Xvoting1', nType: 0, isValid: true },
      { proTxHash: 'bb'.repeat(32), votingAddress: 'Xvoting2', nType: 1, isValid: false }, // a banned masternode is listed, flagged invalid
    ]);
    const digest = (l: Array<ReturnType<typeof mn>>) => parseSml(encodeCbor({ ...ok, mnList: l })).digest;
    expect(digest([mn('aa', 'Xvoting1'), mn('BB', 'Xvoting2', 1, false)])).toBe(digest([mn('BB', 'Xvoting2', 1, false), mn('aa', 'Xvoting1')]));
    expect(digest([mn('aa', 'Xvoting1')])).not.toBe(digest([mn('aa', 'Xvoting9')]));
    expect(digest([mn('aa', 'Xvoting1')])).not.toBe(digest([mn('aa', 'Xvoting1', 0, false)]));
  });
  it('rejects malformed diffs', () => {
    const ok = { blockHash: '00'.repeat(32), baseBlockHash: '00'.repeat(32), merkleRootMNList: '11'.repeat(32), merkleRootQuorums: '22'.repeat(32), mnList: [], newQuorums: [] };
    expect(parseSml(encodeCbor(ok)).quorums).toEqual([]);
    expect(() => parseSml(encodeCbor({ ...ok, blockHash: 'zz' }))).toThrow(/blockHash/);
    expect(() => parseSml(encodeCbor({ ...ok, mnList: 5 }))).toThrow(/mnList/);
    expect(() => parseSml(encodeCbor({ ...ok, newQuorums: [{ llmqType: 2, quorumHash: '00'.repeat(32), quorumPublicKey: 'ab', quorumVvecHash: '00'.repeat(32) }] }))).toThrow(/quorumPublicKey/);
    expect(() => parseSml(encodeCbor([1]))).toThrow(/not a map/);
  });
});

function withHeight(h: number): Uint8Array {
  // minimal coinbase v3 type 5 with a DIP4 payload (version u16, height u32)
  const payload = new Uint8Array(6); new DataView(payload.buffer).setUint16(0, 2, true); new DataView(payload.buffer).setUint32(2, h, true);
  const input = [...new Uint8Array(32), 0xff, 0xff, 0xff, 0xff, 1, 0x51, 0xff, 0xff, 0xff, 0xff];
  return Uint8Array.from([3, 0, 5, 0, 1, ...input, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x51, 0, 0, 0, 0, payload.length, ...payload]);
}

// ---- ChainLock rules ----
const mainnet = CHAINLOCK_PARAMS.mainnet;
const withHeights = (): SmlQuorum[] => quorumsOfType(fx.sml, 2).map((q) => ({ ...q, baseHeight: coinbaseHeight(parseBlock(fx.quorumBlocks[q.quorumHash]!).txs[0]!)! }));

describe('ChainLock verification on a real mainnet CLSIG', () => {
  it('verifies, selects exactly Core\'s quorum (rank 0 of the set), and says so', () => {
    const quorums = withHeights();
    const r = verifyChainLock(fx.chainLock, quorums, { smlHeight: fx.sml.height });
    expect(r).toMatchObject({ ok: true, exact: true });
    const sets = chainLockCandidateSets(quorums, fx.chainLock.height, mainnet, fx.sml.height);
    const winner = selectQuorum(sets.sets[0]!, 2, chainLockRequestId(fx.chainLock.height))!;
    expect(r.ok && r.quorumHash).toBe(winner.quorumHash);
  });
  it('rejects a tampered height, block hash or signature', () => {
    const quorums = withHeights();
    const cl = fx.chainLock;
    expect(verifyChainLock({ ...cl, height: cl.height - 1 }, quorums).ok).toBe(false);
    const bh = Uint8Array.from(cl.blockHashInternal); bh[0]! ^= 1;
    expect(verifyChainLock({ ...cl, blockHashInternal: bh }, quorums).ok).toBe(false);
    const sig = Uint8Array.from(cl.signature); sig[5]! ^= 1;
    expect(verifyChainLock({ ...cl, signature: sig }, quorums).ok).toBe(false);
    expect(blsVerify(new Uint8Array(96), new Uint8Array(32), new Uint8Array(48))).toBe(false); // garbage never throws
  });
  it('the reversed (display-order) hash variants do NOT verify: byte order matters', () => {
    const q = selectQuorum(withHeights(), 2, chainLockRequestId(fx.chainLock.height))!;
    const rid = chainLockRequestId(fx.chainLock.height);
    const good = chainLockSignHash(2, q.quorumHash, rid, fx.chainLock.blockHashInternal);
    const key = unhex(q.quorumPublicKey);
    expect(blsVerify(fx.chainLock.signature, good, key)).toBe(true);
    const bad = chainLockSignHash(2, q.quorumHash, rid, Uint8Array.from(fx.chainLock.blockHashInternal).reverse());
    expect(blsVerify(fx.chainLock.signature, bad, key)).toBe(false);
  });
  it('demands base heights', () => {
    expect(() => verifyChainLock(fx.chainLock, quorumsOfType(fx.sml, 2))).toThrow(/base heights/);
  });
});

describe('chainLockRequestId / sign hash layout', () => {
  it('requestId = sha256d(0x05 "clsig" height_le32)', () => {
    const m = new Uint8Array(10); m[0] = 5; m.set(new TextEncoder().encode('clsig'), 1); new DataView(m.buffer).setUint32(6, 2560430, true);
    expect(hex(chainLockRequestId(2560430))).toBe(hex(sha256d(m)));
  });
});

// Synthetic quorums with real BLS keys so every selection branch can be signed for.
interface Synth extends SmlQuorum { sk: Uint8Array }
const synth = (cycle: number): Synth => {
  const { secretKey, publicKey } = bls.keygen();
  return {
    llmqType: 2, quorumHash: hex(sha256d(Uint8Array.of(cycle))), quorumIndex: 0, quorumPublicKey: hex(publicKey.toBytes()),
    quorumVvecHash: '00'.repeat(32), baseHeight: cycle * 288, sk: secretKey,
  };
};
const sign = (q: Synth, height: number, blockHashInternal: Uint8Array): Uint8Array =>
  bls.sign(bls.hash(chainLockSignHash(2, q.quorumHash, chainLockRequestId(height), blockHashInternal)), q.sk).toBytes();
const mk = (q: Synth, height: number) => {
  const blockHashInternal = sha256d(Uint8Array.of(height & 255, height >> 8));
  return { height, blockHash: hashHex(blockHashInternal), blockHashInternal, signature: sign(q, height, blockHashInternal) };
};

describe('Core quorum-set selection (quorumsman.cpp ScanQuorums window rules)', () => {
  const [q30, q31, q32, q33, q34] = [30, 31, 32, 33, 34].map(synth) as [Synth, Synth, Synth, Synth, Synth];
  const tip33 = [q30, q31, q32, q33], tip34 = [q31, q32, q33, q34];
  const hashes = (sets: SmlQuorum[][]) => sets.map((s) => s.map((q) => q.baseHeight! / 288));

  it('after the mining window the store block is the window end: all four quorums, complete', () => {
    const r = chainLockCandidateSets(tip33, 33 * 288 + 100 + 8, mainnet);
    expect(hashes(r.sets)).toEqual([[33, 32, 31, 30]]);
    expect(r.complete).toEqual([true]);
  });
  it('before the window the newest quorum is not active yet, so a tip-only SML is incomplete', () => {
    const r = chainLockCandidateSets(tip33, 33 * 288 + 5 + 8, mainnet);
    expect(hashes(r.sets)).toEqual([[32, 31, 30]]);
    expect(r.complete).toEqual([false]);
  });
  it('inside the window both possibilities are offered (the SML does not say when the commitment was mined)', () => {
    const r = chainLockCandidateSets(tip33, 33 * 288 + 24 + 8, mainnet);
    expect(hashes(r.sets)).toEqual([[33, 32, 31, 30], [32, 31, 30]]);
    expect(r.complete).toEqual([true, false]); // only the set that includes the new quorum is as big as Core's
  });
  it('the window end block itself already includes the quorum; the window start does not decide', () => {
    expect(hashes(chainLockCandidateSets(tip33, 33 * 288 + 28 + 8, mainnet).sets)).toEqual([[33, 32, 31, 30]]);
    expect(hashes(chainLockCandidateSets(tip33, 33 * 288 + 20 + 8, mainnet).sets)).toEqual([[33, 32, 31, 30], [32, 31, 30]]);
    expect(hashes(chainLockCandidateSets(tip33, 33 * 288 + 19 + 8, mainnet).sets)).toEqual([[32, 31, 30]]);
  });
  it('only the newest four count, even when the SML holds older ones', () => {
    const r = chainLockCandidateSets([q30, ...tip34], 34 * 288 + 100 + 8, mainnet);
    expect(hashes(r.sets)).toEqual([[34, 33, 32, 31]]);
  });
  it('no quorum below genesis and nothing for heights under the sign offset', () => {
    expect(chainLockCandidateSets(tip33, 7, mainnet).sets).toEqual([]);
    expect(chainLockCandidateSets(tip33, 8 + 10, mainnet).sets).toEqual([]); // window end 28 < 288: before the first cycle
  });
  it('flags a stale SML when the store block is newer than the SML tip', () => {
    expect(chainLockCandidateSets(tip33, 34 * 288 + 100 + 8, mainnet, 33 * 288 + 200).stale).toBe(true);
    expect(chainLockCandidateSets(tip33, 33 * 288 + 100 + 8, mainnet, 33 * 288 + 200).stale).toBe(false);
  });
  it('selection is the lowest raw-byte score, not a numeric or reversed compare', () => {
    const rid = chainLockRequestId(777);
    const best = selectQuorum(tip34, 2, rid)!;
    for (const q of tip34) if (q !== best) expect(Buffer.compare(quorumScore(2, best.quorumHash, rid), quorumScore(2, q.quorumHash, rid))).toBeLessThan(0);
  });

  it('accepts a lock signed by the rank-0 quorum and rejects one signed by any other active quorum', () => {
    const height = 34 * 288 + 100 + 8;
    const rid = chainLockRequestId(height);
    const ranked = [...tip34].sort((a, b) => Buffer.compare(quorumScore(2, a.quorumHash, rid), quorumScore(2, b.quorumHash, rid)));
    expect(verifyChainLock(mk(ranked[0]!, height), tip34)).toMatchObject({ ok: true, exact: true, quorumHash: ranked[0]!.quorumHash });
    const other = verifyChainLock(mk(ranked[1]!, height), tip34);
    expect(other).toMatchObject({ ok: false, reason: 'bad-signature', exact: true });
  });
  it('inside a window accepts whichever candidate set really signed', () => {
    const height = 34 * 288 + 24 + 8;
    const rid = chainLockRequestId(height);
    const byScore = (qs: Synth[]) => [...qs].sort((a, b) => Buffer.compare(quorumScore(2, a.quorumHash, rid), quorumScore(2, b.quorumHash, rid)))[0]!;
    expect(verifyChainLock(mk(byScore(tip34), height), tip34)).toMatchObject({ ok: true, exact: true }); // q34 already mined: complete set
    const old = verifyChainLock(mk(byScore([q31, q32, q33]), height), tip34); // q34 not yet mined: Core's set also holds q30, which the SML lacks
    expect(old).toMatchObject({ ok: true, exact: byScore(tip34) === byScore([q31, q32, q33]) });
  });
  it('an incomplete SML accepts any known quorum of the set but reports exact: false', () => {
    const height = 33 * 288 + 5 + 8; // needs q29, which a tip-only SML lacks
    const r = verifyChainLock(mk(q31, height), tip33);
    expect(r).toMatchObject({ ok: true, exact: false });
  });
  it('a stale SML fails with stale-sml so the client refetches', () => {
    const height = 35 * 288 + 100 + 8;
    expect(verifyChainLock(mk(q34, height), tip34, { smlHeight: 34 * 288 + 200 })).toMatchObject({ ok: false, reason: 'stale-sml' });
  });
  it('no quorum of the chain-lock type at all', () => {
    expect(verifyChainLock(mk(q34, 34 * 288 + 108), [])).toMatchObject({ ok: false, reason: 'no-quorum' });
  });
});
