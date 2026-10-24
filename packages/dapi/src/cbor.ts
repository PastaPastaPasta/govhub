// Minimal CBOR decoder (RFC 8949 subset: ints, bytes, text, definite arrays/maps, tags, bool/null, floats): enough for DAPI's
// CBOR-encoded masternode list diff. Maps decode to null-prototype objects (a `__proto__` key cannot pollute anything).
const td = new TextDecoder();
const MAX_DEPTH = 64;

export type Cbor = number | bigint | string | boolean | null | Uint8Array | Cbor[] | { [key: string]: Cbor };

export function decodeCbor(buf: Uint8Array): Cbor {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  const need = (n: number) => { if (i + n > buf.length) throw new Error('cbor: truncated'); };
  const arg = (info: number): number | bigint => {
    if (info < 24) return info;
    if (info === 24) { need(1); return buf[i++]!; }
    if (info === 25) { need(2); const v = dv.getUint16(i); i += 2; return v; }
    if (info === 26) { need(4); const v = dv.getUint32(i); i += 4; return v; }
    if (info === 27) { need(8); const v = dv.getBigUint64(i); i += 8; return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v; }
    throw new Error('cbor: indefinite length unsupported');
  };
  const item = (depth: number): Cbor => {
    if (depth > MAX_DEPTH) throw new Error('cbor: nesting too deep');
    need(1);
    const ib = buf[i++]!, major = ib >> 5, info = ib & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22 || info === 23) return null;
      if (info === 25) {
        need(2); const h = dv.getUint16(i); i += 2;
        const e = (h >> 10) & 31, f = h & 1023;
        return (h & 0x8000 ? -1 : 1) * (e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15));
      }
      if (info === 26) { need(4); const v = dv.getFloat32(i); i += 4; return v; }
      if (info === 27) { need(8); const v = dv.getFloat64(i); i += 8; return v; }
      throw new Error('cbor: bad simple value');
    }
    const n = arg(info);
    if (typeof n === 'number' && (major === 2 || major === 3) && i + n > buf.length) throw new Error('cbor: truncated');
    if (typeof n === 'number' && (major === 4 || major === 5) && n > buf.length - i) throw new Error('cbor: bad length'); // each item takes >= 1 byte
    if (typeof n === 'bigint' && major >= 2 && major <= 5) throw new Error('cbor: length too large');
    switch (major) {
      case 0: return n;
      case 1: return typeof n === 'bigint' ? -1n - n : -1 - n;
      case 2: { const v = buf.subarray(i, i + (n as number)); i += n as number; return v; }
      case 3: { const v = td.decode(buf.subarray(i, i + (n as number))); i += n as number; return v; }
      case 4: { const a: Cbor[] = []; for (let k = 0; k < (n as number); k++) a.push(item(depth + 1)); return a; }
      case 5: {
        const o = Object.create(null) as { [key: string]: Cbor };
        for (let k = 0; k < (n as number); k++) { const key = item(depth + 1); o[String(key)] = item(depth + 1); }
        return o;
      }
      case 6: return item(depth + 1); // tags are ignored
      default: throw new Error('cbor: bad major type');
    }
  };
  return item(0);
}
