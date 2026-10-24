// Value encodings at the Platform boundary (contracts README rule 6): identifiers are base58 strings, other byte
// arrays base64 strings, both in `where` clauses and in documents read back. The app works with hex for hashes
// (display order, as stored) and base58 for identifiers.
import { base58, base64 } from '@scure/base';
import { bytesToHex, concatBytes, hexToBytes, sha256d, utf8ToBytes } from '@govhub/verify';

export { base58, base64, bytesToHex, hexToBytes };

const B58_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A 32-byte Platform identifier in base58. */
export function isIdentifier(s: unknown): s is string {
  if (typeof s !== 'string' || !B58_ID.test(s)) return false;
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export function idToBytes(id: string): Uint8Array {
  const b = base58.decode(id);
  if (b.length !== 32) throw new Error(`identifier ${id.slice(0, 12)}… is not 32 bytes`);
  return b;
}

export const bytesToId = (b: Uint8Array): string => base58.encode(b);
export const hexToB64 = (hex: string): string => base64.encode(hexToBytes(hex));
export const b64ToHex = (b64: string): string => bytesToHex(base64.decode(b64));
/** The 32 bytes of an identifier as base64, for byteArray fields that hold an id (`reaction.target` of a comment). */
export const idToB64 = (id: string): string => base64.encode(idToBytes(id));
export const idToHex = (id: string): string => bytesToHex(idToBytes(id));

export function isHash64(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
}

/**
 * PV13 document id: sha256d(contractId ‖ ownerId ‖ typeName ‖ entropy) (spikes/sdk5 `mainnet-docid-probe.ts`). evo-sdk
 * rc.8 refuses a zero `$id` at PV13 and its `Document.generateId()` throws there, so the client derives it.
 */
export function pv13DocumentId(contractId: string, ownerId: string, type: string, entropy: Uint8Array): string {
  return bytesToId(sha256d(concatBytes(idToBytes(contractId), idToBytes(ownerId), utf8ToBytes(type), entropy)));
}
