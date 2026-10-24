// Byte helpers shared by every module. No I/O.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';

export { bytesToHex as hex, hexToBytes as unhex, concatBytes as concat };

export const sha256d = (b: Uint8Array): Uint8Array => sha256(sha256(b));

/** Reversed copy (internal byte order <-> display byte order of a uint256). */
export const reversed = (b: Uint8Array): Uint8Array => Uint8Array.from(b).reverse();

/** Display-order (RPC) hex of an internal-order 32-byte hash. */
export const hashHex = (b: Uint8Array): string => bytesToHex(reversed(b));

/** Internal-order bytes of a display-order hash hex. Throws unless it is exactly 32 bytes. */
export function hashBytes(display: string): Uint8Array {
  const b = hexToBytes(display);
  if (b.length !== 32) throw new Error('expected a 32-byte hash');
  return b.reverse();
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Lexicographic (memcmp) compare, which is how Core's uint256 operator< orders hashes. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Bounds-checked little-endian reader. Every read throws `Error('dash: truncated')` instead of RangeError. */
export class Reader {
  i = 0;
  readonly b: Uint8Array;
  readonly #dv: DataView;
  constructor(b: Uint8Array) {
    this.b = b;
    this.#dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  #need(n: number): void {
    if (n < 0 || this.i + n > this.b.length) throw new Error('dash: truncated');
  }
  u8(): number { this.#need(1); return this.b[this.i++]!; }
  u16(): number { this.#need(2); const v = this.#dv.getUint16(this.i, true); this.i += 2; return v; }
  u32(): number { this.#need(4); const v = this.#dv.getUint32(this.i, true); this.i += 4; return v; }
  i32(): number { this.#need(4); const v = this.#dv.getInt32(this.i, true); this.i += 4; return v; }
  u64(): bigint { this.#need(8); const v = this.#dv.getBigUint64(this.i, true); this.i += 8; return v; }
  bytes(n: number): Uint8Array { this.#need(n); const v = this.b.subarray(this.i, this.i + n); this.i += n; return v; }
  /** Bitcoin CompactSize. Rejects values above 2^32 (nothing on the wire here is that big). */
  varint(): number {
    const f = this.u8();
    if (f < 0xfd) return f;
    if (f === 0xfd) return this.u16();
    if (f === 0xfe) return this.u32();
    const v = this.u64();
    if (v > 0xffffffffn) throw new Error('dash: varint too large');
    return Number(v);
  }
  get left(): number { return this.b.length - this.i; }
}
