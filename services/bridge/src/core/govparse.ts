// Parsers for the raw governance payloads Dash Core publishes on ZMQ and stores on disk.
//
// Source of truth (Dash Core, /Users/pasta/workspace/dash at HEAD; the mainnet node runs v23.1.8 whose wire format is the same):
//  - CGovernanceVote fields              src/governance/vote.h:75-80
//  - CGovernanceVote::SERIALIZE_METHODS   src/governance/vote.h:190-207  (outpoint, nParentHash, nVoteOutcome, nVoteSignal, nTime,
//                                         then vchSig unless SER_GETHASH; network reads cap vchSig at 96 B and require 65 or 96 B, :197-201)
//  - CGovernanceVote::UpdateHash          src/governance/vote.cpp:145-156 (vote hash; "doesn't match serialization")
//  - enums are serialized as their underlying `int` (serialize.h:955-964; vote.h:22-40, common.h:25-30)
//  - Governance::Object fields/serialize  src/governance/common.h:48-84 (hashParent, revision, time, collateralHash, vchData,
//                                         type, masternodeOutpoint, then vchSig unless SER_GETHASH)
//  - Governance::Object::GetHash          src/governance/common.cpp:23-39
//  - COutPoint                            src/primitives/transaction.h (READWRITE(hash, n)); ToStringShort = "<txid>-<n>"
//  - ZMQ publishers                       src/zmq/zmqpublishnotifier.cpp:457-473 (`CDataStream ss(SER_NETWORK, ...); ss << *vote / *govobj`)
import { Reader, bytesToHex, concatBytes, compactSize, hexToBytes, i32le, i64le, isHex, sha256d, u32le, uint256ToDisplay, utf8ToBytes, uint256FromDisplay } from '@govhub/verify';

export interface Outpoint {
  /** DISPLAY hex (as RPCs print it). */
  txid: string;
  n: number;
}

export const NULL_OUTPOINT: Outpoint = { txid: '0'.repeat(64), n: 0xffffffff };

export const outpointKey = (o: Outpoint): string => `${o.txid}-${o.n}`;

export interface ParsedVote {
  /** Vote hash (CGovernanceVote::GetHash), DISPLAY hex: the keys of `gobject getcurrentvotes`. */
  hash: string;
  outpoint: Outpoint;
  /** Parent object (proposal / trigger) hash, DISPLAY hex. */
  parentHash: string;
  outcome: number;
  signal: number;
  /** nTime, unix seconds (int64 on the wire; values outside the JS safe range are rejected). */
  time: number;
  /** vchSig: 65 B compact ECDSA (voting key) or 96 B BLS (operator key). */
  sig: Uint8Array;
  /** Exact SER_NETWORK bytes. */
  raw: Uint8Array;
}

export interface ParsedGovObject {
  /** Governance::Object::GetHash, DISPLAY hex. */
  hash: string;
  parentHash: string;
  revision: number;
  time: number;
  collateralHash: string;
  /** Lowercase hex of vchData (Core's DataHex). */
  dataHex: string;
  /** 1 = proposal, 2 = trigger (GovernanceObject enum, common.h:25-29). */
  type: number;
  masternodeOutpoint: Outpoint;
  sig: Uint8Array;
  raw: Uint8Array;
}

function readOutpoint(r: Reader): Outpoint {
  const hash = r.bytes(32);
  const n = r.u32();
  return { txid: uint256ToDisplay(hash), n };
}

function writeOutpoint(o: Outpoint): Uint8Array {
  return concatBytes(uint256FromDisplay(o.txid), u32le(o.n));
}

function readI64Safe(r: Reader, what: string): number {
  const v = r.i64();
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${what} outside the safe integer range`);
  return Number(v);
}

/** Reads one CGovernanceVote from `r`. `network` = SER_NETWORK rules (signature size 65 or 96), otherwise SER_DISK (any size). */
export function readVote(r: Reader, network: boolean): Omit<ParsedVote, 'raw'> {
  const outpoint = readOutpoint(r);
  const parentHash = uint256ToDisplay(r.bytes(32));
  const outcome = r.i32();
  const signal = r.i32();
  const time = readI64Safe(r, 'vote time');
  const sigLen = r.compactSize();
  if (network && sigLen > 96) throw new Error('vote signature exceeds 96 bytes');
  if (network && sigLen !== 65 && sigLen !== 96) throw new Error(`bad governance vote signature size ${sigLen}`);
  const sig = r.bytes(sigLen).slice();
  return { hash: voteHash({ outpoint, parentHash, outcome, signal, time }), outpoint, parentHash, outcome, signal, time, sig };
}

/** Parses a `rawgovernancevote` ZMQ body (exact SER_NETWORK CGovernanceVote, no trailing bytes). */
export function parseRawVote(raw: Uint8Array): ParsedVote {
  const r = new Reader(raw);
  const v = readVote(r, true);
  if (r.remaining !== 0) throw new Error(`${r.remaining} trailing bytes after governance vote`);
  return { ...v, raw: raw.slice() };
}

/** Serializes a vote back to its SER_NETWORK form (used to re-create raw bytes for votes read from governance.dat). */
export function serializeVote(v: Pick<ParsedVote, 'outpoint' | 'parentHash' | 'outcome' | 'signal' | 'time' | 'sig'>): Uint8Array {
  return concatBytes(writeOutpoint(v.outpoint), uint256FromDisplay(v.parentHash), i32le(v.outcome), i32le(v.signal), i64le(v.time), compactSize(v.sig.length), v.sig);
}

/**
 * CGovernanceVote::UpdateHash (vote.cpp:145-156):
 *   SHA256d( outpoint (36) | uint8 0 | uint32 0xffffffff | nParentHash (32 raw) | nVoteSignal i32 | nVoteOutcome i32 | nTime i64 )
 * NOTE: signal before outcome here, the reverse of the serialization order.
 */
export function voteHash(v: Pick<ParsedVote, 'outpoint' | 'parentHash' | 'outcome' | 'signal' | 'time'>): string {
  const pre = concatBytes(writeOutpoint(v.outpoint), Uint8Array.of(0), u32le(0xffffffff), uint256FromDisplay(v.parentHash), i32le(v.signal), i32le(v.outcome), i64le(v.time));
  return uint256ToDisplay(sha256d(pre));
}

/** Reads one Governance::Object (identical layout for SER_NETWORK and the first part of the SER_DISK CGovernanceObject). */
export function readGovObject(r: Reader): Omit<ParsedGovObject, 'raw' | 'hash'> {
  const parentHash = uint256ToDisplay(r.bytes(32));
  const revision = r.i32();
  const time = readI64Safe(r, 'object time');
  const collateralHash = uint256ToDisplay(r.bytes(32));
  const dataLen = r.compactSize();
  const dataHex = bytesToHex(r.bytes(dataLen));
  const type = r.i32();
  const masternodeOutpoint = readOutpoint(r);
  const sigLen = r.compactSize();
  const sig = r.bytes(sigLen).slice();
  return { parentHash, revision, time, collateralHash, dataHex, type, masternodeOutpoint, sig };
}

/** Parses a `rawgovernanceobject` ZMQ body. */
export function parseRawGovObject(raw: Uint8Array): ParsedGovObject {
  const r = new Reader(raw);
  const o = readGovObject(r);
  if (r.remaining !== 0) throw new Error(`${r.remaining} trailing bytes after governance object`);
  return { ...o, hash: govObjectHash(o), raw: raw.slice() };
}

export function serializeGovObject(o: Omit<ParsedGovObject, 'raw' | 'hash'>): Uint8Array {
  const data = hexToBytesStrict(o.dataHex);
  return concatBytes(uint256FromDisplay(o.parentHash), i32le(o.revision), i64le(o.time), uint256FromDisplay(o.collateralHash), compactSize(data.length), data, i32le(o.type), writeOutpoint(o.masternodeOutpoint), compactSize(o.sig.length), o.sig);
}

/**
 * Governance::Object::GetHash (common.cpp:23-39), general form (also triggers, which carry a masternode outpoint and signature):
 *   SHA256d( hashParent | revision i32 | time i64 | string(HexStr(vchData)) | masternodeOutpoint | uint8 0 | uint32 0xffffffff | vector(vchSig) )
 * For proposals this equals `governanceObjectHash` in @govhub/verify (null outpoint, empty signature).
 */
export function govObjectHash(o: Pick<ParsedGovObject, 'parentHash' | 'revision' | 'time' | 'dataHex' | 'masternodeOutpoint' | 'sig'>): string {
  const hexText = utf8ToBytes(bytesToHex(hexToBytesStrict(o.dataHex)));
  const pre = concatBytes(
    uint256FromDisplay(o.parentHash),
    i32le(o.revision),
    i64le(o.time),
    compactSize(hexText.length),
    hexText,
    writeOutpoint(o.masternodeOutpoint),
    Uint8Array.of(0),
    u32le(0xffffffff),
    compactSize(o.sig.length),
    o.sig,
  );
  return uint256ToDisplay(sha256d(pre));
}

function hexToBytesStrict(hex: string): Uint8Array {
  if (!isHex(hex)) throw new Error('invalid hex');
  return hexToBytes(hex);
}

/** Parses a 32-byte ZMQ hash body (hashblock / hashchainlock): Core sends the hash in DISPLAY byte order (zmqpublishnotifier.cpp, reversed copy). */
export function parseHashBody(body: Uint8Array): string {
  if (body.length !== 32) throw new Error(`hash body must be 32 bytes, got ${body.length}`);
  return bytesToHex(body);
}
