// X11 block-header hashing (own entry point): the sphlib C chain from Dash Core's HashX11 compiled to a ~85 KB WebAssembly module with no
// imports (x11-wasm/, rebuilt by x11-wasm/build.sh into ./vendor/x11-wasm.ts as inline base64). ~10 us per 80-byte header, ~40x the pure-JS
// @dashevo/x11-hash-js that is still vendored in ./vendor/x11 as the test oracle. Instantiated synchronously on first use.
import { hashHex } from './bytes.ts';
import { X11_WASM_BASE64 } from './vendor/x11-wasm.ts';

interface X11Exports {
  memory: WebAssembly.Memory;
  x11_hash(input: number, len: number, out32: number): void;
  x11_batch(headers: number, n: number, out: number): void;
  x11_buf(bytes: number): number;
  x11_stage(stage: number, input: number, len: number, out64: number): number;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function fromBase64(s: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < s.length && o < out.length; i++) {
    const v = B64.indexOf(s[i]!);
    if (v < 0) continue; // '=' padding
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return out;
}

let wasm: X11Exports | undefined;
const api = (): X11Exports =>
  (wasm ??= new WebAssembly.Instance(new WebAssembly.Module(fromBase64(X11_WASM_BASE64) as BufferSource), {}).exports as unknown as X11Exports);

/** Headers per wasm call in x11Many (4096 x 112 B = 448 KB of scratch memory). */
const CHUNK = 4096;

/** X11 of an 80-byte block header: the 32-byte block hash in internal (wire) order. */
export function x11(header: Uint8Array): Uint8Array {
  if (header.length !== 80) throw new Error(`x11: expected an 80-byte header, got ${header.length}`);
  const w = api();
  const p = w.x11_buf(112);
  if (!p) throw new Error('x11: out of memory');
  new Uint8Array(w.memory.buffer, p, 80).set(header);
  w.x11_hash(p, 80, p + 80);
  return new Uint8Array(w.memory.buffer, p + 80, 32).slice();
}

/** X11 of n consecutive 80-byte headers (concatenated): n x 32 bytes, each hash in internal (wire) order. */
export function x11Many(headers: Uint8Array): Uint8Array {
  if (headers.length % 80 !== 0) throw new Error(`x11Many: expected a multiple of 80 bytes, got ${headers.length}`);
  const n = headers.length / 80;
  const out = new Uint8Array(n * 32);
  const w = api();
  for (let i = 0; i < n; i += CHUNK) {
    const k = Math.min(CHUNK, n - i);
    const p = w.x11_buf(k * 112);
    if (!p) throw new Error('x11Many: out of memory');
    new Uint8Array(w.memory.buffer, p, k * 80).set(headers.subarray(i * 80, (i + k) * 80));
    w.x11_batch(p, k, p + k * 80);
    out.set(new Uint8Array(w.memory.buffer, p + k * 80, k * 32), i * 32);
  }
  return out;
}

/** One of the eleven chain algorithms alone (0 blake, 1 bmw, 2 groestl, 3 skein, 4 jh, 5 keccak, 6 luffa, 7 cubehash, 8 shavite, 9 simd, 10 echo): 64-byte digest. For tests. */
export function x11Stage(stage: number, input: Uint8Array): Uint8Array {
  const w = api();
  const p = w.x11_buf(input.length + 64);
  if (!p) throw new Error('x11Stage: out of memory');
  new Uint8Array(w.memory.buffer, p, input.length).set(input);
  if (w.x11_stage(stage, p, input.length, p + input.length) !== 0) throw new Error(`x11Stage: no stage ${stage}`);
  return new Uint8Array(w.memory.buffer, p + input.length, 64).slice();
}

/** Block hash of a header in display (RPC) order, as used by getBlock/getTransaction and CLSIGs after conversion. */
export const blockHashHex = (header: Uint8Array): string => hashHex(x11(header));
