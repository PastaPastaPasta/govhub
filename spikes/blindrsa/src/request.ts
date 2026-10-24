// Token-request message (PLAN §8.3). String only; signing with Dash `signmessage` happens elsewhere.
//   govhub-badge-req:v2|<net>|<issuerId>|<epoch>|<keyIdHex>|<proTxHash>|<nonce>|<sha256(blindedMsg)>
//
// Canonical encodings chosen by this spike (PLAN leaves them open, see README FINDINGS):
//   net        one of mainnet|testnet|devnet|regtest
//   issuerId   Dash identity id string = base58 of the 32 raw bytes
//   epoch      decimal u32, no leading zeros, no sign
//   keyIdHex, proTxHash, sha256(blindedMsg)   64 lowercase hex chars
//   nonce      lowercase hex, 16..64 bytes (the issuer's HMAC challenge)
// The parser is strict and requires parse -> build to be the identity, because the string is what gets signed.

import { equalBytes, fromHex, sha256, toHex } from './bytes.js';
import { NET, type NetName } from './format.js';

const NET_NAMES: readonly string[] = Object.keys(NET);
const MAX_REQUEST_CHARS = 512; // max legal length is 407; bounds the bigint base58 work

export const REQUEST_TAG = 'govhub-badge-req:v2';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)]! + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = '1' + s;
  }
  return s;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('invalid base58');
    n = n * 58n + BigInt(i);
  }
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = fromHex(hex);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

export interface TokenRequest {
  net: NetName;
  issuerId: Uint8Array; // 32
  epoch: number;
  keyId: Uint8Array; // 32
  proTxHash: Uint8Array; // 32
  nonce: Uint8Array; // 16..64
  blindedMsgSha256: Uint8Array; // 32
}

const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^(?:[0-9a-f]{2}){16,64}$/;

function need32(name: string, b: Uint8Array) {
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes`);
}

export function buildTokenRequest(r: TokenRequest): string {
  if (!NET_NAMES.includes(r.net)) throw new Error('unknown net');
  if (!Number.isInteger(r.epoch) || r.epoch < 0 || r.epoch > 0xffffffff) throw new Error('epoch must be u32');
  need32('issuerId', r.issuerId);
  need32('keyId', r.keyId);
  need32('proTxHash', r.proTxHash);
  need32('blindedMsgSha256', r.blindedMsgSha256);
  if (r.nonce.length < 16 || r.nonce.length > 64) throw new Error('nonce must be 16..64 bytes');
  return [
    REQUEST_TAG,
    r.net,
    base58Encode(r.issuerId),
    String(r.epoch),
    toHex(r.keyId),
    toHex(r.proTxHash),
    toHex(r.nonce),
    toHex(r.blindedMsgSha256),
  ].join('|');
}

/** Convenience: build the request binding SHA256(blindedMsg). */
export async function buildTokenRequestFor(
  r: Omit<TokenRequest, 'blindedMsgSha256'>,
  blindedMsg: Uint8Array,
): Promise<string> {
  return buildTokenRequest({ ...r, blindedMsgSha256: await sha256(blindedMsg) });
}

export function parseTokenRequest(s: string): TokenRequest {
  if (s.length > MAX_REQUEST_CHARS) throw new Error('request too long');
  const parts = s.split('|');
  if (parts.length !== 8) throw new Error('expected 8 fields');
  const [tag, net, issuerB58, epochS, keyIdHex, proTxHex, nonceHex, hashHex] = parts as [
    string, string, string, string, string, string, string, string,
  ];
  if (tag !== REQUEST_TAG) throw new Error('bad tag');
  if (!NET_NAMES.includes(net)) throw new Error('unknown net');
  if (issuerB58.length < 1 || issuerB58.length > 44) throw new Error('bad issuerId length');
  if (!/^(0|[1-9][0-9]{0,9})$/.test(epochS)) throw new Error('bad epoch');
  const epoch = Number(epochS);
  if (epoch > 0xffffffff) throw new Error('epoch out of range');
  for (const [name, v] of [['keyId', keyIdHex], ['proTxHash', proTxHex], ['blindedMsgSha256', hashHex]] as const) {
    if (!HEX64.test(v)) throw new Error(`bad ${name}`);
  }
  if (!NONCE.test(nonceHex)) throw new Error('bad nonce');
  const req: TokenRequest = {
    net: net as NetName,
    issuerId: base58Decode(issuerB58),
    epoch,
    keyId: fromHex(keyIdHex),
    proTxHash: fromHex(proTxHex),
    nonce: fromHex(nonceHex),
    blindedMsgSha256: fromHex(hashHex),
  };
  if (req.issuerId.length !== 32) throw new Error('issuerId must decode to 32 bytes');
  if (buildTokenRequest(req) !== s) throw new Error('non-canonical request');
  return req;
}

/** Issuer-side: does the request bind exactly this blindedMsg? */
export async function requestBindsBlindedMsg(req: TokenRequest, blindedMsg: Uint8Array): Promise<boolean> {
  return equalBytes(req.blindedMsgSha256, await sha256(blindedMsg));
}
