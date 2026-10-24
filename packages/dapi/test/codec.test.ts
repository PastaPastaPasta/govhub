import { describe, expect, it } from 'vitest';
import { hexToBytes as unhex, bytesToHex as hex } from '@noble/hashes/utils.js';
import { BloomFilter, MIN_BLOOM_BYTES, matchAllFilter } from '../src/bloom.ts';
import { Reader } from '../src/bytes.ts';
import { decodeCbor } from '../src/cbor.ts';
import { FrameParser, GrpcError, frame } from '../src/grpcweb.ts';
import { bytes, decode, encode, num, text } from '../src/pb.ts';
import { encodeCbor } from './helpers/cbor-encode.ts';

describe('protobuf', () => {
  it('round trips values >= 2^31, strings, bytes, bools and skips proto3 defaults', () => {
    const m = decode(encode([[1, 2560383], [2, 'abc'], [3, Uint8Array.of(1, 2, 3)], [4, 4294967295], [5, true], [6, 0]]));
    expect(num(m, 1)).toBe(2560383);
    expect(text(bytes(m, 2))).toBe('abc');
    expect([...bytes(m, 3)]).toEqual([1, 2, 3]);
    expect(num(m, 4)).toBe(4294967295);
    expect(num(m, 5)).toBe(1);
    expect(m.has(6)).toBe(false);
  });
  it('forced zero (oneof) is sent; bad numbers and truncated input are rejected', () => {
    expect(encode([[1, 0, true]]).length).toBe(2);
    expect(encode([[1, 0]]).length).toBe(0);
    expect(() => encode([[1, NaN]])).toThrow(/non-negative integer/);
    expect(() => encode([[1, -1]])).toThrow(/non-negative integer/);
    expect(() => decode(Uint8Array.of(0x09, 1, 2, 3))).toThrow(/truncated fixed64/);
    expect(() => decode(Uint8Array.of(0x0a, 5, 1))).toThrow(/truncated field/);
    expect(() => decode(Uint8Array.of(0x08))).toThrow(/truncated varint/);
    expect(() => decode(Uint8Array.of(0x0b))).toThrow(/unsupported wire type/);
  });
});

describe('grpc-web framing', () => {
  const trailer = new TextEncoder().encode('grpc-status: 0\r\n');
  const t = new Uint8Array(5 + trailer.length); t[0] = 0x80; new DataView(t.buffer).setUint32(1, trailer.length); t.set(trailer, 5);
  const wire = new Uint8Array([...frame(Uint8Array.of(9, 8, 7)), ...frame(Uint8Array.of(1)), ...t]);
  it('parses arbitrary chunking and trailers', () => {
    for (const step of [1, 2, 3, 7, wire.length]) {
      const p = new FrameParser(), out = [];
      for (let i = 0; i < wire.length; i += step) out.push(...p.push(wire.slice(i, i + step)));
      expect(out.length).toBe(3);
      expect([...out[0]!.data]).toEqual([9, 8, 7]);
      expect(out[2]!.trailer).toBe(true);
    }
  });
  it('rejects a frame above the size limit before buffering it', () => {
    const hdr = new Uint8Array(5); new DataView(hdr.buffer).setUint32(1, 5_000_000);
    expect(() => new FrameParser(1000).push(hdr)).toThrow(GrpcError);
    expect(() => new FrameParser().push(hdr)).not.toThrow();
  });
});

describe('cbor (RFC 8949 appendix A vectors)', () => {
  const cases: [string, unknown][] = [
    ['00', 0], ['17', 23], ['1818', 24], ['1864', 100], ['1903e8', 1000], ['1a000f4240', 1000000], ['1b000000e8d4a51000', 1000000000000],
    ['20', -1], ['3863', -100], ['f4', false], ['f5', true], ['f6', null], ['f93e00', 1.5], ['fa47c35000', 100000], ['fb3ff199999999999a', 1.1],
    ['6449455446', 'IETF'], ['83010203', [1, 2, 3]], ['c11a514b67b0', 1363896240],
  ];
  for (const [h, v] of cases) it(`decodes ${h}`, () => expect(decodeCbor(unhex(h))).toEqual(v));
  it('decodes bytes, maps and u64 beyond 2^53 as bigint', () => {
    expect([...(decodeCbor(unhex('4401020304')) as Uint8Array)]).toEqual([1, 2, 3, 4]);
    expect({ ...(decodeCbor(unhex('a26161016162820203')) as object) }).toEqual({ a: 1, b: [2, 3] });
    expect(decodeCbor(unhex('1bffffffffffffffff'))).toBe(18446744073709551615n);
    expect(decodeCbor(unhex('3bffffffffffffffff'))).toBe(-18446744073709551616n);
  });
  it('round trips through the test encoder', () => {
    const v = { a: 1, b: [1, 2, { c: 'x' }], d: 'héllo', e: -5, f: 70000, g: 2 ** 40, h: true, i: null, j: Uint8Array.of(1, 2, 3) };
    const out = decodeCbor(encodeCbor(v)) as Record<string, unknown>;
    expect(out.d).toBe('héllo'); expect(out.e).toBe(-5); expect(out.g).toBe(2 ** 40); expect([...(out.j as Uint8Array)]).toEqual([1, 2, 3]);
  });
  it('rejects truncated, hostile and indefinite-length input', () => {
    expect(() => decodeCbor(Uint8Array.of(0x83, 0x01))).toThrow(/bad length|truncated/);
    expect(() => decodeCbor(Uint8Array.of(0x45, 1, 2))).toThrow(/truncated/);
    expect(() => decodeCbor(Uint8Array.of(0x19, 1))).toThrow(/truncated/);
    expect(() => decodeCbor(Uint8Array.of(0x9f, 0xff))).toThrow(/indefinite/);
    expect(() => decodeCbor(new Uint8Array(100).fill(0x81))).toThrow(/too deep/);
    expect(() => decodeCbor(unhex('5bffffffffffffffff'))).toThrow(/too large/);
  });
  it('a __proto__ key does not pollute Object.prototype', () => {
    const o = decodeCbor(encodeCbor({ ['__proto__']: { polluted: true } })) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(o)).toBeNull();
  });
});

describe('bloom filter (BIP37)', () => {
  const items = ['99108ad8ed9bb6274d3980bab5a85c048f0950c8', 'b5a2c786d9ef4658287ced5914b37a1b4aa32eee', 'b9300670b4c5366e95b2699e8b18bc75e5f729c5'].map(unhex);
  const ser = (f: BloomFilter) => `${f.vData.length.toString(16).padStart(2, '0')}${hex(f.vData)}${f.nHashFuncs.toString(16).padStart(8, '0').match(/../g)!.reverse().join('')}${f.nTweak.toString(16).padStart(8, '0').match(/../g)!.reverse().join('')}${f.nFlags.toString(16).padStart(2, '0')}`;
  it('matches Bitcoin Core bloom_tests serialization vectors (tweak 0 and 2147483649)', () => {
    const a = new BloomFilter(3, 0.01, 0, 1, 1); items.forEach((i) => a.insert(i));
    expect(ser(a)).toBe('03614e9b050000000000000001');
    const b = new BloomFilter(3, 0.01, 2147483649, 1, 1); items.forEach((i) => b.insert(i));
    expect(ser(b)).toBe('03ce4299050000000100008001');
    expect(a.contains(items[0]!)).toBe(true);
    expect(a.contains(unhex('19108ad8ed9bb6274d3980bab5a85c048f0950c8'))).toBe(false);
  });
  it('enforces the 200 byte DAPI floor and requires at least one element', () => {
    expect(new BloomFilter(1).vData.length).toBeGreaterThanOrEqual(MIN_BLOOM_BYTES);
    expect(() => new BloomFilter(0)).toThrow();
    expect(matchAllFilter().vData.length).toBeGreaterThanOrEqual(MIN_BLOOM_BYTES);
  });
  it('gives each filter a random tweak by default', () => {
    expect(new Set(Array.from({ length: 5 }, () => new BloomFilter(1).nTweak)).size).toBeGreaterThan(1);
  });
});

describe('Reader', () => {
  it('throws a plain "truncated" error instead of RangeError', () => {
    expect(() => new Reader(Uint8Array.of(1, 2)).u32()).toThrow('dash: truncated');
    expect(() => new Reader(Uint8Array.of(0xfe, 1)).varint()).toThrow('dash: truncated');
    expect(() => new Reader(Uint8Array.of(0xff, 0, 0, 0, 0, 1, 0, 0, 0)).varint()).toThrow(/too large/);
  });
});
