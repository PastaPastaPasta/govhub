// The masternode keyring's plaintext (docs/PLAN.md §4.2, §5.1-5.2; forum.keyring, packages/contracts-v1/README.md).
//
// Two documents per identity, both `forum.keyring` (unique [$ownerId, kind]):
//   kind 0 KEYS     the voting keys, node labels, who may unlock (seed / passkeys) and the idle-lock setting
//   kind 1 PENDING  signed votes waiting at a relay (deferred voting), so any device can watch and re-broadcast them
//
// Number privacy: a document's size depends ONLY on its bucket, and the bucket is chosen from item COUNTS against fixed caps, never
// from byte lengths, so the chain learns "bucket 1" or "bucket 2" and nothing finer. Caps (all labels at their 32-byte maximum fit):
//
//   KEYS     bucket 1 (4,096 B ciphertext, 1 field):   <= 32 voting keys, <= 24 node labels, <= 8 unlockers
//            bucket 2 (12,288 B, 3 fields):            <= 96 voting keys, <= 80 node labels       (leaks only "more than bucket 1")
//   PENDING  bucket 1:                                 <= 16 votes, <= 4 relays
//            bucket 2:                                 <= 60 votes
// Beyond bucket 2 the encoder refuses (the UI says so); a masternode count is never stored at all (it is derived from the keys).
//
// Byte layout (big-endian integers), padded with zeros to the bucket's plaintext length:
//   u8 version (1) | u8 kind | u16 contentLength | content | 0x00...
//   KEYS content:    16 keyringId (random, fixed for the keyring's life) | u32 generation (+1 on every write)
//                    u8 nUnlockers { u8 type (1 seed, 2 passkey) | 32 recipientKey | u32 addedAt }
//                    u8 nKeys      { 32 privateKey | u8 flags (bit 0 = compressed) | u8 labelLen | label }
//                    u16 nLabels   { 32 proTxHash (display order bytes) | u8 labelLen | label }
//                    u16 idleLockMinutes
//   PENDING content: 16 keyringId (must equal the KEYS document's: a PENDING document sealed by someone else is ignored)
//                    u8 nRelays    { u8 urlLen | url (UTF-8, <= 120 B) }
//                    u16 nVotes    { 32 collateralTxid (display) | u32 index | 32 govHash (display) | u8 outcome | i64 time | 65 sig |
//                                    i64 releaseAt | u8 nRefs (0..2) { u8 relayIndex | 16 relayVoteId } | u8 network }
//                    The trailing u8 network (0 unknown, 1 mainnet, 2 testnet) is content version 2: the Dev and Testnet profiles share
//                    one keyring (same Platform network) but vote on different Core networks, so each vote says which one it is for.
//                    Version-1 documents (no tag) still decode, with the network unknown.
import { bytesEqual, bytesToHex, hexToBytes } from '../bytes.ts';
import { isValidPrivateKey } from '../keys.ts';

export const KEYRING_FORMAT_VERSION = 1;
/** PENDING plaintext version: 2 adds the Core network of each vote (1 is still read). */
export const PENDING_CONTENT_VERSION = 2;
export const KeyringKind = { KEYS: 0, PENDING: 1 } as const;
export type KeyringKind = (typeof KeyringKind)[keyof typeof KeyringKind];

/** Every ciphertext field holds exactly this many bytes (XChaCha20-Poly1305 output incl. the 24-byte nonce, split in fields). */
export const CHUNK_LENGTH = 4096;
export const NONCE_LENGTH = 24;
export const TAG_LENGTH = 16;
export const BUCKET_CHUNKS: Readonly<Record<number, number>> = { 1: 1, 2: 3 };
export const plaintextLength = (bucket: number): number => {
  const chunks = BUCKET_CHUNKS[bucket];
  if (!chunks) throw new KeyringFormatError(`unknown keyring bucket ${bucket}`);
  return chunks * CHUNK_LENGTH - NONCE_LENGTH - TAG_LENGTH;
};

export const MAX_LABEL_BYTES = 32;
export const MAX_UNLOCKERS = 8;
export const MAX_RELAY_URL_BYTES = 120;
export const MAX_RELAYS = 4;
export const MAX_REFS_PER_VOTE = 2;
export const KEYS_CAPS = { 1: { keys: 32, labels: 24 }, 2: { keys: 96, labels: 80 } } as const;
export const PENDING_CAPS = { 1: { votes: 16 }, 2: { votes: 60 } } as const;
export const DEFAULT_IDLE_LOCK_MINUTES = 15;
/** The generation is a u32 on the wire. */
export const MAX_GENERATION = 0xffffffff;

export class KeyringFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringFormatError';
  }
}
const need = (c: boolean, m: string): void => {
  if (!c) throw new KeyringFormatError(m);
};

export const UnlockerType = { SEED: 1, PASSKEY: 2 } as const;
export type UnlockerType = (typeof UnlockerType)[keyof typeof UnlockerType];

/** Who can open the keyring: the public half of an HPKE recipient (seed-derived, or a passkey's PRF key = its vault recipientKey). */
export interface Unlocker {
  type: UnlockerType;
  recipientKey: Uint8Array;
  /** unix seconds */
  addedAt: number;
}

export interface VotingKeyEntry {
  /** 32 bytes; wiped by `wipeKeysContent`. */
  privateKey: Uint8Array;
  /** Whether keyIDVoting is the hash of the compressed point (almost always). */
  compressed: boolean;
  label: string;
}

export interface NodeLabel {
  /** display hex, lowercase */
  proTxHash: string;
  label: string;
}

export const KEYRING_ID_LENGTH = 16;

export interface KeysContent {
  /** Random id, fixed for the keyring's life; PENDING documents must carry the same one. */
  keyringId: Uint8Array;
  /** Incremented on every write; a client remembers the highest it saw and warns about a replayed older document. */
  generation: number;
  unlockers: Unlocker[];
  keys: VotingKeyEntry[];
  labels: NodeLabel[];
  idleLockMinutes: number;
}

export interface RelayRef {
  /** Relay base URL (normalized, no trailing slash). */
  relay: string;
  /** 32 hex chars, the id POST /v1/votes returned. */
  id: string;
}

export type PendingNetwork = 'mainnet' | 'testnet';
const NETWORK_CODE: Record<PendingNetwork, number> = { mainnet: 1, testnet: 2 };
const NETWORK_OF: Record<number, PendingNetwork> = { 1: 'mainnet', 2: 'testnet' };

export interface PendingVote {
  /** the Core network the vote is signed for; absent on version-1 documents */
  network?: PendingNetwork;
  collateralTxid: string;
  collateralIndex: number;
  govHash: string;
  outcome: number;
  time: number;
  /** 65-byte compact signature (base64 is what relays take) */
  sig: Uint8Array;
  releaseAt: number;
  refs: RelayRef[];
}

export interface PendingContent {
  keyringId: Uint8Array;
  votes: PendingVote[];
}

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

/** Labels: NFC, trimmed, at most MAX_LABEL_BYTES of UTF-8 (cut on a character boundary). */
export function normalizeLabel(label: string): string {
  let s = label.normalize('NFC').trim().replace(/[\u0000-\u001f\u007f]/g, '');
  while (te.encode(s).length > MAX_LABEL_BYTES) s = Array.from(s).slice(0, -1).join('');
  return s;
}

export function keysBucket(c: Pick<KeysContent, 'keys' | 'labels' | 'unlockers'>): 1 | 2 {
  need(c.unlockers.length >= 1 && c.unlockers.length <= MAX_UNLOCKERS, `a keyring has 1 to ${MAX_UNLOCKERS} unlockers`);
  if (c.keys.length <= KEYS_CAPS[1].keys && c.labels.length <= KEYS_CAPS[1].labels) return 1;
  if (c.keys.length <= KEYS_CAPS[2].keys && c.labels.length <= KEYS_CAPS[2].labels) return 2;
  throw new KeyringFormatError(`a keyring holds at most ${KEYS_CAPS[2].keys} voting keys and ${KEYS_CAPS[2].labels} node labels`);
}

export function pendingBucket(c: PendingContent): 1 | 2 {
  const relays = relayTable(c);
  need(relays.length <= MAX_RELAYS, `pending votes may use at most ${MAX_RELAYS} relays`);
  if (c.votes.length <= PENDING_CAPS[1].votes) return 1;
  if (c.votes.length <= PENDING_CAPS[2].votes) return 2;
  throw new KeyringFormatError(`at most ${PENDING_CAPS[2].votes} pending votes can be backed up on Platform`);
}

const relayTable = (c: PendingContent): string[] => [...new Set(c.votes.flatMap((v) => v.refs.map((r) => r.relay)))].sort();

class Writer {
  readonly buf: Uint8Array;
  pos = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
  }
  private room(n: number) {
    need(this.pos + n <= this.buf.length, 'keyring content does not fit its bucket');
  }
  u8(v: number) {
    this.room(1);
    this.buf[this.pos++] = v & 0xff;
  }
  u16(v: number) {
    need(Number.isInteger(v) && v >= 0 && v <= 0xffff, 'u16 out of range');
    this.u8(v >> 8);
    this.u8(v);
  }
  u32(v: number) {
    need(Number.isInteger(v) && v >= 0 && v <= 0xffffffff, 'u32 out of range');
    this.room(4);
    new DataView(this.buf.buffer).setUint32(this.pos, v);
    this.pos += 4;
  }
  i64(v: number) {
    need(Number.isSafeInteger(v), 'i64 out of range');
    this.room(8);
    new DataView(this.buf.buffer).setBigInt64(this.pos, BigInt(v));
    this.pos += 8;
  }
  bytes(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  str(s: string, max: number) {
    const b = te.encode(s);
    need(b.length <= max, `text longer than ${max} bytes`);
    this.u8(b.length);
    this.bytes(b);
  }
}

class Reader {
  pos = 0;
  readonly buf: Uint8Array;
  readonly end: number;
  constructor(buf: Uint8Array, start: number, end: number) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }
  private take(n: number): number {
    need(this.pos + n <= this.end, 'truncated keyring content');
    const p = this.pos;
    this.pos += n;
    return p;
  }
  u8() {
    return this.buf[this.take(1)]!;
  }
  u16() {
    const p = this.take(2);
    return (this.buf[p]! << 8) | this.buf[p + 1]!;
  }
  u32() {
    const p = this.take(4);
    return new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(p);
  }
  i64() {
    const p = this.take(8);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset).getBigInt64(p);
    need(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER), 'i64 out of range');
    return Number(v);
  }
  bytes(n: number) {
    const p = this.take(n);
    return this.buf.slice(p, p + n);
  }
  str(max: number) {
    const n = this.u8();
    need(n <= max, 'text too long');
    try {
      return td.decode(this.bytes(n));
    } catch {
      throw new KeyringFormatError('label is not UTF-8');
    }
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const isTime = (t: number) => Number.isSafeInteger(t) && t >= 0;

function header(w: Writer, kind: KeyringKind, version = KEYRING_FORMAT_VERSION) {
  w.u8(version);
  w.u8(kind);
  w.u16(0); // content length, patched below
}
function finish(w: Writer): Uint8Array {
  const len = w.pos - 4;
  w.buf[2] = len >> 8;
  w.buf[3] = len & 0xff;
  return w.buf;
}

/** Encodes and pads the KEYS content. The caller wipes the returned buffer (it holds private keys). */
export function encodeKeys(c: KeysContent): { bucket: 1 | 2; plaintext: Uint8Array } {
  const bucket = keysBucket(c);
  const w = new Writer(plaintextLength(bucket));
  try {
    header(w, KeyringKind.KEYS);
    need(c.keyringId.length === KEYRING_ID_LENGTH, 'keyring id must be 16 bytes');
    w.bytes(c.keyringId);
    w.u32(c.generation);
    w.u8(c.unlockers.length);
    const seen = new Set<string>();
    for (const u of c.unlockers) {
      need(u.type === UnlockerType.SEED || u.type === UnlockerType.PASSKEY, 'unknown unlocker type');
      need(u.recipientKey.length === 32, 'an unlocker key is 32 bytes');
      const k = bytesToHex(u.recipientKey);
      need(!seen.has(k), 'an unlocker appears twice');
      seen.add(k);
      w.u8(u.type);
      w.bytes(u.recipientKey);
      w.u32(u.addedAt);
    }
    w.u8(c.keys.length);
    c.keys.forEach((k, i) => need(!c.keys.slice(0, i).some((o) => bytesEqual(o.privateKey, k.privateKey)), 'a voting key appears twice'));
    for (const k of c.keys) {
      need(isValidPrivateKey(k.privateKey), 'invalid voting key');
      w.bytes(k.privateKey);
      w.u8(k.compressed ? 1 : 0);
      w.str(normalizeLabel(k.label), MAX_LABEL_BYTES);
    }
    w.u16(c.labels.length);
    const pros = new Set<string>();
    for (const l of c.labels) {
      const h = l.proTxHash.toLowerCase();
      need(HEX64.test(h), 'node label: proTxHash must be 64 hex chars');
      need(!pros.has(h), 'a node is labelled twice');
      pros.add(h);
      w.bytes(hexToBytes(h));
      w.str(normalizeLabel(l.label), MAX_LABEL_BYTES);
    }
    need(Number.isInteger(c.idleLockMinutes) && c.idleLockMinutes >= 1 && c.idleLockMinutes <= 24 * 60, 'idle lock must be 1 to 1440 minutes');
    w.u16(c.idleLockMinutes);
    return { bucket, plaintext: finish(w) };
  } catch (e) {
    w.buf.fill(0);
    throw e;
  }
}

function open(pt: Uint8Array, bucket: number, kind: KeyringKind, versions: readonly number[] = [KEYRING_FORMAT_VERSION]): Reader {
  need(pt.length === plaintextLength(bucket), 'keyring plaintext has the wrong length for its bucket');
  need(pt[1] === kind, 'keyring content is of another kind');
  need(versions.includes(pt[0]!), 'unknown keyring format version');
  const len = (pt[2]! << 8) | pt[3]!;
  need(4 + len <= pt.length, 'keyring content length out of range');
  need(pt.subarray(4 + len).every((b) => b === 0), "the keyring's padding is not zero");
  return new Reader(pt, 4, 4 + len);
}
const done = (r: Reader) => need(r.pos === r.end, 'trailing bytes in keyring content');

/** Decodes KEYS content (strict: no duplicates, canonical caps for the bucket, zero padding). Private keys are fresh copies. */
export function decodeKeys(pt: Uint8Array, bucket: number): KeysContent {
  const r = open(pt, bucket, KeyringKind.KEYS);
  const out: KeysContent = { keyringId: new Uint8Array(KEYRING_ID_LENGTH), generation: 0, unlockers: [], keys: [], labels: [], idleLockMinutes: DEFAULT_IDLE_LOCK_MINUTES };
  try {
    out.keyringId = r.bytes(KEYRING_ID_LENGTH);
    out.generation = r.u32();
    const nu = r.u8();
    for (let i = 0; i < nu; i++) {
      const type = r.u8();
      need(type === UnlockerType.SEED || type === UnlockerType.PASSKEY, 'unknown unlocker type');
      out.unlockers.push({ type: type as UnlockerType, recipientKey: r.bytes(32), addedAt: r.u32() });
    }
    const nk = r.u8();
    for (let i = 0; i < nk; i++) {
      const privateKey = r.bytes(32);
      out.keys.push({ privateKey, compressed: false, label: '' });
      const flags = r.u8();
      need((flags & ~1) === 0, 'unknown voting key flags');
      out.keys[i]!.compressed = (flags & 1) === 1;
      out.keys[i]!.label = r.str(MAX_LABEL_BYTES);
      need(isValidPrivateKey(privateKey), 'invalid voting key');
    }
    const nl = r.u16();
    for (let i = 0; i < nl; i++) out.labels.push({ proTxHash: bytesToHex(r.bytes(32)), label: r.str(MAX_LABEL_BYTES) });
    out.idleLockMinutes = r.u16();
    done(r);
    // the encoder's own rules: refuse a document a correct client could not have written (duplicates, wrong bucket for the counts)
    need(keysBucket(out) === bucket, 'keyring bucket does not match its content');
    encodeKeys(out).plaintext.fill(0);
    return out;
  } catch (e) {
    wipeKeysContent(out);
    throw e instanceof KeyringFormatError ? e : new KeyringFormatError(String((e as Error)?.message ?? e));
  }
}

export function wipeKeysContent(c: KeysContent | null | undefined): void {
  if (!c) return;
  for (const k of c.keys) k.privateKey.fill(0);
}

export function encodePending(c: PendingContent): { bucket: 1 | 2; plaintext: Uint8Array } {
  const bucket = pendingBucket(c);
  const relays = relayTable(c);
  const w = new Writer(plaintextLength(bucket));
  header(w, KeyringKind.PENDING, PENDING_CONTENT_VERSION);
  need(c.keyringId.length === KEYRING_ID_LENGTH, 'keyring id must be 16 bytes');
  w.bytes(c.keyringId);
  w.u8(relays.length);
  for (const u of relays) w.str(u, MAX_RELAY_URL_BYTES);
  w.u16(c.votes.length);
  for (const v of c.votes) {
    need(HEX64.test(v.collateralTxid) && HEX64.test(v.govHash), 'pending vote: hashes must be 64 lowercase hex chars');
    need(v.sig.length === 65, 'pending vote: signature must be 65 bytes');
    need(v.outcome >= 1 && v.outcome <= 3, 'pending vote: outcome must be yes, no or abstain');
    need(v.refs.length <= MAX_REFS_PER_VOTE, `pending vote: at most ${MAX_REFS_PER_VOTE} relays`);
    need(isTime(v.time) && isTime(v.releaseAt), 'pending vote: bad time');
    w.bytes(hexToBytes(v.collateralTxid));
    w.u32(v.collateralIndex);
    w.bytes(hexToBytes(v.govHash));
    w.u8(v.outcome);
    w.i64(v.time);
    w.bytes(v.sig);
    w.i64(v.releaseAt);
    w.u8(v.refs.length);
    for (const ref of v.refs) {
      need(/^[0-9a-f]{32}$/.test(ref.id), 'pending vote: relay id must be 32 hex chars');
      w.u8(relays.indexOf(ref.relay));
      w.bytes(hexToBytes(ref.id));
    }
    need(v.network === undefined || v.network in NETWORK_CODE, 'pending vote: unknown network');
    w.u8(v.network ? NETWORK_CODE[v.network] : 0);
  }
  return { bucket, plaintext: finish(w) };
}

export function decodePending(pt: Uint8Array, bucket: number): PendingContent {
  const r = open(pt, bucket, KeyringKind.PENDING, [KEYRING_FORMAT_VERSION, PENDING_CONTENT_VERSION]);
  const tagged = pt[0] === PENDING_CONTENT_VERSION;
  const keyringId = r.bytes(KEYRING_ID_LENGTH);
  const relays: string[] = [];
  const nr = r.u8();
  need(nr <= MAX_RELAYS, 'too many relays');
  for (let i = 0; i < nr; i++) relays.push(r.str(MAX_RELAY_URL_BYTES));
  const votes: PendingVote[] = [];
  const nv = r.u16();
  for (let i = 0; i < nv; i++) {
    const v: PendingVote = {
      collateralTxid: bytesToHex(r.bytes(32)),
      collateralIndex: r.u32(),
      govHash: bytesToHex(r.bytes(32)),
      outcome: r.u8(),
      time: r.i64(),
      sig: r.bytes(65),
      releaseAt: r.i64(),
      refs: [],
    };
    need(v.outcome >= 1 && v.outcome <= 3, 'pending vote: outcome must be yes, no or abstain');
    need(HEX64.test(v.collateralTxid) && HEX64.test(v.govHash), 'pending vote: bad hash');
    const n = r.u8();
    need(n <= MAX_REFS_PER_VOTE, 'too many relay refs');
    for (let j = 0; j < n; j++) {
      const idx = r.u8();
      need(idx < relays.length, 'relay index out of range');
      v.refs.push({ relay: relays[idx]!, id: bytesToHex(r.bytes(16)) });
    }
    if (tagged) {
      const code = r.u8();
      need(code === 0 || code in NETWORK_OF, 'pending vote: unknown network');
      if (code) v.network = NETWORK_OF[code]!;
    }
    votes.push(v);
  }
  done(r);
  const c = { keyringId, votes };
  need(pendingBucket(c) === bucket, 'pending bucket does not match its content');
  return c;
}
