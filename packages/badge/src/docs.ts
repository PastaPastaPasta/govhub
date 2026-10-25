// `badge` contract documents (packages/contracts-v1/badge.json): field builders for writers and parsers for the JSON that
// evo-sdk's Document.toJSON() returns (byte arrays as base64, identifiers as base58, integers as numbers or strings).
// Parsers throw on anything malformed; a reader treats a throw as "no valid document".

import { base64ToBytes, idToBytes } from './bytes.ts';
import { VARIANT } from './client.ts';
import type { IssuerKeyDoc, IssuerRevocationDoc, MnBadgeDoc } from './reader.ts';

export const BADGE_TYPES = { issuerKey: 'issuerKey', issuerRevocation: 'issuerRevocation', issuerReport: 'issuerReport', mnBadge: 'mnBadge' } as const;

type Json = Record<string, unknown>;

function bytes(d: Json, k: string, min: number, max = min): Uint8Array {
  const v = d[k];
  let b: Uint8Array;
  if (v instanceof Uint8Array) b = Uint8Array.from(v);
  else if (Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) b = Uint8Array.from(v as number[]);
  else if (typeof v === 'string') b = base64ToBytes(v);
  else throw new Error(`document field ${k} missing`);
  if (b.length < min || b.length > max) throw new Error(`document field ${k} has bad length`);
  return b;
}
function ident(d: Json, k: string): Uint8Array {
  const v = d[k];
  if (typeof v === 'string') return idToBytes(v);
  if (v instanceof Uint8Array && v.length === 32) return Uint8Array.from(v);
  if (v && typeof v === 'object' && typeof (v as { toBytes?: unknown }).toBytes === 'function') return ident({ x: (v as { toBytes(): Uint8Array }).toBytes() }, 'x');
  throw new Error(`document field ${k} missing`);
}
function u32(d: Json, k: string): number {
  const v = d[k];
  const n = typeof v === 'number' ? v : typeof v === 'bigint' || (typeof v === 'string' && /^\d+$/.test(v)) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`document field ${k} missing or out of range`);
  return n;
}

export function parseIssuerKeyDoc(d: Json): IssuerKeyDoc {
  return {
    ownerId: ident(d, '$ownerId'),
    epoch: u32(d, 'epoch'),
    spki: bytes(d, 'spki', 294, 422),
    keyId: bytes(d, 'keyId', 32),
    variant: typeof d.variant === 'string' ? d.variant : '',
    createdAtCoreBlockHeight: u32(d, '$createdAtCoreBlockHeight'),
  };
}

export function parseIssuerRevocationDoc(d: Json): IssuerRevocationDoc {
  return {
    ownerId: ident(d, '$ownerId'),
    epoch: u32(d, 'epoch'),
    keyId: bytes(d, 'keyId', 32),
    effectiveCoreHeight: u32(d, 'effectiveCoreHeight'),
    createdAtCoreBlockHeight: u32(d, '$createdAtCoreBlockHeight'),
  };
}

export function parseMnBadgeDoc(d: Json): MnBadgeDoc {
  return {
    ownerId: ident(d, '$ownerId'),
    issuerId: ident(d, 'issuerId'),
    epoch: u32(d, 'epoch'),
    keyId: bytes(d, 'keyId', 32),
    msgPrefix: bytes(d, 'msgPrefix', 32),
    sig: bytes(d, 'sig', 256, 384),
    createdAtCoreBlockHeight: u32(d, '$createdAtCoreBlockHeight'),
  };
}

export interface IssuerReport {
  ownerId: Uint8Array;
  epoch: number;
  tokensIssued: number;
  createdAtCoreBlockHeight: number;
}
export function parseIssuerReportDoc(d: Json): IssuerReport {
  return { ownerId: ident(d, '$ownerId'), epoch: u32(d, 'epoch'), tokensIssued: u32(d, 'tokensIssued'), createdAtCoreBlockHeight: u32(d, '$createdAtCoreBlockHeight') };
}

// ---- writers: document data (user fields only; Drive sets $createdAtCoreBlockHeight from the block) -----------------------

export const issuerKeyData = (o: { epoch: number; spki: Uint8Array; keyId: Uint8Array }) => ({ epoch: o.epoch, spki: o.spki, keyId: o.keyId, variant: VARIANT });

export const mnBadgeData = (o: { issuerId: Uint8Array; epoch: number; keyId: Uint8Array; msgPrefix: Uint8Array; sig: Uint8Array }) => ({
  issuerId: o.issuerId,
  epoch: o.epoch,
  keyId: o.keyId,
  msgPrefix: o.msgPrefix,
  sig: o.sig,
});

export const issuerReportData = (o: { epoch: number; tokensIssued: number }) => ({ epoch: o.epoch, tokensIssued: o.tokensIssued });

export const issuerRevocationData = (o: { epoch: number; keyId: Uint8Array; effectiveCoreHeight: number }) => ({ epoch: o.epoch, keyId: o.keyId, effectiveCoreHeight: o.effectiveCoreHeight });
