// Token request (PLAN §8.3), signed with Dash `signmessage` by the MN VOTING key only:
//   govhub-badge-req:v2|<net>|<issuerId>|<epoch>|<keyIdHex>|<proTxHash>|<nonce>|<sha256(blindedMsg)>
//
// Encodings (fixed here; the parser accepts only this canonical form, because the string is what gets signed):
//   net        mainnet | testnet | devnet | regtest
//   issuerId   base58 identity id (32 bytes)
//   epoch      decimal u32, no sign, no leading zeros
//   keyIdHex, proTxHash, sha256(blindedMsg)   64 lowercase hex chars; proTxHash in RPC/display order
//   nonce      lowercase hex, 16..64 bytes (the issuer's challenge)
// Binding sha256(blindedMsg) means whoever sees a signed request (a CDN, an extension, a voting-key host) cannot use it to
// take the MN's slot with their own blinded message.

import { bytesToId, equalBytes, fromHex, idToBytes, need32, sha256, toHex } from './bytes.ts';
import type { BadgeNetwork } from './epoch.ts';
import { isNetwork } from './format.ts';

export const REQUEST_TAG = 'govhub-badge-req:v2';
/** The longest legal request is 407 chars; this also bounds the base58 work on hostile input. */
const MAX_REQUEST_CHARS = 512;

export interface TokenRequest {
  net: BadgeNetwork;
  issuerId: Uint8Array;
  epoch: number;
  keyId: Uint8Array;
  /** display (RPC) byte order */
  proTxHash: Uint8Array;
  nonce: Uint8Array;
  blindedMsgSha256: Uint8Array;
}

const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^(?:[0-9a-f]{2}){16,64}$/;

export function buildTokenRequest(r: TokenRequest): string {
  if (!isNetwork(r.net)) throw new Error('unknown net');
  if (!Number.isInteger(r.epoch) || r.epoch < 0 || r.epoch > 0xffffffff) throw new Error('epoch must be u32');
  need32('issuerId', r.issuerId);
  need32('keyId', r.keyId);
  need32('proTxHash', r.proTxHash);
  need32('blindedMsgSha256', r.blindedMsgSha256);
  if (r.nonce.length < 16 || r.nonce.length > 64) throw new Error('nonce must be 16..64 bytes');
  return [REQUEST_TAG, r.net, bytesToId(r.issuerId), String(r.epoch), toHex(r.keyId), toHex(r.proTxHash), toHex(r.nonce), toHex(r.blindedMsgSha256)].join('|');
}

/** Builds the request that binds SHA256(blindedMsg). */
export async function buildTokenRequestFor(r: Omit<TokenRequest, 'blindedMsgSha256'>, blindedMsg: Uint8Array): Promise<string> {
  return buildTokenRequest({ ...r, blindedMsgSha256: await sha256(blindedMsg) });
}

export function parseTokenRequest(s: string): TokenRequest {
  if (typeof s !== 'string' || s.length > MAX_REQUEST_CHARS) throw new Error('request too long');
  const parts = s.split('|');
  if (parts.length !== 8) throw new Error('expected 8 fields');
  const [tag, net, issuerB58, epochS, keyIdHex, proTxHex, nonceHex, hashHex] = parts as [string, string, string, string, string, string, string, string];
  if (tag !== REQUEST_TAG) throw new Error('bad tag');
  if (!isNetwork(net)) throw new Error('unknown net');
  if (!/^(0|[1-9][0-9]{0,9})$/.test(epochS)) throw new Error('bad epoch');
  const epoch = Number(epochS);
  if (epoch > 0xffffffff) throw new Error('epoch out of range');
  for (const [name, v] of [['keyId', keyIdHex], ['proTxHash', proTxHex], ['blindedMsgSha256', hashHex]] as const) {
    if (!HEX64.test(v)) throw new Error(`bad ${name}`);
  }
  if (!NONCE.test(nonceHex)) throw new Error('bad nonce');
  const req: TokenRequest = {
    net,
    issuerId: idToBytes(issuerB58),
    epoch,
    keyId: fromHex(keyIdHex),
    proTxHash: fromHex(proTxHex),
    nonce: fromHex(nonceHex),
    blindedMsgSha256: fromHex(hashHex),
  };
  if (buildTokenRequest(req) !== s) throw new Error('non-canonical request');
  return req;
}

/** Issuer side: does the request bind exactly this blinded message? */
export async function requestBindsBlindedMsg(req: TokenRequest, blindedMsg: Uint8Array): Promise<boolean> {
  return equalBytes(req.blindedMsgSha256, await sha256(blindedMsg));
}
