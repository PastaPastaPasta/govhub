// Reader rules (PLAN §8.6). Pure: the caller does the proved Platform queries (B1 issuerKey, B2 issuerRevocation, B4 mnBadge,
// all with proofs, for issuers on its trust list only) and passes the documents and the current core height in.
//
//  key:   the unique issuerKey for (issuer, E) - $ownerId = the trusted issuer, epoch = E - created before S(E-1),
//         variant RSABSSA-SHA384-PSS-Randomized, keyId = SHA256(spki), spki a canonical RSA-2048/3072 rsaEncryption key.
//         An issuerRevocation for (issuer, E) revokes from its effectiveCoreHeight on.
//  badge: issuerId/epoch/keyId equal to the key's; $createdAtCoreBlockHeight in [S(E), S(E+1)+W] and before any revocation;
//         the current height in the same window; sig of modulus length, s < n, RSABSSA-valid over the message rebuilt from
//         the key binding (issuer and epoch from the issuerKey document, net and contract from config) and $ownerId.

import { equalBytes } from './bytes.ts';
import { bindIssuerKey, importIssuerKey, VARIANT, verifyBadgeSignature, type BoundIssuerKey, type ImportOptions } from './client.ts';
import { EPOCH_PARAMS, inDisplayWindow, keyDeadline, type BadgeNetwork, type EpochParams } from './epoch.ts';
import { deriveKeyId, MSG_PREFIX_LEN } from './format.ts';

export interface IssuerKeyDoc {
  ownerId: Uint8Array;
  epoch: number;
  spki: Uint8Array;
  keyId: Uint8Array;
  variant: string;
  createdAtCoreBlockHeight: number;
}

export interface IssuerRevocationDoc {
  ownerId: Uint8Array;
  epoch: number;
  keyId: Uint8Array;
  effectiveCoreHeight: number;
  createdAtCoreBlockHeight: number;
}

export interface MnBadgeDoc {
  /** the badge holder ($ownerId) */
  ownerId: Uint8Array;
  issuerId: Uint8Array;
  epoch: number;
  keyId: Uint8Array;
  msgPrefix: Uint8Array;
  sig: Uint8Array;
  createdAtCoreBlockHeight: number;
}

export interface ReaderConfig {
  net: BadgeNetwork;
  /** the `badge` contract these documents were read from */
  contractId: Uint8Array;
  /** defaults to EPOCH_PARAMS[net] */
  params?: EpochParams;
  /** tests only */
  importOptions?: ImportOptions;
}

export interface AcceptedIssuerKey {
  key: BoundIssuerKey;
  issuerId: Uint8Array;
  epoch: number;
  /** badges created at or after this core height are void (issuerRevocation), else null */
  revokedFrom: number | null;
}

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };
const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const paramsOf = (cfg: ReaderConfig): EpochParams => cfg.params ?? EPOCH_PARAMS[cfg.net];
const isU32 = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 0xffffffff;

/** Validates the proved issuerKey (and revocation, if any) for (issuerId, epoch); `issuerId` comes from the trust list. */
export async function acceptIssuerKey(
  cfg: ReaderConfig,
  expected: { issuerId: Uint8Array; epoch: number },
  doc: IssuerKeyDoc | null,
  revocation: IssuerRevocationDoc | null = null,
): Promise<Verdict<AcceptedIssuerKey>> {
  const p = paramsOf(cfg);
  if (!doc) return no('no issuerKey for this epoch');
  if (!isU32(expected.epoch) || expected.epoch < 1) return no('bad epoch');
  if (!equalBytes(doc.ownerId, expected.issuerId)) return no('issuerKey owner is not the trusted issuer');
  if (doc.epoch !== expected.epoch) return no('issuerKey epoch mismatch');
  if (doc.variant !== VARIANT) return no('issuerKey variant');
  if (!isU32(doc.createdAtCoreBlockHeight) || doc.createdAtCoreBlockHeight >= keyDeadline(p, doc.epoch)) return no('issuerKey published too late (must precede S(E-1))');
  if (!equalBytes(doc.keyId, await deriveKeyId(doc.spki))) return no('issuerKey keyId != SHA256(spki)');
  let key;
  try {
    key = await importIssuerKey(doc.spki, cfg.importOptions);
  } catch (e) {
    return no(`issuerKey spki rejected: ${(e as Error).message}`);
  }
  let revokedFrom: number | null = null;
  if (revocation) {
    // Fail closed: any revocation the issuer published for this epoch voids the epoch's key from its height on.
    if (!equalBytes(revocation.ownerId, expected.issuerId) || revocation.epoch !== expected.epoch) return no('revocation does not match the issuer/epoch');
    revokedFrom = isU32(revocation.effectiveCoreHeight) ? revocation.effectiveCoreHeight : 0;
  }
  const bound = bindIssuerKey(key, { net: cfg.net, contractId: cfg.contractId, issuerId: expected.issuerId, epoch: expected.epoch });
  return { ok: true, value: { key: bound, issuerId: expected.issuerId, epoch: expected.epoch, revokedFrom } };
}

/** Checks one proved mnBadge document against an accepted key, at the current core height `nowHeight`. */
export async function verifyMnBadge(cfg: ReaderConfig, k: AcceptedIssuerKey, doc: MnBadgeDoc, nowHeight: number): Promise<Verdict<{ epoch: number }>> {
  const p = paramsOf(cfg);
  if (!equalBytes(doc.issuerId, k.issuerId)) return no('issuer mismatch');
  if (doc.epoch !== k.epoch) return no('epoch mismatch');
  if (!equalBytes(doc.keyId, k.key.keyId)) return no('keyId mismatch');
  if (doc.msgPrefix.length !== MSG_PREFIX_LEN) return no('bad msgPrefix');
  const h = doc.createdAtCoreBlockHeight;
  if (!isU32(h) || !inDisplayWindow(p, k.epoch, h)) return no('badge created outside its window');
  if (!inDisplayWindow(p, k.epoch, nowHeight)) return no('badge epoch not displayed now');
  if (k.revokedFrom !== null && h >= k.revokedFrom) return no('issuer key revoked');
  const ok = await verifyBadgeSignature(k.key, { ownerId: doc.ownerId, msgPrefix: doc.msgPrefix, sig: doc.sig });
  return ok ? { ok: true, value: { epoch: k.epoch } } : no('bad signature');
}
