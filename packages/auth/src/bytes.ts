// Byte helpers. Re-exports the shared ones from @govhub/verify and adds what key handling needs.
import { base58 } from '@scure/base';
import { bytesEqual, bytesToHex, concatBytes, hash160, hexToBytes, reversed, sha256d, u32le } from '@govhub/verify';

export { bytesEqual, bytesToHex, concatBytes, hash160, hexToBytes, reversed, sha256d, u32le };

/** Overwrites secret bytes. Best effort: JS strings (WIFs, phrases) cannot be zeroed, and copies made by libraries are out of reach. */
export function wipe(...arrays: Array<Uint8Array | null | undefined>): void {
  for (const a of arrays) a?.fill(0);
}

/** Cryptographically secure random bytes (Web Crypto; never Math.random). */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export const toBase58 = (b: Uint8Array): string => base58.encode(b);
export const fromBase58 = (s: string): Uint8Array => base58.decode(s);

/** 32-byte Platform identifier from base58, or throws. */
export function identifierBytes(id: string): Uint8Array {
  const b = base58.decode(id);
  if (b.length !== 32) throw new Error('identifier must be 32 bytes');
  return b;
}

export function u32be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('u32 out of range');
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export function readU32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
}

export const toBase64 = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
