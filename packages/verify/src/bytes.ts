// Small byte-level helpers shared by every module. No network, no I/O.
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export { bytesToHex, concatBytes, hexToBytes, utf8ToBytes };

/** Bitcoin-style double SHA-256 (what Core calls Hash() / CHashWriter::GetHash()). */
export const sha256d = (data: Uint8Array): Uint8Array => sha256(sha256(data));

/** RIPEMD160(SHA256(data)), Core's Hash160 / CKeyID. */
export const hash160 = (data: Uint8Array): Uint8Array => ripemd160(sha256(data));

/** Returns a reversed copy (internal byte order <-> display byte order of uint256). */
export function reversed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i]!;
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;
export function isHex(s: string): boolean {
  return HEX_RE.test(s);
}

/** Parses a 64-char hex uint256 in DISPLAY order (what RPCs print) into RAW (internal, wire) bytes. */
export function uint256FromDisplay(display: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(display)) throw new Error(`expected 64 hex chars, got ${JSON.stringify(display)}`);
  return reversed(hexToBytes(display));
}

/** RAW (internal) uint256 bytes to the DISPLAY hex that RPCs / explorers print (lowercase). */
export function uint256ToDisplay(raw: Uint8Array): string {
  if (raw.length !== 32) throw new Error('uint256 must be 32 bytes');
  return bytesToHex(reversed(raw));
}

/** Bitcoin CompactSize encoding. */
export function compactSize(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n) throw new Error('negative compact size');
  if (v < 253n) return Uint8Array.of(Number(v));
  if (v <= 0xffffn) return Uint8Array.of(253, Number(v & 0xffn), Number(v >> 8n));
  if (v <= 0xffffffffn) return concatBytes(Uint8Array.of(254), u32le(v));
  return concatBytes(Uint8Array.of(255), u64le(v));
}

export function u32le(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v > 0xffffffffn) throw new RangeError(`uint32 out of range: ${v}`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, Number(v), true);
  return b;
}

export function i32le(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < -0x80000000n || v > 0x7fffffffn) throw new RangeError(`int32 out of range: ${v}`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, Number(v), true);
  return b;
}

export function i64le(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < -(1n << 63n) || v >= 1n << 63n) throw new RangeError(`int64 out of range: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, v, true);
  return b;
}

export function u64le(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v >= 1n << 64n) throw new RangeError(`uint64 out of range: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

/** Core's `ss << std::string`: CompactSize(byte length) followed by the raw bytes. */
export function serializeString(bytes: Uint8Array): Uint8Array {
  return concatBytes(compactSize(bytes.length), bytes);
}

/** Bounds-checked reader used by the transaction parser. Throws on truncation / non-canonical sizes. */
export class Reader {
  pos = 0;
  readonly buf: Uint8Array;
  // (no TS parameter property: keeps this file runnable under Node's built-in type stripping)
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  bytes(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 0 || this.pos + n > this.buf.length) throw new Error('unexpected end of data');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u8(): number {
    return this.bytes(1)[0]!;
  }

  u16(): number {
    const b = this.bytes(2);
    return b[0]! | (b[1]! << 8);
  }

  u32(): number {
    const b = this.bytes(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }

  i32(): number {
    const b = this.bytes(4);
    return new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true);
  }

  i64(): bigint {
    const b = this.bytes(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigInt64(0, true);
  }

  /** CompactSize, rejecting non-canonical encodings and > MAX_SIZE (0x02000000) like Core's ReadCompactSize. */
  compactSize(): number {
    const first = this.u8();
    let v: bigint;
    if (first < 253) return first;
    if (first === 253) {
      v = BigInt(this.u16());
      if (v < 253n) throw new Error('non-canonical CompactSize');
    } else if (first === 254) {
      v = BigInt(this.u32());
      if (v < 0x10000n) throw new Error('non-canonical CompactSize');
    } else {
      const b = this.bytes(8);
      v = new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
      if (v < 0x100000000n) throw new Error('non-canonical CompactSize');
    }
    if (v > 0x02000000n) throw new Error('CompactSize too large');
    return Number(v);
  }
}
