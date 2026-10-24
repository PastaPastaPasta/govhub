// Authenticating a DAPI masternode list (SML) against a block: rebuild every entry's consensus serialization from the JSON
// (CBOR) that DAPI streams, recompute merkleRootMNList and merkleRootQuorums, and prove the coinbase (CbTx) that commits to
// them into the block's merkle root through the diff's partial merkle tree. Pure: no I/O.
//
// Dash Core source: /Users/pasta/workspace/dash at f35a24cfca12. Citations are file:line in that tree.
import { Reader, bytesEqual, compareBytes, concat, hashBytes, hashHex, sha256d, unhex } from './bytes.ts';
import { type Tx, merkleRoot, parseTx, readPartialMerkleTree } from './dash.ts';

// ---- serialization helpers ----------------------------------------------------------------------------------------------

function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24);
}
const u16le = (n: number) => Uint8Array.of(n & 0xff, n >> 8);
const u16be = (n: number) => Uint8Array.of(n >> 8, n & 0xff);
const i16le = (n: number) => u16le(n & 0xffff);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58Check decode (version byte + payload). Throws on a bad character or checksum. */
export function base58check(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('base58: bad character');
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  const b = Uint8Array.from(bytes);
  if (b.length < 5) throw new Error('base58: too short');
  const body = b.subarray(0, b.length - 4);
  if (!bytesEqual(sha256d(body).subarray(0, 4), b.subarray(b.length - 4))) throw new Error('base58: bad checksum');
  return body;
}

/** keyIDVoting from a P2PKH address (the version byte is not checked here: the caller's network decides what is valid). */
function p2pkhKeyId(address: string): Uint8Array {
  const b = base58check(address);
  if (b.length !== 21) throw new Error('voting address is not a 20-byte key id');
  return b.subarray(1);
}

/** "host:port" / "[v6]:port" -> address bytes and port. Only IPv4 and IPv6 literals; anything else is a domain. */
function splitHostPort(s: string): { host: string; port: number; v6: boolean } {
  const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(s) ?? /^([^:\[\]]+):(\d{1,5})$/.exec(s);
  if (!m) throw new Error(`bad address "${s}"`);
  const port = Number(m[2]);
  if (port > 0xffff) throw new Error(`bad port in "${s}"`);
  return { host: m[1]!, port, v6: s.startsWith('[') };
}

function ipv4(host: string): Uint8Array | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  if (b.some((x) => x > 255)) return null;
  return Uint8Array.from(b);
}

function ipv6(host: string): Uint8Array {
  const halves = host.split('::');
  if (halves.length > 2) throw new Error(`bad IPv6 "${host}"`);
  const groups = (h: string) => (h ? h.split(':') : []);
  const parse = (gs: string[]) => gs.flatMap((g) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) throw new Error(`bad IPv6 "${host}"`);
    const v = parseInt(g, 16);
    return [v >> 8, v & 0xff];
  });
  const head = parse(groups(halves[0]!)), tail = halves.length === 2 ? parse(groups(halves[1]!)) : [];
  const fill = 16 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) throw new Error(`bad IPv6 "${host}"`);
  return Uint8Array.from([...head, ...new Array<number>(fill).fill(0), ...tail]);
}

/** Legacy CService (CNetAddr 16 bytes, IPv4 as ::ffff:a.b.c.d; port big-endian): netaddress.h, no ADDRV2_FORMAT. */
function legacyService(s: string): Uint8Array {
  const { host, port, v6 } = splitHostPort(s);
  const v4 = v6 ? null : ipv4(host);
  const addr = v4 ? concat(new Uint8Array(10), Uint8Array.of(0xff, 0xff), v4) : v6 ? ipv6(host) : null;
  if (!addr) throw new Error(`"${s}" is not an IP address`);
  return concat(addr, u16be(port));
}

/**
 * One NetInfoEntry (evo/netinfo.h:226-240): type byte, then a CService in BIP155 addrv2 form (network id, CompactSize length,
 * address, port BE) for 0x01, or a DomainPort (CompactSize string, port BE; netinfo.h:176-180) for 0x02.
 */
function netInfoEntry(s: string): Uint8Array {
  const { host, port, v6 } = splitHostPort(s);
  const v4 = v6 ? null : ipv4(host);
  if (v4) return concat(Uint8Array.of(0x01, 1, 4), v4, u16be(port)); // BIP155 NET_IPV4 = 1
  if (v6) return concat(Uint8Array.of(0x01, 2, 16), ipv6(host), u16be(port)); // BIP155 NET_IPV6 = 2
  if (!/^[A-Za-z0-9.-]{3,253}$/.test(host)) throw new Error(`bad domain "${host}"`);
  const name = new TextEncoder().encode(host);
  return concat(Uint8Array.of(0x02), compactSize(name.length), name, u16be(port));
}

/** NetInfoPurpose (evo/netinfo.h:70-76): the map key and its JSON name (PurposeToString). */
const PURPOSES: Array<[number, string]> = [[0, 'core_p2p'], [1, 'platform_p2p'], [2, 'platform_https']];

/** ExtNetInfo (evo/netinfo.h:411-419): version u8 (1), then std::map<purpose u8, vector<NetInfoEntry>> in key order. */
function extNetInfo(addresses: Record<string, unknown>): Uint8Array {
  const keys = Object.keys(addresses);
  for (const k of keys) if (!PURPOSES.some(([, n]) => n === k)) throw new Error(`unknown address purpose "${k}"`);
  const parts: Uint8Array[] = [Uint8Array.of(1)];
  const present = PURPOSES.filter(([, n]) => Array.isArray(addresses[n]) && (addresses[n] as unknown[]).length > 0);
  parts.push(compactSize(present.length));
  for (const [id, name] of present) {
    const list = addresses[name] as unknown[];
    parts.push(Uint8Array.of(id), compactSize(list.length));
    for (const e of list) {
      if (typeof e !== 'string') throw new Error('address entry is not a string');
      parts.push(netInfoEntry(e));
    }
  }
  return concat(...parts);
}

// ---- SML entries (DIP-4) --------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const str = (o: Json, k: string): string => {
  const v = o[k];
  if (typeof v !== 'string') throw new Error(`sml: ${k} is not a string`);
  return v;
};
const num = (o: Json, k: string): number => {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`sml: ${k} is not an integer`);
  return v;
};
const hash32 = (o: Json, k: string) => hashBytes(str(o, k));

/** ProTxVersion (evo/types.h:15-19). */
const PROTX_VERSION = { LegacyBLS: 1, BasicBLS: 2, ExtAddr: 3 } as const;

/**
 * CSimplifiedMNListEntry as Core hashes it (CalcHash = SerializeHash with SER_GETHASH: evo/simplifiedmns.cpp:45-50), i.e. the
 * SERIALIZE_METHODS at evo/simplifiedmns.h:72-101 without the network-only nVersion prefix:
 *   proRegTxHash 32 | confirmedHash 32 | netInfo (legacy CService, or ExtNetInfo when nVersion >= 3) |
 *   pubKeyOperator 48 (legacy encoding iff nVersion == 1) | keyIDVoting 20 | isValid u8 |
 *   [nVersion >= 2: nType u16 | [Evo: [nVersion < 3: platformHTTPPort u16] platformNodeID 20]]
 */
export function smlEntryBytes(e: Json): Uint8Array {
  const version = num(e, 'nVersion'), type = num(e, 'nType');
  if (version < 1 || version > 3) throw new Error(`sml: unsupported entry version ${version}`);
  const parts: Uint8Array[] = [hash32(e, 'proRegTxHash'), hash32(e, 'confirmedHash')];

  const addresses = (e.addresses ?? {}) as Json;
  if (version >= PROTX_VERSION.ExtAddr) {
    parts.push(extNetInfo(addresses));
  } else {
    // MnNetInfo serializes its one CORE_P2P CService, or a default CService ([::]:0) when empty (evo/netinfo.h:325-333).
    const core = Array.isArray(addresses.core_p2p) ? (addresses.core_p2p as unknown[]) : [];
    if (core.length > 1) throw new Error('sml: legacy entry with several core_p2p addresses');
    parts.push(legacyService(typeof core[0] === 'string' ? core[0] : '[::]:0'));
  }

  // pubKeyOperator: Core prints it in the scheme the entry was stored with (CBLSLazyWrapper::ToString, bls/bls.h:571-574), and
  // serializes it in legacy encoding iff nVersion == 1 (simplifiedmns.h:83): the stored scheme of a version-1 entry is legacy, so
  // the printed bytes ARE the serialized ones (the two encodings cannot be told apart from the bytes: 0x80.. is valid in both).
  const op = unhex(str(e, 'pubKeyOperator'));
  if (op.length !== 48) throw new Error('sml: pubKeyOperator is not 48 bytes');
  parts.push(op);

  parts.push(p2pkhKeyId(str(e, 'votingAddress')));
  if (typeof e.isValid !== 'boolean') throw new Error('sml: isValid is not a boolean');
  parts.push(Uint8Array.of(e.isValid ? 1 : 0));

  if (version >= PROTX_VERSION.BasicBLS) {
    parts.push(u16le(type));
    if (type === 1) {
      if (version < PROTX_VERSION.ExtAddr) {
        // platformHTTPPort: printed only with -deprecatedrpc=service (core_write.cpp:397-400); otherwise Core synthesizes
        // addresses.platform_https from it (core_write.cpp:46-48).
        let port = typeof e.platformHTTPPort === 'number' ? e.platformHTTPPort : undefined;
        if (port === undefined) {
          const https = Array.isArray(addresses.platform_https) ? addresses.platform_https[0] : undefined;
          if (typeof https !== 'string') throw new Error('sml: evonode without a platform HTTP port');
          port = splitHostPort(https).port;
        }
        parts.push(u16le(port));
      }
      const id = unhex(str(e, 'platformNodeID'));
      if (id.length !== 20) throw new Error('sml: platformNodeID is not 20 bytes');
      parts.push(id.reverse()); // uint160 prints reversed, like uint256
    }
  }
  return concat(...parts);
}

/** merkleRootMNList: entries sorted by proRegTxHash, leaf = CalcHash. */
export function mnListMerkleRoot(entries: readonly Json[]): { root: Uint8Array; mutated: boolean } {
  // CSimplifiedMNList sorts with uint256::Compare (simplifiedmns.cpp:78-80), a memcmp over the internal byte order.
  const keyed = entries.map((e) => ({ k: hash32(e, 'proRegTxHash'), h: sha256d(smlEntryBytes(e)) }));
  keyed.sort((a, b) => compareBytes(a.k, b.k));
  return merkleRoot(keyed.map((x) => x.h));
}

// ---- quorum commitments -----------------------------------------------------------------------------------------------------

/** Members per LLMQ type (llmq/params.h:146-494): the bit count of the signers / validMembers bitsets. */
export const LLMQ_SIZE: Readonly<Record<number, number>> = {
  1: 50, 2: 400, 3: 400, 4: 100, 5: 60, 6: 25, 100: 3, 101: 12, 102: 3, 103: 4, 104: 3, 105: 8, 106: 3, 107: 12,
};

/**
 * CFinalCommitment (llmq/commitment.h:95-115): nVersion u16 | llmqType u8 | quorumHash 32 | [versions 2, 4: quorumIndex i16] |
 * DYNBITSET signers | DYNBITSET validMembers (CompactSize bit count + (n+7)/8 bytes, serialize.h:620-627, 433-440) |
 * quorumPublicKey 48 | quorumVvecHash 32 | quorumSig 96 | membersSig 96. Versions 1 and 2 use the legacy BLS encoding, and
 * ToJson prints them in that same encoding (llmq/core_write.cpp:26-29), so the hex is used as is.
 */
export function commitmentBytes(q: Json): Uint8Array {
  const version = num(q, 'version'), type = num(q, 'llmqType');
  if (version < 1 || version > 4) throw new Error(`quorum: unsupported commitment version ${version}`);
  const size = LLMQ_SIZE[type];
  if (size === undefined) throw new Error(`quorum: unknown LLMQ type ${type}`);
  const bits = (k: string) => {
    const b = unhex(str(q, k));
    if (b.length !== (size + 7) >> 3) throw new Error(`quorum: ${k} is not ${size} bits`);
    return concat(compactSize(size), b);
  };
  const fixed = (k: string, n: number) => {
    const b = unhex(str(q, k));
    if (b.length !== n) throw new Error(`quorum: ${k} is not ${n} bytes`);
    return b;
  };
  return concat(
    u16le(version), Uint8Array.of(type), hash32(q, 'quorumHash'),
    version === 2 || version === 4 ? i16le(num(q, 'quorumIndex')) : new Uint8Array(0),
    bits('signers'), bits('validMembers'),
    fixed('quorumPublicKey', 48), hash32(q, 'quorumVvecHash'), fixed('quorumSig', 96), fixed('membersSig', 96),
  );
}

/**
 * merkleRootQuorums: the merkle root of the SORTED hashes of every active commitment (CalcCbTxMerkleRootQuorums,
 * evo/cbtx.cpp:65-150; std::sort on uint256 = memcmp of internal bytes). The full SML diff's newQuorums are exactly the
 * active commitments at its block (evo/smldiff.cpp:31-67).
 */
export function quorumsMerkleRoot(quorums: readonly Json[]): Uint8Array {
  const hashes = quorums.map((q) => sha256d(commitmentBytes(q))).sort(compareBytes);
  return merkleRoot(hashes).root;
}

// ---- coinbase payload -------------------------------------------------------------------------------------------------------

export interface CbTx {
  version: number;
  height: number;
  /** Internal byte order. */
  merkleRootMNList: Uint8Array;
  merkleRootQuorums: Uint8Array | null;
  bestCLHeightDiff: number | null;
  bestCLSignature: Uint8Array | null;
  creditPoolBalance: bigint | null;
  merkleRootAssetUnlocks: Uint8Array | null;
}

/** CCbTx payload (evo/cbtx.h:32-70): versions 1 (MN root), 2 (+quorum root), 3 (+best CL, credit pool), 4 (+asset-unlock root). */
export function parseCbTx(tx: Tx): CbTx {
  if (tx.type !== 5 || !tx.extraPayload) throw new Error('cbtx: not a coinbase special transaction');
  const r = new Reader(tx.extraPayload);
  const version = r.u16(), height = r.u32(), merkleRootMNList = r.bytes(32);
  const out: CbTx = { version, height, merkleRootMNList, merkleRootQuorums: null, bestCLHeightDiff: null, bestCLSignature: null, creditPoolBalance: null, merkleRootAssetUnlocks: null };
  if (version < 1 || version > 4) throw new Error(`cbtx: unknown version ${version}`);
  if (version >= 2) out.merkleRootQuorums = r.bytes(32);
  if (version >= 3) {
    out.bestCLHeightDiff = r.varint();
    out.bestCLSignature = r.bytes(96);
    out.creditPoolBalance = r.u64();
  }
  if (version >= 4) out.merkleRootAssetUnlocks = r.bytes(32);
  if (r.left) throw new Error(`cbtx: ${r.left} trailing payload bytes`);
  return out;
}

// ---- the whole proof --------------------------------------------------------------------------------------------------------

export interface SmlProof {
  /** Display-order hash of the block the list is valid at. */
  blockHash: string;
  /** From the CbTx payload, which Core requires to equal the block height (CheckCbTx, evo/cbtx.cpp). */
  height: number;
  /** Display-order merkle root of the block's transactions: compare it with the (verified) header of `blockHash`. */
  blockMerkleRoot: string;
  cbTx: CbTx;
  /** Recomputed roots, display order. */
  mnListRoot: string;
  quorumsRoot: string | null;
  entries: number;
  quorums: number;
}

/**
 * Check a full SML diff (DAPI's first subscribeToMasternodeList message, decoded) for internal consistency with the coinbase it
 * carries: the recomputed MN-list root and quorum root must equal the CbTx's, the CbTx must be the block's coinbase (leaf 0 of
 * the partial merkle tree), and the diff must be a full list (zero base block, nothing deleted). What remains for the caller:
 * the header of `blockHash` (from a verified chain) must have merkle root `blockMerkleRoot`.
 */
export function proveSml(d: Json): SmlProof {
  if (str(d, 'baseBlockHash') !== '0'.repeat(64)) throw new Error('sml: not a full list (non-zero base block)');
  if ((Array.isArray(d.deletedMNs) && d.deletedMNs.length) || (Array.isArray(d.deletedQuorums) && d.deletedQuorums.length)) {
    throw new Error('sml: a full list cannot delete entries');
  }
  const cbTx = parseTx(unhex(str(d, 'cbTx')));
  const cb = parseCbTx(cbTx);
  const treeReader = new Reader(unhex(str(d, 'cbTxMerkleTree')));
  const pmt = readPartialMerkleTree(treeReader);
  if (treeReader.left) throw new Error('merkle: trailing bytes');
  if (pmt.matched.length !== 1 || pmt.positions[0] !== 0 || pmt.matched[0] !== cbTx.txid) throw new Error('sml: the merkle tree does not prove the coinbase');

  const mnList = d.mnList;
  if (!Array.isArray(mnList)) throw new Error('sml: mnList is not an array');
  const seen = new Set<string>();
  for (const e of mnList) {
    const k = str(e as Json, 'proRegTxHash');
    if (seen.has(k)) throw new Error('sml: duplicate proRegTxHash');
    seen.add(k);
  }
  const mn = mnListMerkleRoot(mnList as Json[]);
  if (mn.mutated) throw new Error('sml: mutated MN-list merkle tree'); // CalcCbTxMerkleRootMNList rejects it (simplifiedmns.cpp:166-168)
  if (!bytesEqual(mn.root, cb.merkleRootMNList)) throw new Error(`sml: merkleRootMNList mismatch (recomputed ${hashHex(mn.root)}, coinbase ${hashHex(cb.merkleRootMNList)})`);

  const quorums = Array.isArray(d.newQuorums) ? (d.newQuorums as Json[]) : null;
  if (!quorums) throw new Error('sml: newQuorums is not an array');
  let quorumsRoot: string | null = null;
  if (cb.merkleRootQuorums) {
    const qr = quorumsMerkleRoot(quorums);
    if (!bytesEqual(qr, cb.merkleRootQuorums)) throw new Error(`sml: merkleRootQuorums mismatch (recomputed ${hashHex(qr)}, coinbase ${hashHex(cb.merkleRootQuorums)})`);
    quorumsRoot = hashHex(qr);
  } else if (quorums.length) {
    throw new Error('sml: quorums listed but the coinbase commits to none');
  }
  return {
    blockHash: str(d, 'blockHash').toLowerCase(), height: cb.height, blockMerkleRoot: hashHex(pmt.root), cbTx: cb,
    mnListRoot: hashHex(mn.root), quorumsRoot, entries: mnList.length, quorums: quorums.length,
  };
}
