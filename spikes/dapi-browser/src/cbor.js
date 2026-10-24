// Minimal CBOR decoder (RFC 8949 subset: ints, bytes, text, arrays, maps, tags, bool/null, floats).
// Enough for DAPI's CBOR-encoded masternode list diff. Maps decode to plain objects (text keys only).
const td = new TextDecoder();

export function decodeCbor(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  const arg = (info) => {
    if (info < 24) return info;
    if (info === 24) return buf[i++];
    if (info === 25) { const v = dv.getUint16(i); i += 2; return v; }
    if (info === 26) { const v = dv.getUint32(i); i += 4; return v; }
    if (info === 27) { const v = dv.getBigUint64(i); i += 8; return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v; }
    throw new Error('cbor: indefinite length unsupported');
  };
  const item = () => {
    const ib = buf[i++], major = ib >> 5, info = ib & 31;
    if (major === 7) {
      if (info === 20) return false; if (info === 21) return true; if (info === 22 || info === 23) return null;
      if (info === 25) { const h = dv.getUint16(i); i += 2; const e = (h >> 10) & 31, f = h & 1023; return (h & 0x8000 ? -1 : 1) * (e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15)); }
      if (info === 26) { const v = dv.getFloat32(i); i += 4; return v; }
      if (info === 27) { const v = dv.getFloat64(i); i += 8; return v; }
      throw new Error('cbor: bad simple value');
    }
    const n = arg(info);
    if (typeof n === 'number' && (major === 2 || major === 3) && i + n > buf.length) throw new Error('cbor: truncated');
    if (typeof n === 'number' && (major === 4 || major === 5) && n > buf.length - i) throw new Error('cbor: bad length'); // each item takes >= 1 byte
    switch (major) {
      case 0: return n;
      case 1: return typeof n === 'bigint' ? -1n - n : -1 - n;
      case 2: { const v = buf.subarray(i, i + n); i += n; return v; }
      case 3: { const v = td.decode(buf.subarray(i, i + n)); i += n; return v; }
      case 4: { const a = []; for (let k = 0; k < n; k++) a.push(item()); return a; }
      case 5: { const o = Object.create(null); for (let k = 0; k < n; k++) { const key = item(); o[key] = item(); } return o; }
      case 6: return item(); // ignore tag
      default: throw new Error('cbor: bad major type');
    }
  };
  return item();
}
