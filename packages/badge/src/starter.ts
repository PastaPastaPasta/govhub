// Starter tokens: one free starter credit per masternode (proved with its VOTING key) or per proposal (proved with its PAYMENT
// address), redeemed at the faucet without the faucet or the issuer learning which masternode or proposal funded which identity.
//
// The issuer blind-signs (RSABSSA-SHA384-PSS-Randomized, the badge machinery) under a STARTER key: an `issuerKey` document of the
// `badge` contract owned by a starter-only identity (never a badge issuer's), one per epoch, under the badge epoch schedule and reader
// rules (acceptIssuerKey: created before keyDeadline = S(E+1) - margin, keyId = SHA256(spki), canonical RSA-2048/3072). The client blinds only against that
// PROVED document for an epoch it derives itself, so the issuer cannot hand one user a key of their own (key tagging). One rule is
// stricter than for badges (starterKeyUsable): the CURRENT epoch's key counts only if it was published before that epoch began,
// because clients fall back to the next epoch when the current one has no key, and a mid-epoch key would split the crowd by time.
//
// Token message (fixed width, 106 bytes), blind-signed; RSABSSA's randomized prepare prepends a fresh 32-byte msgPrefix:
//   "govhub-starter:v1" || net(1) || issuerId(32) || keyId(32) || epoch(u32 BE) || pubKeyHash(20)
// pubKeyHash is the hash160 of the one-time key the starter pays (the browser's funding key for the new identity). Binding it means a
// token seen in transit (a proxy, an extension) cannot be redeemed for anyone else's key. The faucet rebuilds the message from its own
// config (net, starter issuer id), the key it accepts for `epoch` (keyId = SHA256(spki), computed locally) and the pubKeyHash it pays.
// Its own copy of this format lives in dash-faucet-cf (src/starter.ts); the vector in test/starter.test.ts pins both.
//
// Token request, signed with Dash `signmessage` by the masternode's VOTING key or the proposal's PAYMENT address:
//   govhub-starter-req:v1|<net>|<starterIssuerId>|<epoch>|<keyIdHex>|<kind>|<subject>|<nonce>|<sha256(blindedMsg)>
//   kind = mn (subject = proTxHash) | proposal (subject = govHash), both 64 lowercase hex in RPC/display order.
// The domain differs from the badge request and from the claim message (`govhub-claim|...`), so a signature made for one can never
// be used as another, even though the same payment-address key signs both kinds. Like the claim, it binds the network.
import { bytesToId, concat, equalBytes, fromHex, idToBytes, need32, sha256, toHex } from './bytes.ts';
import { prepare, verify, type IssuerKey } from './client.ts';
import { epochOf, epochStart, type BadgeNetwork, type EpochParams } from './epoch.ts';
import { isNetwork, MSG_PREFIX_LEN, NET_BYTE } from './format.ts';

export const STARTER_TAG = new TextEncoder().encode('govhub-starter:v1');
export const STARTER_MESSAGE_LEN = STARTER_TAG.length + 1 + 32 + 32 + 4 + 20; // 106

export interface StarterFields {
  net: BadgeNetwork;
  /** the starter issuer identity (owner of the starter issuerKey documents) */
  issuerId: Uint8Array;
  keyId: Uint8Array;
  epoch: number;
  /** hash160 of the key the starter pays */
  pubKeyHash: Uint8Array;
}

function needEpoch(epoch: number): void {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > 0xffffffff) throw new Error('epoch must be u32');
}

export function buildStarterMessage(f: StarterFields): Uint8Array {
  if (!isNetwork(f.net)) throw new Error('unknown network');
  needEpoch(f.epoch);
  need32('issuerId', f.issuerId);
  need32('keyId', f.keyId);
  if (!(f.pubKeyHash instanceof Uint8Array) || f.pubKeyHash.length !== 20) throw new Error('pubKeyHash must be 20 bytes');
  const epoch = new Uint8Array(4);
  new DataView(epoch.buffer).setUint32(0, f.epoch, false);
  const msg = concat(STARTER_TAG, Uint8Array.of(NET_BYTE[f.net]), f.issuerId, f.keyId, epoch, f.pubKeyHash);
  if (msg.length !== STARTER_MESSAGE_LEN) throw new Error('internal: bad starter message length');
  return msg;
}

export interface PreparedStarter {
  message: Uint8Array;
  msgPrefix: Uint8Array;
  preparedMsg: Uint8Array;
}

/** The starter message for `key` (keyId from the key itself) with a fresh CSPRNG prefix. */
export function prepareStarter(key: IssuerKey, f: Omit<StarterFields, 'keyId'>): PreparedStarter {
  const message = buildStarterMessage({ ...f, keyId: key.keyId });
  return { message, ...prepare(message) };
}

/** Rebuilds the message and verifies the finalized token signature (length and s < n included). Never throws. */
export async function verifyStarterToken(key: IssuerKey, f: Omit<StarterFields, 'keyId'>, msgPrefix: Uint8Array, sig: Uint8Array): Promise<boolean> {
  try {
    if (msgPrefix.length !== MSG_PREFIX_LEN) return false;
    return await verify(key, sig, concat(msgPrefix, buildStarterMessage({ ...f, keyId: key.keyId })));
  } catch {
    return false;
  }
}

// ---- token request ------------------------------------------------------------------------------------------------------------

export const STARTER_REQUEST_TAG = 'govhub-starter-req:v1';
export type StarterKind = 'mn' | 'proposal';
export const isStarterKind = (v: unknown): v is StarterKind => v === 'mn' || v === 'proposal';
/** The longest legal request is about 420 chars. */
const MAX_REQUEST_CHARS = 512;
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^(?:[0-9a-f]{2}){16,64}$/;

export interface StarterRequest {
  net: BadgeNetwork;
  issuerId: Uint8Array;
  epoch: number;
  keyId: Uint8Array;
  kind: StarterKind;
  /** proTxHash (kind mn) or govHash (kind proposal), display (RPC) byte order */
  subject: Uint8Array;
  nonce: Uint8Array;
  blindedMsgSha256: Uint8Array;
}

export function buildStarterRequest(r: StarterRequest): string {
  if (!isNetwork(r.net)) throw new Error('unknown net');
  needEpoch(r.epoch);
  if (!isStarterKind(r.kind)) throw new Error('unknown kind');
  need32('issuerId', r.issuerId);
  need32('keyId', r.keyId);
  need32('subject', r.subject);
  need32('blindedMsgSha256', r.blindedMsgSha256);
  if (r.nonce.length < 16 || r.nonce.length > 64) throw new Error('nonce must be 16..64 bytes');
  return [STARTER_REQUEST_TAG, r.net, bytesToId(r.issuerId), String(r.epoch), toHex(r.keyId), r.kind, toHex(r.subject), toHex(r.nonce), toHex(r.blindedMsgSha256)].join('|');
}

/** Builds the request that binds SHA256(blindedMsg). */
export async function buildStarterRequestFor(r: Omit<StarterRequest, 'blindedMsgSha256'>, blindedMsg: Uint8Array): Promise<string> {
  return buildStarterRequest({ ...r, blindedMsgSha256: await sha256(blindedMsg) });
}

/** Accepts only the canonical form (the string is what gets signed). */
export function parseStarterRequest(s: string): StarterRequest {
  if (typeof s !== 'string' || s.length > MAX_REQUEST_CHARS) throw new Error('request too long');
  const parts = s.split('|');
  if (parts.length !== 9) throw new Error('expected 9 fields');
  const [tag, net, issuerB58, epochS, keyIdHex, kind, subjectHex, nonceHex, hashHex] = parts as [string, string, string, string, string, string, string, string, string];
  if (tag !== STARTER_REQUEST_TAG) throw new Error('bad tag');
  if (!isNetwork(net)) throw new Error('unknown net');
  if (!/^(0|[1-9][0-9]{0,9})$/.test(epochS)) throw new Error('bad epoch');
  const epoch = Number(epochS);
  if (epoch > 0xffffffff) throw new Error('epoch out of range');
  if (!isStarterKind(kind)) throw new Error('bad kind');
  for (const [name, v] of [['keyId', keyIdHex], ['subject', subjectHex], ['blindedMsgSha256', hashHex]] as const) if (!HEX64.test(v)) throw new Error(`bad ${name}`);
  if (!NONCE.test(nonceHex)) throw new Error('bad nonce');
  const req: StarterRequest = { net, issuerId: idToBytes(issuerB58), epoch, keyId: fromHex(keyIdHex), kind, subject: fromHex(subjectHex), nonce: fromHex(nonceHex), blindedMsgSha256: fromHex(hashHex) };
  if (buildStarterRequest(req) !== s) throw new Error('non-canonical request');
  return req;
}

export async function starterRequestBinds(req: StarterRequest, blindedMsg: Uint8Array): Promise<boolean> {
  return equalBytes(req.blindedMsgSha256, await sha256(blindedMsg));
}

// ---- epochs ---------------------------------------------------------------------------------------------------------------------

/**
 * The epochs a client asks for at Platform's core height `height`, in order: the current one, then the next (the issuer signs for
 * both). In the current epoch's last `boundaryMarginBlocks` only the next one, because the issuer's dashd tip may already be past it.
 * The client takes the first that has a valid proved key; both choices are the same for every user at that height.
 */
export function starterRequestEpochs(p: EpochParams, height: number): number[] {
  const e = epochOf(p, height);
  return height < epochStart(p, e + 1) - p.boundaryMarginBlocks ? [Math.max(1, e), e + 1] : [e + 1];
}

/**
 * Whether a starter key accepted by the reader rules (acceptIssuerKey: created before keyDeadline = S(E+1) - margin) may be used
 * for epoch `epoch` at core height `height`. The CURRENT epoch's key only if it was created strictly before S(current); the next
 * epoch's key under the normal rule. Why: clients fall back from the current epoch to the next when the current one has no key, so
 * a current-epoch key published mid-epoch would let the operator relabel requests by time (everyone before the publication asked
 * for E+1, everyone after for E), splitting the crowd a token hides in. With this rule the label depends only on the height.
 * Badges have no such fallback (the privacy mode fixes the epoch), so their late keys stay allowed.
 */
export function starterKeyUsable(p: EpochParams, height: number, epoch: number, keyCreatedAt: number): boolean {
  return epoch !== epochOf(p, height) || keyCreatedAt < epochStart(p, epoch);
}

/**
 * The epochs whose tokens the faucet redeems at core height `height`: the previous, current and next ones. A token for E is issued
 * while the issuer's tip is in [S(E-1), S(E+1)), so it stays redeemable for at least one whole epoch after it was issued (room for
 * the "redeem later" option).
 */
export function starterRedeemEpochs(p: EpochParams, height: number): number[] {
  const e = epochOf(p, height);
  return [e - 1, e, e + 1].filter((x) => x >= 1);
}

