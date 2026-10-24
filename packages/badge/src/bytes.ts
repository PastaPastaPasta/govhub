// Byte helpers shared by the client (browser, Worker) and the reader. No Node imports.
import { base58 } from '@scure/base';

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(h: string): Uint8Array {
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesToBigInt(b: Uint8Array): bigint {
  return b.length === 0 ? 0n : BigInt('0x' + toHex(b));
}

export function bigIntToBytes(v: bigint, len: number): Uint8Array {
  if (v < 0n) throw new Error('negative');
  const h = v.toString(16);
  if (h.length > len * 2) throw new Error(`value does not fit in ${len} bytes`);
  return fromHex(h.padStart(len * 2, '0'));
}

/** Throws unless `b` is a Uint8Array of exactly 32 bytes (identifiers, key ids, hashes). */
export function need32(name: string, b: Uint8Array): void {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error(`${name} must be 32 bytes`);
}

/** Constant-time for equal lengths. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/**
 * Copy into a fresh ArrayBuffer-backed Uint8Array. Needed for WebCrypto's BufferSource typing, and because
 * @cloudflare/blindrsa-ts does `x.slice().buffer`, which on a Node Buffer view is the whole pool, not the view.
 */
export function copy(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

export async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', copy(b)));
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** Platform identifier: base58 of exactly 32 bytes. */
export function idToBytes(id: string): Uint8Array {
  if (!/^[1-9A-HJ-NP-Za-km-z]{1,44}$/.test(id)) throw new Error('invalid identifier');
  const b = base58.decode(id);
  if (b.length !== 32) throw new Error('identifier must decode to 32 bytes');
  return b;
}

export function bytesToId(b: Uint8Array): string {
  if (b.length !== 32) throw new Error('identifier must be 32 bytes');
  return base58.encode(b);
}

/** Uniform random integer in [0, n) from the CSPRNG (rejection sampling, no modulo bias). n <= 2^32. */
export function randomBelow(n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) throw new Error('randomBelow: bad bound');
  const limit = 2 ** 32 - (2 ** 32 % n);
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}
