// Minimal protobuf (proto3) wire encoder/decoder, just enough for the DAPI Core messages.
// No dependencies; works in browsers and Node.

const te = new TextEncoder();
const td = new TextDecoder();

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function varint(n) {
  const out = [];
  // numbers are always < 2^53 here; avoid 32-bit bit ops so values >= 2^31 survive.
  while (n >= 0x80) { out.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); }
  out.push(n);
  return Uint8Array.from(out);
}

const tag = (field, wire) => varint(field * 8 + wire);

/** Encode a message from [fieldNumber, value, force?] tuples. number -> varint, bool -> varint,
 *  string -> UTF-8 len-delimited, Uint8Array -> len-delimited bytes. `undefined`/0/false/empty are skipped (proto3
 *  default) unless force=true, which oneof members need (a oneof set to 0 must still be sent). */
export function encode(fields) {
  const parts = [];
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
  return concat(parts);
}

/** Decode into Map<field, value[]>; varint -> number, len-delimited -> Uint8Array (subarray view),
 *  fixed64 -> double (all DAPI fixed64 fields are `double`), fixed32 -> number. */
export function decode(buf) {
  const m = new Map();
  let i = 0;
  const readVarint = () => {
    let r = 0, mul = 1, b;
    do {
      if (i >= buf.length) throw new Error('pb: truncated varint');
      b = buf[i++];
      r += (b & 0x7f) * mul; mul *= 128;
    } while (b & 0x80);
    return r;
  };
  const push = (f, v) => { const a = m.get(f); if (a) a.push(v); else m.set(f, [v]); };
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
      push(f, new DataView(buf.buffer, buf.byteOffset + i, 8).getFloat64(0, true)); i += 8; }
    else if (wire === 5) {
      if (i + 4 > buf.length) throw new Error('pb: truncated fixed32');
      push(f, new DataView(buf.buffer, buf.byteOffset + i, 4).getUint32(0, true)); i += 4; }
    else throw new Error('pb: unsupported wire type ' + wire);
  }
  return m;
}

export const first = (m, f, dflt) => (m.has(f) ? m.get(f)[0] : dflt);
export const all = (m, f) => m.get(f) || [];
export const str = (b) => (b ? td.decode(b) : '');
