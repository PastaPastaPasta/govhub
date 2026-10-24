// The WebAssembly X11 (x11-wasm/, sphlib C from Dash Core) against: the pure-JS oracle in src/vendor/x11, Core's own genesis hashes
// (src/chainparams.cpp), and real mainnet headers recorded from DAPI.
import { describe, expect, it, vi } from 'vitest';
import { hashHex } from '../src/bytes.ts';
import { parseHeader } from '../src/dash.ts';
import { digest, stages } from '../src/vendor/x11/x11.js';
import { X11_WASM_BASE64 } from '../src/vendor/x11-wasm.ts';
import { blockHashHex, x11, x11Many, x11Stage } from '../src/x11.ts';
import { fx } from './fixtures.ts';

const rand = (n: number, seed: number): Uint8Array => {
  let s = seed >>> 0;
  return Uint8Array.from({ length: n }, () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; });
};
const MERKLE_REV = Uint8Array.from(Buffer.from('e0028eb9648db56b1ac77cf090b99048a8007e2bb64b68f092c03c7f56a662c7', 'hex')).reverse();
const genesis = (time: number, bits: number, nonce: number): Uint8Array => {
  const h = new Uint8Array(80), v = new DataView(h.buffer);
  v.setUint32(0, 1, true); h.set(MERKLE_REV, 36); v.setUint32(68, time, true); v.setUint32(72, bits, true); v.setUint32(76, nonce, true);
  return h;
};

describe('wasm X11', () => {
  it('has no imports and exports only the four functions and the memory', () => {
    const m = new WebAssembly.Module(Buffer.from(X11_WASM_BASE64, 'base64'));
    expect(WebAssembly.Module.imports(m)).toEqual([]);
    expect(WebAssembly.Module.exports(m).map((e) => e.name).sort()).toEqual(['memory', 'x11_batch', 'x11_buf', 'x11_hash', 'x11_stage']);
  });

  it("equals Dash Core's genesis hashes (chainparams.cpp:251 main, :455 test, :638 regtest/devnet)", () => {
    expect(blockHashHex(genesis(1390095618, 0x1e0ffff0, 28917698))).toBe('00000ffd590b1485b3caadc19b22e6379c733355108f107a430458cdf3407ab6');
    expect(blockHashHex(genesis(1390666206, 0x1e0ffff0, 3861367235))).toBe('00000bafbc94add76cb75e2ec92894837288a481e5c005f6563d91623bf8bc2c');
    expect(blockHashHex(genesis(1417713337, 0x207fffff, 1096447))).toBe('000008ca1832a4baf228eb1553c03d3a2c8e02399550dd6ea8d65cec3ef23d2e');
  });

  it('equals the pure-JS oracle on 1000 random 80-byte inputs', () => {
    for (let i = 0; i < 1000; i++) {
      const h = rand(80, 1000 + i);
      expect(Array.from(x11(h))).toEqual(digest(Array.from(h)));
    }
  });

  it('equals the oracle for every stage but keccak (not exposed by the oracle) on 0..300-byte inputs', () => {
    const names = ['blake', 'bmw', 'groestl', 'skein', 'jh', 'keccak', 'luffa', 'cubehash', 'shavite', 'simd', 'echo'] as const;
    for (const [i, name] of names.entries()) {
      if (name === 'keccak') continue;
      for (const n of [0, 5, 64, 80, 150, 300]) {
        const input = rand(n, 31 * n + i);
        const words = stages[name](Array.from(input), 1, 2);
        const want = new Uint8Array(64);
        words.forEach((w, j) => new DataView(want.buffer).setInt32(j * 4, w, false));
        expect(x11Stage(i, input), `${name} len ${n}`).toEqual(want);
      }
    }
    expect(() => x11Stage(11, new Uint8Array(1))).toThrow(/no stage/);
  });

  it('chains the stages exactly like HashX11: x11 == echo(simd(...(blake(h)))) truncated to 32 bytes', () => {
    const h = rand(80, 5);
    let a = h;
    for (let i = 0; i < 11; i++) a = x11Stage(i, a);
    expect(x11(h)).toEqual(a.slice(0, 32));
  });

  it('known real headers: each recorded header hashes to its claimed hash and the next header links to it', () => {
    for (const p of fx.rec.headerPairs) {
      const hdr = Uint8Array.from(Buffer.from(p.headerHex, 'hex'));
      expect(blockHashHex(hdr)).toBe(p.hash);
      expect(parseHeader(Uint8Array.from(Buffer.from(p.nextHeaderHex, 'hex'))).prevHash).toBe(p.hash);
    }
  });

  it('a recorded header chain links end to end and x11Many gives the same hashes', () => {
    const all = new Uint8Array(fx.headers.length * 80);
    fx.headers.forEach((h, i) => all.set(h, i * 80));
    const hashes = x11Many(all);
    expect(hashes.length).toBe(fx.headers.length * 32);
    for (let i = 1; i < fx.headers.length; i++) expect(parseHeader(fx.headers[i]!).prevHash).toBe(hashHex(hashes.subarray((i - 1) * 32, i * 32)));
    expect(hashHex(hashes.subarray(0, 32))).toBe(fx.blockHash);
  });

  it('x11Many equals per-header x11 across chunk boundaries (5000 headers, > 4096 per wasm call)', () => {
    const n = 5000, all = rand(n * 80, 77), many = x11Many(all);
    for (let i = 0; i < n; i += 37) expect(many.subarray(i * 32, i * 32 + 32)).toEqual(x11(all.subarray(i * 80, i * 80 + 80)));
    for (const i of [0, 4095, 4096, 4097, n - 1]) expect(many.subarray(i * 32, i * 32 + 32)).toEqual(x11(all.subarray(i * 80, i * 80 + 80)));
  });

  it('works on views with a byteOffset, does not touch the input, returns independent copies', () => {
    const big = rand(200, 9), view = big.subarray(13, 93), before = big.slice();
    const a = x11(view), b = x11(Uint8Array.from(view));
    expect(a).toEqual(b);
    expect(big).toEqual(before);
    x11(rand(80, 10));
    expect(a).toEqual(b); // the result is not a view into wasm memory
  });

  it('rejects bad lengths; x11Many of nothing is nothing', () => {
    expect(() => x11(new Uint8Array(79))).toThrow(/80-byte/);
    expect(() => x11(new Uint8Array(81))).toThrow(/80-byte/);
    expect(() => x11Many(new Uint8Array(81))).toThrow(/multiple of 80/);
    expect(x11Many(new Uint8Array(0))).toHaveLength(0);
  });

  it('decodes the module without atob (Workers/old runtimes)', async () => {
    const want = x11(rand(80, 3));
    vi.resetModules();
    vi.stubGlobal('atob', undefined);
    try {
      const fresh = await import('../src/x11.ts');
      expect(fresh.x11(rand(80, 3))).toEqual(want);
    } finally { vi.unstubAllGlobals(); }
  });
});
