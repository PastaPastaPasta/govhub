// Test-only definite-length CBOR encoder (the library only decodes).
export type CborIn = number | bigint | string | boolean | null | Uint8Array | CborIn[] | { [k: string]: CborIn };

function head(major: number, n: number | bigint): number[] {
  const m = major << 5;
  if (n < 24) return [m | Number(n)];
  if (n < 0x100) return [m | 24, Number(n)];
  if (n < 0x10000) return [m | 25, Number(n) >> 8, Number(n) & 255];
  if (n < 0x100000000) { const v = Number(n); return [m | 26, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }
  const out = [m | 27]; let b = BigInt(n);
  const bytes: number[] = [];
  for (let i = 0; i < 8; i++) { bytes.unshift(Number(b & 255n)); b >>= 8n; }
  return out.concat(bytes);
}

export function encodeCbor(v: CborIn): Uint8Array {
  const out: number[] = [];
  const put = (x: CborIn): void => {
    if (x === null) out.push(0xf6);
    else if (typeof x === 'boolean') out.push(x ? 0xf5 : 0xf4);
    else if (typeof x === 'number') { if (!Number.isInteger(x)) throw new Error('floats unsupported'); out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x))); }
    else if (typeof x === 'bigint') out.push(...(x >= 0n ? head(0, x) : head(1, -1n - x)));
    else if (typeof x === 'string') { const b = new TextEncoder().encode(x); out.push(...head(3, b.length), ...b); }
    else if (x instanceof Uint8Array) out.push(...head(2, x.length), ...x);
    else if (Array.isArray(x)) { out.push(...head(4, x.length)); x.forEach(put); }
    else { const e = Object.entries(x); out.push(...head(5, e.length)); for (const [k, val] of e) { put(k); put(val); } }
  };
  put(v);
  return Uint8Array.from(out);
}
