// Badge message format (PLAN §8.3):
//   "govhub-badge:v2" || net(1) || contractId(32) || issuerId(32) || keyId(32) || epoch(u32 BE) || ownerId(32)
// The library's PrepareRandomize then prepends a fresh 32-byte msgPrefix:
//   preparedMsg = msgPrefix(32) || badgeMessage(148)
// keyId = SHA256(SPKI DER of the issuer public key).

import { concat, equalBytes, sha256 } from './bytes.js';

export const BADGE_TAG = new TextEncoder().encode('govhub-badge:v2');
export const MSG_PREFIX_LEN = 32;
export const BADGE_MESSAGE_LEN = BADGE_TAG.length + 1 + 32 + 32 + 32 + 4 + 32; // 148

/** Network byte. PLAN does not assign values; this spike fixes them (see README FINDINGS). */
export const NET = { mainnet: 1, testnet: 2, devnet: 3, regtest: 4 } as const;
export type NetName = keyof typeof NET;

export interface BadgeFields {
  net: number; // 1 byte
  contractId: Uint8Array; // 32
  issuerId: Uint8Array; // 32
  keyId: Uint8Array; // 32
  epoch: number; // u32
  ownerId: Uint8Array; // 32
}

function need32(name: string, b: Uint8Array): void {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error(`${name} must be 32 bytes`);
}

export function buildBadgeMessage(f: BadgeFields): Uint8Array {
  if (!Number.isInteger(f.net) || f.net < 0 || f.net > 255) throw new Error('net must be a byte');
  if (!Number.isInteger(f.epoch) || f.epoch < 0 || f.epoch > 0xffffffff) throw new Error('epoch must be u32');
  need32('contractId', f.contractId);
  need32('issuerId', f.issuerId);
  need32('keyId', f.keyId);
  need32('ownerId', f.ownerId);
  const epoch = new Uint8Array(4);
  new DataView(epoch.buffer).setUint32(0, f.epoch, false);
  const msg = concat(BADGE_TAG, Uint8Array.of(f.net), f.contractId, f.issuerId, f.keyId, epoch, f.ownerId);
  if (msg.length !== BADGE_MESSAGE_LEN) throw new Error('internal: bad badge message length');
  return msg;
}

export function parseBadgeMessage(msg: Uint8Array): BadgeFields {
  if (msg.length !== BADGE_MESSAGE_LEN) throw new Error('bad badge message length');
  if (!equalBytes(msg.subarray(0, BADGE_TAG.length), BADGE_TAG)) throw new Error('bad badge tag');
  let o = BADGE_TAG.length;
  const net = msg[o++]!;
  const take = (n: number) => {
    const s = msg.slice(o, o + n);
    o += n;
    return s;
  };
  const contractId = take(32);
  const issuerId = take(32);
  const keyId = take(32);
  const epoch = new DataView(msg.buffer, msg.byteOffset + o, 4).getUint32(0, false);
  o += 4;
  const ownerId = take(32);
  return { net, contractId, issuerId, keyId, epoch, ownerId };
}

/** keyId = SHA256(SPKI DER). */
export function deriveKeyId(spki: Uint8Array): Promise<Uint8Array> {
  return sha256(spki);
}
