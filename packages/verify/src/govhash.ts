// Governance object hash. Source of truth: Governance::Object::GetHash() in src/governance/common.cpp:23-37.
import { bytesToHex, concatBytes, hexToBytes, i32le, i64le, isHex, serializeString, sha256d, uint256FromDisplay, uint256ToDisplay, utf8ToBytes } from './bytes.ts';

export interface GovObjectHashInput {
  /** Parent object hash in DISPLAY hex (as RPCs print it). `"0"` / 64 zeros = root (what proposals use). */
  parentHash: string;
  /** int32 */
  revision: number;
  /** int64 unix seconds (the `time` passed to `gobject prepare`, `createdAt` in RPC output). */
  time: number | bigint;
  /** Raw proposal data as hex (the `DataHex` field). Case-insensitive; Core hashes the lowercase `HexStr`. */
  dataHex: string;
}

export interface GovObjectHash {
  /** Internal byte order: this is the value placed in the collateral's OP_RETURN. */
  raw: Uint8Array;
  /** Display byte order (reversed), as printed by `gobject list/get/list-prepared`. */
  display: string;
}

/** Fixed tail of the preimage after the data string: null outpoint (32 x 00 + ffffffff), 0x00, ffffffff, empty vchSig (00). */
const PREIMAGE_TAIL = concatBytes(new Uint8Array(32), Uint8Array.of(0xff, 0xff, 0xff, 0xff), Uint8Array.of(0), Uint8Array.of(0xff, 0xff, 0xff, 0xff), Uint8Array.of(0));

/**
 * The exact bytes hashed by Core. Layout (all integers little endian):
 *
 *   hashParent        32  raw (internal) bytes                      `ss << hashParent`
 *   revision           4  int32                                     `ss << revision`
 *   time               8  int64                                     `ss << time`
 *   HexStr(data)     1+n  CompactSize(len) + ASCII lowercase hex    `ss << HexStr(vchData)` (std::string)
 *   masternodeOutpoint 36 null COutPoint: 32 x 00 + ffffffff        `ss << masternodeOutpoint`
 *   dummy              1  0x00                                      `<< uint8_t{}`
 *   dummy              4  ffffffff                                  `<< 0xffffffff` (unsigned int literal)
 *   vchSig             1  0x00 (empty vector => CompactSize 0)      `ss << vchSig`
 *
 * The result is SHA256d of this buffer. `collateralHash` and the type are NOT hashed ("fee_tx is left out on purpose").
 */
export function governanceObjectPreimage(input: GovObjectHashInput): Uint8Array {
  // `gobject prepare` accepts the literal "0" for the root; otherwise a 64-char hex hash (rpc/governance.cpp:166-171).
  const parent = input.parentHash === '0' ? new Uint8Array(32) : uint256FromDisplay(input.parentHash);
  if (!isHex(input.dataHex)) throw new Error('dataHex must be even-length hex');
  if (!Number.isInteger(input.revision)) throw new Error('revision must be an integer');
  const dataHexAscii = utf8ToBytes(bytesToHex(hexToBytes(input.dataHex)));
  return concatBytes(parent, i32le(input.revision), i64le(input.time), serializeString(dataHexAscii), PREIMAGE_TAIL);
}

export function governanceObjectHash(input: GovObjectHashInput): GovObjectHash {
  const raw = sha256d(governanceObjectPreimage(input));
  return { raw, display: uint256ToDisplay(raw) };
}
