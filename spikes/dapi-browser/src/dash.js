// Minimal Dash wire-format parsers (no dashcore-lib): hex, hashes, tx, block, header, merkleblock, chainlock, islock.
import { sha256 } from '@noble/hashes/sha2.js';

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (s) => { const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; };
export const reversed = (b) => Uint8Array.from(b).reverse();
export const sha256d = (b) => sha256(sha256(b));
/** Display-order (RPC) hex of an internal-order 32-byte hash. */
export const hashHex = (b) => hex(reversed(b));

export class Reader {
  constructor(buf) { this.b = buf; this.i = 0; this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  u8() { if (this.i >= this.b.length) throw new Error('dash: truncated'); return this.b[this.i++]; }
  u16() { const v = this.dv.getUint16(this.i, true); this.i += 2; return v; }
  u32() { const v = this.dv.getUint32(this.i, true); this.i += 4; return v; }
  i32() { const v = this.dv.getInt32(this.i, true); this.i += 4; return v; }
  u64() { const v = this.dv.getBigUint64(this.i, true); this.i += 8; return v; }
  bytes(n) { if (this.i + n > this.b.length) throw new Error('dash: truncated'); const v = this.b.subarray(this.i, this.i + n); this.i += n; return v; }
  varint() { const f = this.u8(); if (f < 0xfd) return f; if (f === 0xfd) return this.u16(); if (f === 0xfe) return this.u32(); return Number(this.u64()); }
  get left() { return this.b.length - this.i; }
}

/** Parse one transaction from the reader. Returns { version, type, inputs, outputs, lockTime, extraPayload, raw, txid }. */
export function readTx(r) {
  const start = r.i;
  const ver = r.u32();
  const version = (ver << 16) >> 16, type = ver >>> 16; // nVersion is int16 in Core
  const inputs = [];
  for (let n = r.varint(); n > 0; n--) {
    inputs.push({ prevTxid: hashHex(r.bytes(32)), vout: r.u32(), script: r.bytes(r.varint()), sequence: r.u32() });
  }
  const outputs = [];
  for (let n = r.varint(); n > 0; n--) outputs.push({ value: r.u64(), script: r.bytes(r.varint()) });
  const lockTime = r.u32();
  let extraPayload = null;
  if (version >= 3 && type !== 0) extraPayload = r.bytes(r.varint());
  const raw = r.b.subarray(start, r.i);
  return { version, type, inputs, outputs, lockTime, extraPayload, raw, txid: hashHex(sha256d(raw)) };
}
export const parseTx = (raw) => readTx(new Reader(raw));

/** Classify an output script. OP_RETURN data is returned for a single-push script (what governance collateral uses). */
export function classifyScript(s) {
  if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac) return { type: 'p2pkh', hash: s.subarray(3, 23) };
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) return { type: 'p2sh', hash: s.subarray(2, 22) };
  if (s[0] === 0x6a) {
    let data = null;
    if (s.length > 1 && s[1] >= 1 && s[1] <= 75 && s.length === 2 + s[1]) data = s.subarray(2);
    else if (s.length > 2 && s[1] === 0x4c && s.length === 3 + s[2]) data = s.subarray(3);
    return { type: 'op_return', data };
  }
  return { type: 'other' };
}

export function parseHeader(h) {
  if (h.length < 80) throw new Error('dash: header too short');
  const r = new Reader(h);
  return { version: r.i32(), prevHash: hashHex(r.bytes(32)), merkleRoot: hashHex(r.bytes(32)), time: r.u32(), bits: r.u32(), nonce: r.u32(), raw: h.subarray(0, 80) };
}

/** Full block: header + txs. Also recomputes the merkle root from the txids and checks it against the header. */
export function parseBlock(raw) {
  const r = new Reader(raw);
  const header = parseHeader(r.bytes(80));
  const txs = [];
  for (let n = r.varint(); n > 0; n--) txs.push(readTx(r));
  const root = merkleRoot(txs.map((t) => unhex(t.txid).reverse()));
  return { header, txs, merkleOk: hashHex(root) === header.merkleRoot };
}

function merkleRoot(level) {
  if (!level.length) return new Uint8Array(32);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i], b = level[i + 1] || a;
      const c = new Uint8Array(64); c.set(a); c.set(b, 32);
      next.push(sha256d(c));
    }
    level = next;
  }
  return level[0];
}

/** Partial merkle tree (BIP37 merkleblock). Returns { header, total, matched: txid[], rootOk }. */
export function parseMerkleBlock(raw) {
  const r = new Reader(raw);
  const header = parseHeader(r.bytes(80));
  const total = r.u32();
  // Same sanity limits as Core's CPartialMerkleTree: at least one tx, at most one per 60 bytes of max block size (2 MB)
  if (total === 0 || total > 2_000_000 / 60 * 2) throw new Error('merkleblock: bad tx count');
  const nHashes = r.varint();
  if (nHashes > total) throw new Error('merkleblock: more hashes than txs');
  const hashes = []; for (let n = 0; n < nHashes; n++) hashes.push(r.bytes(32));
  const flags = r.bytes(r.varint());
  let height = 0; while (((total + (1 << height) - 1) >> height) > 1) height++;
  let bit = 0, hi = 0; const matched = [];
  const width = (h) => (total + (1 << h) - 1) >> h;
  const walk = (h, pos) => {
    if ((bit >> 3) >= flags.length) throw new Error('merkleblock: ran out of flag bits');
    const parentOfMatch = (flags[bit >> 3] >> (bit & 7)) & 1; bit++;
    if (h === 0 || !parentOfMatch) {
      if (hi >= hashes.length) throw new Error('merkleblock: ran out of hashes');
      const hash = hashes[hi++];
      if (h === 0 && parentOfMatch) matched.push(hashHex(hash));
      return hash;
    }
    const left = walk(h - 1, pos * 2);
    let right = left;
    if (pos * 2 + 1 < width(h - 1)) {
      right = walk(h - 1, pos * 2 + 1);
      if (hex(left) === hex(right)) throw new Error('merkleblock: duplicate sibling hashes (CVE-2012-2459)');
    }
    const c = new Uint8Array(64); c.set(left); c.set(right, 32);
    return sha256d(c);
  };
  const root = walk(height, 0);
  // all hashes and all (non-padding) flag bytes must be consumed, as in Core
  if (hi !== hashes.length || Math.ceil(bit / 8) !== flags.length) throw new Error('merkleblock: unconsumed hashes or flag bits');
  return { header, total, matched, rootOk: hashHex(root) === header.merkleRoot };
}

/** CLSIG: height i32 | blockHash 32 | BLS sig 96. */
export function parseChainLock(b) {
  const r = new Reader(b);
  const height = r.i32(), blockHash = r.bytes(32), signature = r.bytes(96);
  if (r.left) throw new Error(`chainlock: ${r.left} trailing bytes`);
  return { height, blockHash: hashHex(blockHash), blockHashInternal: blockHash, signature };
}

/** ISDLOCK: version u8 | inputs[] (txid32,vout u32) | txid 32 | cycleHash 32 | BLS sig 96. */
export function parseInstantLock(b) {
  const r = new Reader(b);
  const version = r.u8();
  const inputs = []; for (let n = r.varint(); n > 0; n--) inputs.push({ txid: hashHex(r.bytes(32)), vout: r.u32() });
  const txid = hashHex(r.bytes(32)), cycleHash = hashHex(r.bytes(32)), signature = r.bytes(96);
  if (r.left) throw new Error(`islock: ${r.left} trailing bytes`);
  return { version, inputs, txid, cycleHash, signature };
}
