// Badge message (PLAN §8.3), fixed-width binary:
//   "govhub-badge:v2" || net(1) || contractId(32) || issuerId(32) || keyId(32) || epoch(u32 BE) || ownerId(32)   = 148 B
// RSABSSA's randomized prepare then prepends a fresh 32-byte msgPrefix: preparedMsg = msgPrefix(32) || message (180 B).
// keyId = SHA256(SPKI DER of the issuer public key, rsaEncryption OID, canonical).
//
// The issuer signs blind and never sees this message, so net/contractId/issuerId/epoch are NOT authenticated by the
// signature. Readers rebuild the message from the proved issuerKey document and their own config, never from the badge.

import type { BadgeNetwork } from './epoch.ts';
import { concat, equalBytes, sha256 } from './bytes.ts';

export const BADGE_TAG = new TextEncoder().encode('govhub-badge:v2');
export const MSG_PREFIX_LEN = 32;
export const BADGE_MESSAGE_LEN = BADGE_TAG.length + 1 + 32 + 32 + 32 + 4 + 32; // 148

/** Network byte in the badge message, and the network name in the token request. */
export const NET_BYTE: Readonly<Record<BadgeNetwork, number>> = Object.freeze({ mainnet: 1, testnet: 2, devnet: 3, regtest: 4 });
export const NETWORKS = Object.keys(NET_BYTE) as readonly BadgeNetwork[];
export const isNetwork = (v: unknown): v is BadgeNetwork => typeof v === 'string' && Object.hasOwn(NET_BYTE, v);

export interface BadgeFields {
  net: BadgeNetwork;
  /** the `badge` contract id (v1 and v2 contracts therefore produce distinct badges) */
  contractId: Uint8Array;
  issuerId: Uint8Array;
  keyId: Uint8Array;
  epoch: number;
  ownerId: Uint8Array;
}

function need32(name: string, b: Uint8Array): void {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error(`${name} must be 32 bytes`);
}

export function buildBadgeMessage(f: BadgeFields): Uint8Array {
  if (!isNetwork(f.net)) throw new Error('unknown network');
  if (!Number.isInteger(f.epoch) || f.epoch < 0 || f.epoch > 0xffffffff) throw new Error('epoch must be u32');
  need32('contractId', f.contractId);
  need32('issuerId', f.issuerId);
  need32('keyId', f.keyId);
  need32('ownerId', f.ownerId);
  const epoch = new Uint8Array(4);
  new DataView(epoch.buffer).setUint32(0, f.epoch, false);
  const msg = concat(BADGE_TAG, Uint8Array.of(NET_BYTE[f.net]), f.contractId, f.issuerId, f.keyId, epoch, f.ownerId);
  if (msg.length !== BADGE_MESSAGE_LEN) throw new Error('internal: bad badge message length');
  return msg;
}

export function parseBadgeMessage(msg: Uint8Array): BadgeFields {
  if (msg.length !== BADGE_MESSAGE_LEN) throw new Error('bad badge message length');
  if (!equalBytes(msg.subarray(0, BADGE_TAG.length), BADGE_TAG)) throw new Error('bad badge tag');
  let o = BADGE_TAG.length;
  const netByte = msg[o++]!;
  const net = NETWORKS.find((n) => NET_BYTE[n] === netByte);
  if (!net) throw new Error('unknown network byte');
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
export const deriveKeyId = (spki: Uint8Array): Promise<Uint8Array> => sha256(spki);
