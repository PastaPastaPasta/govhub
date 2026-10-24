import { describe, expect, it } from 'vitest';
import { bytesToHex, checkCollateralTx, collateralScript, concatBytes, governanceObjectHash, hexToBytes, parseTransaction, u32le, i64le, compactSize, uint256FromDisplay } from '../src/index.ts';
import { fixture } from './helpers.ts';

const props = fixture('proposals.regtest.json').proposals as Array<any>;
const scenarios = fixture('collateral.regtest.json').scenarios as Array<any>;
const plain = fixture('plaintx.regtest.json');

const rawHash = (p: any) => governanceObjectHash({ parentHash: p.parent, revision: p.revision, time: p.time, dataHex: p.dataHex }).raw;

describe('checkCollateralTx on real Core prepare transactions', () => {
  for (const p of props) {
    it(`accepts the gobject prepare collateral: ${p.label}`, () => {
      const r = checkCollateralTx(hexToBytes(p.rawTx), rawHash(p), { expectedTxid: p.txid });
      expect(r.failure).toBeUndefined();
      expect(r.valid).toBe(true);
      expect(r.txid).toBe(p.txid);
      expect(r.tx!.vout[r.opReturnIndex!]!.value).toBe(100_000_000n);
      // Core itself accepted the submission once synced
      expect(p.coreSubmit).toBe(p.coreHash);
    });

    it(`rejects mutated copies: ${p.label}`, () => {
      const tx = hexToBytes(p.rawTx);
      const h = rawHash(p);
      // wrong hash (one bit flipped)
      const bad = h.slice();
      bad[7]! ^= 1;
      expect(checkCollateralTx(tx, bad).failure).toBe('no-matching-op-return');
      // display (reversed) order hash is NOT what is committed
      expect(checkCollateralTx(tx, uint256FromDisplay(bytesToHex(h))).failure).toBe('no-matching-op-return');
      // hash of another proposal
      const other = props.find((x) => x !== p)!;
      expect(checkCollateralTx(tx, rawHash(other)).valid).toBe(false);
      // expected txid mismatch
      expect(checkCollateralTx(tx, h, { expectedTxid: '00'.repeat(32) }).failure).toBe('txid-mismatch');
      // flip a byte in the OP_RETURN script inside the raw tx
      const hex = p.rawTx as string;
      const at = hex.indexOf('6a20' + bytesToHex(h));
      expect(at).toBeGreaterThan(0);
      const flipped = hex.slice(0, at + 8) + (hex[at + 8] === '0' ? '1' : '0') + hex.slice(at + 9);
      expect(checkCollateralTx(hexToBytes(flipped), h).valid).toBe(false);
      // truncated / trailing garbage
      expect(checkCollateralTx(tx.subarray(0, tx.length - 1), h).failure).toBe('tx-parse-error');
      expect(checkCollateralTx(concatBytes(tx, Uint8Array.of(0)), h).failure).toBe('tx-parse-error');
    });
  }

  it('lowering the OP_RETURN value below 1 DASH is rejected (reports the underfunded value)', () => {
    const p = props[0];
    const hex = p.rawTx as string;
    const h = rawHash(p);
    const tx = parseTransaction(hexToBytes(hex));
    const idx = tx.vout.findIndex((o) => bytesToHex(o.script) === bytesToHex(collateralScript(h)));
    expect(idx).toBeGreaterThanOrEqual(0);
    // value field sits 8+1+34 bytes before the end of that output; patch by string search on value LE 00e1f50500000000
    const needle = '00e1f50500000000' + '22' + '6a20' + bytesToHex(h);
    expect(hex).toContain(needle);
    const patched = hex.replace(needle, 'ffe0f50500000000' + '22' + '6a20' + bytesToHex(h));
    const r = checkCollateralTx(hexToBytes(patched), h);
    expect(r.valid).toBe(false);
    expect(r.failure).toBe('no-matching-op-return');
    expect(r.underfundedValue).toBe(99_999_999n);
  });

  it('a plain wallet transaction is not a collateral', () => {
    expect(checkCollateralTx(hexToBytes(plain.rawTx), rawHash(props[0]), { expectedTxid: plain.txid }).valid).toBe(false);
  });
});

describe('checkCollateralTx agrees with Core on hand-built collateral variants (gobject submit verdicts)', () => {
  const expectedFailure: Record<string, string | undefined> = {
    'good-exact': undefined,
    'good-more-than-1-dash': undefined,
    'good-extra-unspendable-output': undefined,
    'good-hash-output-not-first': undefined,
    'bad-value-below-1-dash': 'no-matching-op-return',
    'bad-reversed-hash': 'no-matching-op-return',
    'bad-extra-p2sh-output': 'invalid-output-script',
    'bad-extra-p2pk-output': 'invalid-output-script',
    'bad-hash-plus-extra-byte': 'no-matching-op-return',
    'bad-no-op-return': 'no-matching-op-return',
  };
  for (const s of scenarios) {
    it(`${s.label}: Core accepted=${s.coreAccepted}`, () => {
      const r = checkCollateralTx(hexToBytes(s.rawTx), governanceObjectHash({ parentHash: s.parent, revision: s.revision, time: s.time, dataHex: s.dataHex }).raw, { expectedTxid: s.txid });
      expect(r.valid).toBe(s.coreAccepted);
      expect(r.failure).toBe(expectedFailure[s.label]);
    });
  }
  it('covers every scenario in the fixture', () => {
    expect(scenarios.map((s) => s.label).sort()).toEqual(Object.keys(expectedFailure).sort());
  });
});

describe('transaction parser', () => {
  it('parses a special transaction (version 3, type 5) with extra payload and hashes the payload into the txid', () => {
    const script = hexToBytes('76a914' + '11'.repeat(20) + '88ac');
    const input = concatBytes(new Uint8Array(32), u32le(0xffffffff), compactSize(0), u32le(0xffffffff));
    const payload = hexToBytes('0102030405');
    const build = (extra: Uint8Array) =>
      concatBytes(u32le(3 | (5 << 16)), compactSize(1), input, compactSize(1), i64le(5), compactSize(script.length), script, u32le(0), compactSize(extra.length), extra);
    const a = parseTransaction(build(payload));
    expect(a.version).toBe(3);
    expect(a.type).toBe(5);
    expect(bytesToHex(a.extraPayload!)).toBe('0102030405');
    const b = parseTransaction(build(hexToBytes('0102030406')));
    expect(a.txid).not.toBe(b.txid);
  });

  it('does not read an extra payload for version 3 type 0 or version 2', () => {
    const script = hexToBytes('6a');
    const input = concatBytes(new Uint8Array(32), u32le(0), compactSize(0), u32le(0xffffffff));
    const mk = (ver: number) => concatBytes(u32le(ver), compactSize(1), input, compactSize(1), i64le(1), compactSize(1), script, u32le(0));
    expect(parseTransaction(mk(3)).extraPayload).toBeNull();
    expect(parseTransaction(mk(2)).extraPayload).toBeNull();
  });

  it('rejects non-canonical CompactSize and absurd counts', () => {
    expect(() => parseTransaction(hexToBytes('02000000fd0100'))).toThrow();
    expect(() => parseTransaction(hexToBytes('02000000ffffffffffffffff'))).toThrow();
  });
});

describe('review hardening', () => {
  const p = props[0];
  const h = rawHash(p);
  const tx = hexToBytes(p.rawTx);

  it('an empty / wrong expectedTxid can never silently disable the txid binding', () => {
    expect(checkCollateralTx(tx, h, { expectedTxid: '' }).failure).toBe('txid-mismatch');
    expect(checkCollateralTx(tx, h, { expectedTxid: 'zz' }).failure).toBe('txid-mismatch');
    expect(checkCollateralTx(tx, h, { expectedTxid: p.txid.toUpperCase() }).valid).toBe(true);
    expect(checkCollateralTx(tx, h).valid).toBe(true); // documented: unbound when omitted
  });

  it('asset-unlock v2+ txid excludes the quorum signing info (stable txid); v1 and other types hash everything', () => {
    const script = hexToBytes('76a914' + '11'.repeat(20) + '88ac');
    const input = concatBytes(new Uint8Array(32), u32le(0xffffffff), compactSize(0), u32le(0xffffffff));
    const payload = (ver: number, tail: number) => concatBytes(Uint8Array.of(ver), new Uint8Array(8).fill(1), new Uint8Array(4).fill(2), new Uint8Array(132).fill(tail));
    const build = (type: number, pl: Uint8Array) =>
      concatBytes(u32le(3 | (type << 16)), compactSize(1), input, compactSize(1), i64le(5), compactSize(script.length), script, u32le(0), compactSize(pl.length), pl);
    const a = parseTransaction(build(9, payload(2, 0xaa)));
    const b = parseTransaction(build(9, payload(2, 0xbb)));
    expect(a.txid).toBe(b.txid); // re-signed instance, same txid
    expect(bytesToHex(a.instanceHashRaw)).not.toBe(bytesToHex(b.instanceHashRaw));
    const v1a = parseTransaction(build(9, payload(1, 0xaa)));
    const v1b = parseTransaction(build(9, payload(1, 0xbb)));
    expect(v1a.txid).not.toBe(v1b.txid);
    const other = parseTransaction(build(8, payload(2, 0xaa)));
    const other2 = parseTransaction(build(8, payload(2, 0xbb)));
    expect(other.txid).not.toBe(other2.txid);
    // the bytes before the tail still matter
    const c = parseTransaction(build(9, concatBytes(Uint8Array.of(2), new Uint8Array(8).fill(9), new Uint8Array(4).fill(2), new Uint8Array(132).fill(0xaa))));
    expect(c.txid).not.toBe(a.txid);
  });
});
