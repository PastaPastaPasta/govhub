// Packed tally set: every active proposal's tally in one `gov.talliesSet` document (packages/contracts-v1/README.md, "talliesSet").
// PV13 allows one document per state transition, so one replace of this document costs what one per-proposal `tally` replace did.
//
// Format, version 1 (big-endian, fixed width, so a replace with the same proposals keeps the document size and pays no storage):
//   stream  = version u8 (= 1) | count u16 | count x entry
//   entry   = govHash[32] | voteSetHash[32] | yesWeighted u32 | noWeighted u32 | abstainWeighted u32
//             | yesCount u32 | noCount u32 | abstainCount u32 | rank u16 | flags u8 (bit 0 = inNextBudget) | margin i32   (95 bytes)
// Entries are sorted by govHash, strictly ascending (no duplicates). The stream is split into the byteArray fields b0, b1, b2 of
// at most 5,120 bytes each, every field but the last full. Hashes are in RPC/display order, like every other gov document.
// The document's `asOfHeight` applies to every entry; it is a document field, not part of the stream.
import { bytesToHex, concatBytes, hexToBytes } from './bytes.ts';

export const TALLY_SET_VERSION = 1;
export const TALLY_SET_HEADER_BYTES = 3;
export const TALLY_SET_ENTRY_BYTES = 95;
/** Platform's per-field value cap. */
export const TALLY_SET_FIELD_BYTES = 5120;
export const TALLY_SET_FIELDS = ['b0', 'b1', 'b2'] as const;
/** Pages a reader asks for (one query) and a writer may fill: 8 x 161 = 1,288 proposals, far above the ~30 active on mainnet. */
export const TALLY_SET_MAX_PAGES = 8;
/** Entries that fit in one document (3 fields): 161. More go to the next page document. */
export const TALLY_SET_MAX_ENTRIES = Math.floor((TALLY_SET_FIELD_BYTES * TALLY_SET_FIELDS.length - TALLY_SET_HEADER_BYTES) / TALLY_SET_ENTRY_BYTES);

/** One proposal's tally, the `gov.tally` fields without `asOfHeight`. Hashes are lowercase display hex. */
export interface TallySetEntry {
  govHash: string;
  yesWeighted: number;
  noWeighted: number;
  abstainWeighted: number;
  yesCount: number;
  noCount: number;
  abstainCount: number;
  voteSetHash: string;
  rank: number;
  inNextBudget: boolean;
  margin: number;
}

const U32 = 0xffffffff;
const HASH = /^[0-9a-f]{64}$/;
/** The six u32 counters of an entry, in stream order. */
const COUNTERS = ['yesWeighted', 'noWeighted', 'abstainWeighted', 'yesCount', 'noCount', 'abstainCount'] as const;
type TallySetFields = Partial<Record<(typeof TALLY_SET_FIELDS)[number], Uint8Array>>;

function int(name: string, v: number, min: number, max: number): number {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error(`tally set: ${name} ${v} outside ${min}..${max}`);
  return v;
}
function hash(name: string, v: string): Uint8Array {
  const h = v.toLowerCase();
  if (!HASH.test(h)) throw new Error(`tally set: ${name} is not 64 hex chars`);
  return hexToBytes(h);
}
function sortedByGovHash<T extends Pick<TallySetEntry, 'govHash'>>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => (a.govHash.toLowerCase() < b.govHash.toLowerCase() ? -1 : 1));
}

/** The packed stream of up to TALLY_SET_MAX_ENTRIES entries (sorted here; duplicates are an error). */
export function encodeTallySetStream(entries: readonly TallySetEntry[]): Uint8Array {
  if (entries.length > TALLY_SET_MAX_ENTRIES) throw new Error(`tally set: ${entries.length} entries, at most ${TALLY_SET_MAX_ENTRIES} fit in one document`);
  const sorted = sortedByGovHash(entries);
  const out = new Uint8Array(TALLY_SET_HEADER_BYTES + sorted.length * TALLY_SET_ENTRY_BYTES);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, TALLY_SET_VERSION);
  dv.setUint16(1, sorted.length);
  let o = TALLY_SET_HEADER_BYTES;
  let prev = '';
  for (const e of sorted) {
    const gh = e.govHash.toLowerCase();
    if (gh === prev) throw new Error(`tally set: duplicate entry ${gh}`);
    prev = gh;
    out.set(hash('govHash', gh), o);
    out.set(hash('voteSetHash', e.voteSetHash), o + 32);
    COUNTERS.forEach((name, i) => dv.setUint32(o + 64 + 4 * i, int(name, e[name], 0, U32)));
    dv.setUint16(o + 88, int('rank', e.rank, 0, 0xffff));
    dv.setUint8(o + 90, e.inNextBudget ? 1 : 0);
    dv.setInt32(o + 91, int('margin', e.margin, -0x80000000, 0x7fffffff));
    o += TALLY_SET_ENTRY_BYTES;
  }
  return out;
}

/** Splits a stream into the document fields (b0, b1, b2), each at most 5,120 bytes. */
export function splitTallySetStream(stream: Uint8Array): Uint8Array[] {
  const fields: Uint8Array[] = [];
  for (let i = 0; i < stream.length; i += TALLY_SET_FIELD_BYTES) fields.push(stream.slice(i, i + TALLY_SET_FIELD_BYTES));
  if (fields.length > TALLY_SET_FIELDS.length) throw new Error('tally set: stream longer than 3 fields');
  return fields;
}

/** The `b0`..`b2` properties of a `talliesSet` document for these entries. */
export function tallySetFields(entries: readonly TallySetEntry[]): TallySetFields {
  const out: TallySetFields = {};
  splitTallySetStream(encodeTallySetStream(entries)).forEach((f, i) => (out[TALLY_SET_FIELDS[i]!] = f));
  return out;
}

/**
 * Decodes the fields of one `talliesSet` document (b0, then b1 and b2 when present; `undefined` for an absent field). Strict: an
 * unknown version, a length that does not match the count, a non-canonical split, unsorted or duplicate entries or unknown flag
 * bits all throw, so a reader never half-reads a set.
 */
export function decodeTallySet(fields: ReadonlyArray<Uint8Array | undefined>): TallySetEntry[] {
  const present = [...fields];
  while (present.length && present.at(-1) === undefined) present.pop();
  if (present.length === 0 || present.length > TALLY_SET_FIELDS.length) throw new Error('tally set: needs b0 and at most 3 fields');
  present.forEach((f, i) => {
    if (!f || f.length === 0) throw new Error(`tally set: ${TALLY_SET_FIELDS[i]} missing before a later field`);
    if (f.length > TALLY_SET_FIELD_BYTES) throw new Error(`tally set: ${TALLY_SET_FIELDS[i]} longer than ${TALLY_SET_FIELD_BYTES} bytes`);
    if (i < present.length - 1 && f.length !== TALLY_SET_FIELD_BYTES) throw new Error(`tally set: ${TALLY_SET_FIELDS[i]} is not full but a later field follows`);
  });
  const stream = concatBytes(...(present as Uint8Array[]));
  if (stream.length < TALLY_SET_HEADER_BYTES) throw new Error('tally set: shorter than its header');
  const dv = new DataView(stream.buffer);
  const version = dv.getUint8(0);
  if (version !== TALLY_SET_VERSION) throw new Error(`tally set: unknown format version ${version}`);
  const count = dv.getUint16(1);
  if (stream.length !== TALLY_SET_HEADER_BYTES + count * TALLY_SET_ENTRY_BYTES) throw new Error(`tally set: ${stream.length} bytes for ${count} entries`);
  const out: TallySetEntry[] = [];
  let prev = '';
  for (let i = 0, o = TALLY_SET_HEADER_BYTES; i < count; i++, o += TALLY_SET_ENTRY_BYTES) {
    const govHash = bytesToHex(stream.subarray(o, o + 32));
    if (govHash <= prev) throw new Error('tally set: entries not strictly sorted by govHash');
    prev = govHash;
    const flags = dv.getUint8(o + 90);
    if (flags & ~1) throw new Error(`tally set: unknown flag bits ${flags}`);
    const u = (k: number) => dv.getUint32(o + 64 + 4 * k);
    out.push({
      govHash,
      voteSetHash: bytesToHex(stream.subarray(o + 32, o + 64)),
      yesWeighted: u(0),
      noWeighted: u(1),
      abstainWeighted: u(2),
      yesCount: u(3),
      noCount: u(4),
      abstainCount: u(5),
      rank: dv.getUint16(o + 88),
      inNextBudget: (flags & 1) === 1,
      margin: dv.getInt32(o + 91),
    });
  }
  return out;
}

/** Entries split into page documents of at most TALLY_SET_MAX_ENTRIES, in govHash order. Always at least one (maybe empty) page. */
export function paginateTallySet<T extends Pick<TallySetEntry, 'govHash'>>(entries: readonly T[]): T[][] {
  const sorted = sortedByGovHash(entries);
  const pages: T[][] = [];
  for (let i = 0; i < sorted.length; i += TALLY_SET_MAX_ENTRIES) pages.push(sorted.slice(i, i + TALLY_SET_MAX_ENTRIES));
  return pages.length ? pages : [[]];
}
