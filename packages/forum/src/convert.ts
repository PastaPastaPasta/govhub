// Document JSON (evo-sdk `Document.toJSON()`: byte arrays base64, identifiers base58, integers numbers) -> domain.
// Every converter validates what it reads and throws on a malformed document; readers skip those (a node cannot
// forge proven documents, but the contract admits values the UI must not trust blindly, e.g. a 33-byte "id").
import { base58, base64, bytesToHex, bytesToId, isIdentifier } from './encoding.ts';
import type { Block, BlockSubs, Claim, ClaimAttestation, Comment, Profile, ProposalPost, Reaction } from './types.ts';

export type RawDoc = Record<string, unknown>;

const fail = (k: string): never => {
  throw new Error(`document field ${k} missing or malformed`);
};
const str = (d: RawDoc, k: string): string => (typeof d[k] === 'string' ? (d[k] as string) : fail(k));
const optStr = (d: RawDoc, k: string): string | undefined => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
export function num(d: RawDoc, k: string): number {
  const v = d[k];
  const n = typeof v === 'number' ? v : typeof v === 'bigint' || (typeof v === 'string' && /^-?\d+$/.test(v)) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : fail(k);
}
const optNum = (d: RawDoc, k: string): number | undefined => (d[k] === undefined || d[k] === null ? undefined : num(d, k));
const id = (d: RawDoc, k: string): string => {
  const v = d[k];
  if (isIdentifier(v)) return v;
  // Some SDK paths render identifiers as raw bytes or base64; normalise to base58.
  if (v instanceof Uint8Array && v.length === 32) return bytesToId(v);
  return fail(k);
};
const optId = (d: RawDoc, k: string): string | undefined => (d[k] === undefined || d[k] === null ? undefined : id(d, k));
const bytes = (d: RawDoc, k: string): Uint8Array => {
  const v = d[k];
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') {
    try {
      return base64.decode(v);
    } catch {
      /* fall through */
    }
  }
  return fail(k);
};
const hash32 = (d: RawDoc, k: string): string => {
  const b = bytes(d, k);
  return b.length === 32 ? bytesToHex(b) : fail(k);
};
const revision = (d: RawDoc): number => optNum(d, '$revision') ?? 1;

export function toComment(d: RawDoc): Comment {
  const parentId = optId(d, 'parentId');
  return {
    id: id(d, '$id'),
    ownerId: id(d, '$ownerId'),
    govHash: hash32(d, 'govHash'),
    ...(parentId ? { parentId } : {}),
    body: str(d, 'body'),
    fmt: num(d, 'fmt'),
    createdAt: num(d, '$createdAt'),
  };
}

export function toReaction(d: RawDoc): Reaction {
  const value = num(d, 'value');
  if (value !== 1 && value !== -1) fail('value');
  const createdAt = num(d, '$createdAt');
  return {
    id: id(d, '$id'),
    ownerId: id(d, '$ownerId'),
    target: hash32(d, 'target'),
    kind: num(d, 'kind'),
    value: value as 1 | -1,
    revision: revision(d),
    createdAt,
    updatedAt: optNum(d, '$updatedAt') ?? createdAt,
  };
}

export function toProfile(d: RawDoc): Profile {
  const about = optStr(d, 'about');
  const avatarUrl = optStr(d, 'avatarUrl');
  return { id: id(d, '$id'), ownerId: id(d, '$ownerId'), revision: revision(d), displayName: str(d, 'displayName'), ...(about ? { about } : {}), ...(avatarUrl ? { avatarUrl } : {}) };
}

export function toClaim(d: RawDoc): Claim {
  const sig = bytes(d, 'sig');
  if (sig.length !== 65) fail('sig');
  return { id: id(d, '$id'), ownerId: id(d, '$ownerId'), govHash: hash32(d, 'govHash'), method: num(d, 'method'), sig, createdAt: num(d, '$createdAt') };
}

export function toAttestation(d: RawDoc): ClaimAttestation {
  const note = optStr(d, 'note');
  return { id: id(d, '$id'), ownerId: id(d, '$ownerId'), govHash: hash32(d, 'govHash'), identityId: id(d, 'identityId'), method: num(d, 'method'), ...(note ? { note } : {}) };
}

export function toPost(d: RawDoc): ProposalPost {
  const chunks = [bytes(d, 'b0')];
  for (const k of ['b1', 'b2']) if (d[k] !== undefined && d[k] !== null) chunks.push(bytes(d, k));
  const links = optStr(d, 'links');
  return { id: id(d, '$id'), ownerId: id(d, '$ownerId'), revision: revision(d), govHash: hash32(d, 'govHash'), title: str(d, 'title'), chunks, ...(links ? { links } : {}) };
}

export function toBlock(d: RawDoc): Block {
  const reason = optStr(d, 'reason');
  const createdAt = optNum(d, '$createdAt');
  return { id: id(d, '$id'), ownerId: id(d, '$ownerId'), target: id(d, 'target'), kind: num(d, 'kind'), ...(reason ? { reason } : {}), ...(createdAt !== undefined ? { createdAt } : {}) };
}

/** `blockSubs.lists` packs N × 32-byte identity ids. */
export function unpackLists(packed: Uint8Array): string[] {
  if (packed.length % 32 !== 0) throw new Error('blockSubs.lists is not a multiple of 32 bytes');
  const out: string[] = [];
  for (let i = 0; i < packed.length; i += 32) out.push(base58.encode(packed.subarray(i, i + 32)));
  return [...new Set(out)];
}

export function packLists(ids: readonly string[]): Uint8Array {
  const u = [...new Set(ids)];
  const out = new Uint8Array(u.length * 32);
  u.forEach((x, i) => {
    const b = base58.decode(x);
    if (b.length !== 32) throw new Error(`list id ${x} is not 32 bytes`);
    out.set(b, i * 32);
  });
  return out;
}

export function toBlockSubs(d: RawDoc): BlockSubs {
  const lists = d.lists === undefined || d.lists === null ? [] : unpackLists(bytes(d, 'lists'));
  return { id: id(d, '$id'), revision: revision(d), lists, defaultOff: d.defaultOff === true };
}

/** Converts what converts, drops (and counts) the rest. */
export function convertAll<T>(docs: readonly RawDoc[], fn: (d: RawDoc) => T): T[] {
  const out: T[] = [];
  for (const d of docs) {
    try {
      out.push(fn(d));
    } catch {
      /* malformed: skipped */
    }
  }
  return out;
}
