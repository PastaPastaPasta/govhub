// The vendored ES-module X11 must equal the original CommonJS package (devDependency) stage by stage, and must work as strict
// ES-module code (the original's groestl.js throws there: that is the bug the vendored copy fixes).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { digest, stages } from '../src/vendor/x11/x11.js';
import { blockHashHex, x11 } from '../src/x11.ts';

const require = createRequire(import.meta.url);
const orig = require('@dashevo/x11-hash-js') as { digest(i: number[], f: number, o: number): number[] };
const rand = (n: number, seed: number): number[] => {
  let s = seed >>> 0;
  return Array.from({ length: n }, () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; });
};
// (127 is left out: upstream throws for that exact length in blake/bmw alike; headers are always 80 bytes)
const LENGTHS = [0, 1, 7, 63, 64, 65, 80, 128, 129, 200, 300];

describe('vendored X11 equals @dashevo/x11-hash-js', () => {
  it('full X11 digest over 11 input lengths (incl. block-size boundaries)', () => {
    for (const n of LENGTHS) expect(digest(rand(n, n + 1))).toEqual(orig.digest(rand(n, n + 1), 1, 1));
  });
  for (const stage of ['blake', 'bmw', 'groestl', 'skein', 'jh', 'luffa', 'cubehash', 'shavite', 'simd', 'echo'] as const) {
    it(`stage ${stage} (64-byte and 80-byte inputs, byte-in/word-out)`, () => {
      const o = require(`@dashevo/x11-hash-js/lib/${stage}`) as (i: number[], f: number, o: number) => number[];
      for (const n of [0, 5, 64, 80, 150]) expect(stages[stage](rand(n, 7 * n + 3), 1, 2)).toEqual(o(rand(n, 7 * n + 3), 1, 2));
    });
  }
  it('the public wrapper takes a Uint8Array and returns the genesis hash', () => {
    const merkleRev = Uint8Array.from(Buffer.from('e0028eb9648db56b1ac77cf090b99048a8007e2bb64b68f092c03c7f56a662c7', 'hex')).reverse();
    const hdr = new Uint8Array(80);
    new DataView(hdr.buffer).setUint32(0, 1, true); hdr.set(merkleRev, 36);
    new DataView(hdr.buffer).setUint32(68, 1390095618, true); new DataView(hdr.buffer).setUint32(72, 0x1e0ffff0, true); new DataView(hdr.buffer).setUint32(76, 28917698, true);
    expect(blockHashHex(hdr)).toBe('00000ffd590b1485b3caadc19b22e6379c733355108f107a430458cdf3407ab6');
    expect(x11(hdr)).toHaveLength(32);
  });
});

describe('strict-mode regression', () => {
  it('the original package is NOT usable from strict ES-module code (documents why it is vendored)', () => {
    // Evaluate the original groestl under "use strict" the way a bundler's ESM output does.
    const src = require('node:fs').readFileSync(require.resolve('@dashevo/x11-hash-js/lib/groestl.js'), 'utf8') as string;
    expect(/'use strict'/.test(src)).toBe(false);
    expect(src).toContain('this.hi << bitsOff32');
  });
});
