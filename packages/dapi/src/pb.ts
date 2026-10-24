// Minimal protobuf (proto3) wire encoder/decoder: just enough for the DAPI Core messages.
import { concat } from './bytes.ts';

const te = new TextEncoder();
const td = new TextDecoder();

export type PbValue = number | boolean | string | Uint8Array | undefined | null;
/** [fieldNumber, value, force?]. `force` sends proto3 defaults (a oneof member set to 0 must still be sent). */
export type PbField = readonly [field: number, value: PbValue, force?: boolean];
/** Decoded message: field number -> values. varint -> number, length-delimited -> Uint8Array (a view), fixed64 -> double, fixed32 -> number. */
export type PbMessage = Map<number, (number | Uint8Array)[]>;

function varint(n: number): Uint8Array {
  const out: number[] = [];
  // Values are always < 2^53; avoid 32-bit bit ops so values >= 2^31 survive.
  while (n >= 0x80) { out.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); }
  out.push(n);
  return Uint8Array.from(out);
}

const tag = (field: number, wire: number) => varint(field * 8 + wire);

export function encode(fields: readonly PbField[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [f, v, force] of fields) {
    if (v === undefined || v === null) continue;
    if (!force && (v === 0 || v === false)) continue;
    if (typeof v === 'number' && !(Number.isSafeInteger(v) && v >= 0)) throw new Error(`pb: field ${f} must be a non-negative integer`);
    if (typeof v === 'boolean') parts.push(tag(f, 0), varint(v ? 1 : 0));
    else if (typeof v === 'number') parts.push(tag(f, 0), varint(v));
    else {
      const b = typeof v === 'string' ? te.encode(v) : v;
      if (b.length === 0 && !force) continue;
      parts.push(tag(f, 2), varint(b.length), b);
    }
  }
  return concat(...parts);
}

export function decode(buf: Uint8Array): PbMessage {
  const m: PbMessage = new Map();
  let i = 0;
  const readVarint = (): number => {
    let r = 0, mul = 1, b: number;
    do {
      if (i >= buf.length) throw new Error('pb: truncated varint');
      b = buf[i++]!;
      r += (b & 0x7f) * mul; mul *= 128;
    } while (b & 0x80);
    return r;
  };
  const push = (f: number, v: number | Uint8Array) => { const a = m.get(f); if (a) a.push(v); else m.set(f, [v]); };
  while (i < buf.length) {
    const key = readVarint();
    const f = Math.floor(key / 8), wire = key % 8;
    if (wire === 0) push(f, readVarint());
    else if (wire === 2) {
      const len = readVarint();
      if (i + len > buf.length) throw new Error('pb: truncated field');
      push(f, buf.subarray(i, i + len)); i += len;
    } else if (wire === 1) {
      if (i + 8 > buf.length) throw new Error('pb: truncated fixed64');
      push(f, new DataView(buf.buffer, buf.byteOffset + i, 8).getFloat64(0, true)); i += 8;
    } else if (wire === 5) {
      if (i + 4 > buf.length) throw new Error('pb: truncated fixed32');
      push(f, new DataView(buf.buffer, buf.byteOffset + i, 4).getUint32(0, true)); i += 4;
    } else throw new Error('pb: unsupported wire type ' + wire);
  }
  return m;
}

/** First value of a numeric field. */
export const num = (m: PbMessage, f: number): number => {
  const v = m.get(f)?.[0];
  return typeof v === 'number' ? v : 0;
};
/** First value of a bytes field (empty when absent). */
export const bytes = (m: PbMessage, f: number): Uint8Array => {
  const v = m.get(f)?.[0];
  return v instanceof Uint8Array ? v : new Uint8Array(0);
};
/** Every value of a repeated bytes field. */
export const allBytes = (m: PbMessage, f: number): Uint8Array[] => (m.get(f) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array);
export const text = (b: Uint8Array): string => td.decode(b);
