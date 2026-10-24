// Minimal Dash wire-format parsers: tx, block, header, merkleblock, CLSIG, ISDLOCK, coinbase payload.
// All hashes are exposed as display-order (RPC) hex, as on Platform; `*Internal` fields keep wire order.
import { Reader, bytesEqual, concat, hashBytes, hashHex, sha256d } from './bytes.ts';

export interface TxIn { prevTxid: string; vout: number; script: Uint8Array; sequence: number }
export interface TxOut { value: bigint; script: Uint8Array }
export interface Tx {
  /** nVersion as Core's int16. */
  version: number;
  /** Special-transaction type (high 16 bits of the 32-bit version field); 0 for plain transactions. */
  type: number;
  inputs: TxIn[];
  outputs: TxOut[];
  lockTime: number;
  extraPayload: Uint8Array | null;
  raw: Uint8Array;
  txid: string;
}

/** Parse one transaction from the reader. Dash has no segwit marker. */
export function readTx(r: Reader): Tx {
  const start = r.i;
  const ver = r.u32();
  const version = (ver << 16) >> 16, type = ver >>> 16;
  const inputs: TxIn[] = [];
  for (let n = r.varint(); n > 0; n--) inputs.push({ prevTxid: hashHex(r.bytes(32)), vout: r.u32(), script: r.bytes(r.varint()), sequence: r.u32() });
  const outputs: TxOut[] = [];
  for (let n = r.varint(); n > 0; n--) outputs.push({ value: r.u64(), script: r.bytes(r.varint()) });
  const lockTime = r.u32();
  let extraPayload: Uint8Array | null = null;
  if (version >= 3 && type !== 0) extraPayload = r.bytes(r.varint());
  const raw = r.b.subarray(start, r.i);
  return { version, type, inputs, outputs, lockTime, extraPayload, raw, txid: hashHex(sha256d(raw)) };
}

export const parseTx = (raw: Uint8Array): Tx => {
  const r = new Reader(raw);
  const tx = readTx(r);
  if (r.left) throw new Error(`tx: ${r.left} trailing bytes`);
  return tx;
};

export type ScriptClass =
  | { type: 'p2pkh'; hash: Uint8Array }
  | { type: 'p2sh'; hash: Uint8Array }
  | { type: 'op_return'; data: Uint8Array | null }
  | { type: 'other' };

/** Classify an output script. OP_RETURN data is returned for a single-push script (what governance collateral uses). */
export function classifyScript(s: Uint8Array): ScriptClass {
  if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac) return { type: 'p2pkh', hash: s.subarray(3, 23) };
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) return { type: 'p2sh', hash: s.subarray(2, 22) };
  if (s[0] === 0x6a) {
    let data: Uint8Array | null = null;
    if (s.length > 1 && s[1]! >= 1 && s[1]! <= 75 && s.length === 2 + s[1]!) data = s.subarray(2);
    else if (s.length > 2 && s[1] === 0x4c && s.length === 3 + s[2]!) data = s.subarray(3);
    return { type: 'op_return', data };
  }
  return { type: 'other' };
}

export interface BlockHeader {
  version: number;
  prevHash: string;
  merkleRoot: string;
  time: number;
  bits: number;
  nonce: number;
  /** The 80 header bytes; X11 of these is the block hash. */
  raw: Uint8Array;
}

export function parseHeader(h: Uint8Array): BlockHeader {
  if (h.length < 80) throw new Error('dash: header too short');
  const r = new Reader(h);
  return { version: r.i32(), prevHash: hashHex(r.bytes(32)), merkleRoot: hashHex(r.bytes(32)), time: r.u32(), bits: r.u32(), nonce: r.u32(), raw: h.subarray(0, 80) };
}

/** Bitcoin merkle root over internal-order leaves (ComputeMerkleRoot, consensus/merkle.cpp); `mutated` per CVE-2012-2459. */
export function merkleRoot(leaves: readonly Uint8Array[]): { root: Uint8Array; mutated: boolean } {
  if (!leaves.length) return { root: new Uint8Array(32), mutated: false };
  let level = leaves.slice(), mutated = false;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!, b = level[i + 1] ?? a;
      if (i + 1 < level.length && bytesEqual(a, b)) mutated = true;
      next.push(sha256d(concat(a, b)));
    }
    level = next;
  }
  return { root: level[0]!, mutated };
}

export interface PartialMerkle {
  /** Internal-order root the tree hashes to. */
  root: Uint8Array;
  /** Matched leaves (display-order txids), in tree order. */
  matched: string[];
  /** Position of each matched leaf. */
  positions: number[];
  total: number;
}

/**
 * Parse and evaluate a serialized CPartialMerkleTree (nTransactions u32 | vHash | vBits bytes) with Core's checks
 * (merkleblock.cpp:100-170: no unconsumed hashes or bits, no duplicate siblings, sane counts).
 */
export function readPartialMerkleTree(r: Reader): PartialMerkle {
  const total = r.u32();
  if (total === 0 || total > (2_000_000 / 60) * 2) throw new Error('merkle: bad tx count');
  const nHashes = r.varint();
  if (nHashes > total) throw new Error('merkle: more hashes than txs');
  const hashes: Uint8Array[] = [];
  for (let n = 0; n < nHashes; n++) hashes.push(r.bytes(32));
  const flags = r.bytes(r.varint());
  let height = 0;
  while (((total + (1 << height) - 1) >> height) > 1) height++;
  let bit = 0, hi = 0;
  const matched: string[] = [], positions: number[] = [];
  const width = (h: number) => (total + (1 << h) - 1) >> h;
  const walk = (h: number, pos: number): Uint8Array => {
    if ((bit >> 3) >= flags.length) throw new Error('merkle: ran out of flag bits');
    const parentOfMatch = (flags[bit >> 3]! >> (bit & 7)) & 1; bit++;
    if (h === 0 || !parentOfMatch) {
      if (hi >= hashes.length) throw new Error('merkle: ran out of hashes');
      const hash = hashes[hi++]!;
      if (h === 0 && parentOfMatch) { matched.push(hashHex(hash)); positions.push(pos); }
      return hash;
    }
    const left = walk(h - 1, pos * 2);
    let right = left;
    if (pos * 2 + 1 < width(h - 1)) {
      right = walk(h - 1, pos * 2 + 1);
      if (bytesEqual(left, right)) throw new Error('merkle: duplicate sibling hashes (CVE-2012-2459)');
    }
    return sha256d(concat(left, right));
  };
  const root = walk(height, 0);
  if (hi !== hashes.length || Math.ceil(bit / 8) !== flags.length) throw new Error('merkle: unconsumed hashes or flag bits');
  return { root, matched, positions, total };
}

export interface Block { header: BlockHeader; txs: Tx[]; /** merkle root recomputed from the txids equals the header's */ merkleOk: boolean }

/** Full block: header + txs; recomputes the merkle root from the txids and compares it with the header. */
export function parseBlock(raw: Uint8Array): Block {
  const r = new Reader(raw);
  const header = parseHeader(r.bytes(80));
  const txs: Tx[] = [];
  for (let n = r.varint(); n > 0; n--) txs.push(readTx(r));
  if (r.left) throw new Error(`block: ${r.left} trailing bytes`);
  // A mutated tree (duplicated trailing txs, CVE-2012-2459) hashes to the real root but Core rejects the block (bad-txns-duplicate).
  const { root, mutated } = merkleRoot(txs.map((t) => hashBytes(t.txid)));
  return { header, txs, merkleOk: !mutated && bytesEqual(hashBytes(header.merkleRoot), root) };
}

export interface MerkleBlock {
  header: BlockHeader;
  total: number;
  /** Matched txids (display order), in tree order. */
  matched: string[];
  /** The partial merkle tree hashes up to the header's merkle root. */
  rootOk: boolean;
}

/** BIP37 merkleblock with a strictly validated partial merkle tree (same rules as Core's CPartialMerkleTree::ExtractMatches). */
export function parseMerkleBlock(raw: Uint8Array): MerkleBlock {
  const r = new Reader(raw);
  const header = parseHeader(r.bytes(80));
  const { root, matched, total } = readPartialMerkleTree(r);
  return { header, total, matched, rootOk: hashHex(root) === header.merkleRoot };
}

export interface ChainLock {
  height: number;
  /** Display order. */
  blockHash: string;
  /** Wire order, as used inside the BLS sign hash. */
  blockHashInternal: Uint8Array;
  signature: Uint8Array;
}

/** CLSIG: height i32 | blockHash 32 | BLS sig 96. */
export function parseChainLock(b: Uint8Array): ChainLock {
  const r = new Reader(b);
  const height = r.i32(), blockHash = r.bytes(32), signature = r.bytes(96);
  if (r.left) throw new Error(`chainlock: ${r.left} trailing bytes`);
  return { height, blockHash: hashHex(blockHash), blockHashInternal: blockHash, signature };
}

export interface InstantLock {
  version: number;
  inputs: { txid: string; vout: number }[];
  txid: string;
  cycleHash: string;
  signature: Uint8Array;
}

/** ISDLOCK (deterministic IS-lock, version 1): version u8 | inputs[] (txid32, vout u32) | txid 32 | cycleHash 32 | BLS sig 96. */
export function parseInstantLock(b: Uint8Array): InstantLock {
  const r = new Reader(b);
  const version = r.u8();
  if (version !== 1) throw new Error(`islock: unsupported version ${version}`);
  const inputs: InstantLock['inputs'] = [];
  for (let n = r.varint(); n > 0; n--) inputs.push({ txid: hashHex(r.bytes(32)), vout: r.u32() });
  const txid = hashHex(r.bytes(32)), cycleHash = hashHex(r.bytes(32)), signature = r.bytes(96);
  if (r.left) throw new Error(`islock: ${r.left} trailing bytes`);
  return { version, inputs, txid, cycleHash, signature };
}

/**
 * Height committed to by a block's coinbase. Special coinbases (version 3, type 5, DIP4) carry `nVersion u16 | nHeight u32` at the
 * start of their payload; Core requires it to equal the block height (CheckCbTx). The BIP34 push in the scriptSig is the fallback.
 */
export function coinbaseHeight(tx: Tx): number | null {
  if (tx.type === 5 && tx.extraPayload && tx.extraPayload.length >= 6) {
    const r = new Reader(tx.extraPayload); r.u16();
    return r.u32();
  }
  const s = tx.inputs[0]?.script;
  if (s && s.length >= 2 && s[0]! >= 1 && s[0]! <= 4 && s.length > s[0]!) {
    let h = 0;
    for (let i = s[0]!; i >= 1; i--) h = h * 256 + s[i]!;
    return h;
  }
  return null;
}
