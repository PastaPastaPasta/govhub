// Test fakes for the starter (not shipped): Platform with the starter identity's issuerKey documents (read through the badge reader,
// so the reader rules pick the key), an honest RSA issuer and a faucet that rebuilds and verifies the token, behind the worker protocol.
import { constants, createPublicKey, generateKeyPairSync, privateDecrypt, randomBytes, type KeyObject } from 'node:crypto';
import { hash160 } from '@govhub/auth';
import { base64ToBytes, blind, bytesToBase64, bytesToId, EPOCH_PARAMS, epochStart, finalize, idToBytes, importIssuerKey, sha256, toHex, VARIANT, verifyStarterToken } from '@govhub/badge';
import type { DocQuery } from '@govhub/contracts-v1/queryLint';
import { decodeAddress, encodeWif, p2pkhAddress } from '@govhub/verify';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { BadgeWorkerCall, BadgeWorkerResponse, FaucetAnswer, IssuerAnswer, StarterRedeemBody } from '../badge/protocol.ts';
import { BadgeReader } from '../badge/reader.ts';
import { starterDepsFromReader, type StarterDeps } from './client.ts';

export const P = EPOCH_PARAMS.testnet;
export const E = 2743;
export const rnd = (n: number) => new Uint8Array(randomBytes(n));
export const starterId = bytesToId(rnd(32));
const contractId = bytesToId(rnd(32));

const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
export const spki = new Uint8Array(createPublicKey(rsa).export({ type: 'spki', format: 'der' }));
const rawSign = (k: KeyObject, m: Uint8Array) => new Uint8Array(privateDecrypt({ key: k, padding: constants.RSA_NO_PADDING }, m));
/** The honest issuer's blind signature over a base64 blinded message. */
export const issuerSign = (blindedB64: string): string => bytesToBase64(rawSign(rsa, base64ToBytes(blindedB64)));

export class FakePlatform {
  core = epochStart(P, E) + 10;
  keys = new Map<number, Record<string, unknown>>();
  revocations = new Map<number, Record<string, unknown>>();
  async query(q: DocQuery) {
    const w = Object.fromEntries(q.where.map(([k, , v]) => [k, v]));
    let docs: Record<string, unknown>[] = [];
    const mine = w.$ownerId === starterId;
    if (q.documentTypeName === 'issuerKey' && mine && this.keys.has(w.epoch as number)) docs = [this.keys.get(w.epoch as number)!];
    if (q.documentTypeName === 'issuerRevocation' && mine && this.revocations.has(w.epoch as number)) docs = [this.revocations.get(w.epoch as number)!];
    return { docs, coreHeight: this.core };
  }
  async addKey(epoch: number, o: { badKeyId?: boolean; createdAt?: number } = {}) {
    const keyId = o.badKeyId ? rnd(32) : await sha256(spki);
    this.keys.set(epoch, { $ownerId: starterId, $createdAtCoreBlockHeight: o.createdAt ?? epochStart(P, epoch - 1) - 5, epoch, spki: bytesToBase64(spki), keyId: bytesToBase64(keyId), variant: VARIANT });
  }
  async revoke(epoch: number) {
    this.revocations.set(epoch, { $ownerId: starterId, $createdAtCoreBlockHeight: this.core - 1, epoch, keyId: bytesToBase64(await sha256(spki)), effectiveCoreHeight: this.core - 1 });
  }
}

export interface Seen {
  calls: string[];
  token: Array<{ request: string; signature: string }>;
  redeem: StarterRedeemBody[];
}

/** An honest issuer and faucet behind the worker protocol; `answer` / `faucet` override their answers. */
export function fakeWorker(seen: Seen, o: { answer?: (req: string, sig: string, blinded: string) => IssuerAnswer; faucet?: (b: StarterRedeemBody) => FaucetAnswer; expiresAt?: number } = {}) {
  const paid = new Map<string, string>();
  return async (req: BadgeWorkerCall): Promise<BadgeWorkerResponse> => {
    const key = await importIssuerKey(spki);
    seen.calls.push(req.kind + ('api' in req && req.api ? `:${req.api}` : ''));
    switch (req.kind) {
      case 'blind': {
        const out = await blind(key, base64ToBytes(req.preparedMsg));
        return { id: 0, kind: 'blind', blindedMsg: bytesToBase64(out.blindedMsg), inv: bytesToBase64(out.inv) };
      }
      case 'challenge':
        return { id: 0, kind: 'challenge', nonce: toHex(rnd(40)), expiresAt: o.expiresAt ?? Math.floor(Date.now() / 1000) + 1800 };
      case 'token': {
        seen.token.push({ request: req.request, signature: req.signature });
        const answer = o.answer?.(req.request, req.signature, req.blindedMsg) ?? { ok: true, blindSig: bytesToBase64(rawSign(rsa, base64ToBytes(req.blindedMsg))) };
        return { id: 0, kind: 'token', answer };
      }
      case 'finalize': {
        const sig = await finalize(key, base64ToBytes(req.preparedMsg), base64ToBytes(req.blindSig), base64ToBytes(req.inv));
        return { id: 0, kind: 'finalize', sig: bytesToBase64(sig) };
      }
      case 'starterRedeem': {
        seen.redeem.push(req.body);
        if (o.faucet) return { id: 0, kind: 'starterRedeem', answer: o.faucet(req.body) };
        // the faucet rebuilds the message from its own config and the address it pays
        const pkh = decodeAddress(req.body.address, 'testnet')!.hash160;
        const ok = await verifyStarterToken(key, { net: 'testnet', issuerId: idToBytes(starterId), epoch: req.body.epoch, pubKeyHash: pkh }, base64ToBytes(req.body.msgPrefix), base64ToBytes(req.body.sig));
        if (!ok) return { id: 0, kind: 'starterRedeem', answer: { ok: false, status: 400, code: 'invalid-token', message: 'bad token' } };
        const replay = paid.has(req.body.sig);
        if (!replay) paid.set(req.body.sig, toHex(rnd(32)));
        return { id: 0, kind: 'starterRedeem', answer: { ok: true, txid: paid.get(req.body.sig)!, amountSats: 600_000, address: req.body.address, replay } };
      }
      case 'provenMasternodes':
        throw new Error('not used');
    }
  };
}

export function setup(o: Parameters<typeof fakeWorker>[1] = {}) {
  const platform = new FakePlatform();
  const reader = new BadgeReader({ net: 'testnet', contractId, issuers: [], query: (q) => platform.query(q) });
  const issuer = { identityId: starterId, url: 'https://issuer.test' };
  const seen: Seen = { calls: [], token: [], redeem: [] };
  const deps = starterDepsFromReader(reader, { network: 'testnet', issuer, faucetUrl: 'https://faucet.test', worker: fakeWorker(seen, o) as StarterDeps['worker'] });

  return { platform, deps, seen };
}

export const votingKey = () => {
  const priv = secp256k1.utils.randomSecretKey();
  return { priv, wif: encodeWif(priv, true, 'testnet'), address: p2pkhAddress(hash160(secp256k1.getPublicKey(priv, true)), 'testnet') };
};
export const PRO = 'ab'.repeat(32);
export const GOV = 'cd'.repeat(32);
export const pubKeyHash = () => rnd(20);
