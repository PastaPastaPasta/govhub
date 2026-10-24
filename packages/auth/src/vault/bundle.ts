// The passkey vault's crypto (`forum.vault`, PLAN 3.1), ported from Yappr's passkey vault v1 (docs/PASSKEY_VAULT.md "Crypto")
// without its PV14 / App Connect parts (no key rings, no refersTo, no immutable fields: PV13 has none of them).
//
//   PRF input  UTF8("govhub/vault/v1/prf") || vaultContractId          one input per deployment, so a discoverable sign-in
//                                                                      evaluates the PRF in the same ceremony that picks the passkey
//   recipient  (skR, pkR) = HPKE DeriveKeyPair(prfOutput)              pkR is the document's `recipientKey`
//   info       UTF8("govhub/vault/v1") || 0x00 || contractId || ownerId
//   AAD        UTF8("vault") || 0x00 || u8 version || u8 len(credentialId) || credentialId || recipientKey || u32be authKeyId
//
// Every bundle is padded to BUNDLE_LENGTH (sealed: 256 B, the schema's maximum) whatever it holds, so the chain cannot tell a seed
// from a single key from masternode voting keys, nor count the voting keys.
//
// HPKE has no sender authentication: anyone can seal to a public recipientKey, and anyone who once held a key of the owner can
// write an entry. An opened bundle proves nothing until vault/service.ts checks it against the identity's keys on chain.
import { bytesEqual, concatBytes, readU32be, u32be } from '../bytes.ts';
import { isValidPrivateKey, KeyPurpose, KeyType, SecurityLevel } from '../keys.ts';
import { deriveKeyPair, openBase, sealBase, type HpkeKeyPair } from './hpke.ts';

export const VAULT_VERSION = 1;
export const VAULT_DOCUMENT_TYPE = 'vault';
export const BUNDLE_LENGTH = 240;
export const SEALED_LENGTH = BUNDLE_LENGTH + 16;
export const MAX_VOTING_KEYS = 7;

export const BundleFormat = {
  /** The BIP39 entropy and identity index: the whole seed. */
  SEED: 1,
  /** One AUTHENTICATION key at HIGH or CRITICAL (a key-paste session). */
  KEY: 2,
  /** Masternode voting keys (for the voting phases; never used to sign in). */
  VOTING_KEYS: 3,
} as const;
export type BundleFormat = (typeof BundleFormat)[keyof typeof BundleFormat];

export type VaultBundle =
  | { format: typeof BundleFormat.SEED; identityIndex: number; entropy: Uint8Array }
  | { format: typeof BundleFormat.KEY; key: { keyId: number; purpose: number; securityLevel: number; keyType: number; privateKey: Uint8Array } }
  | { format: typeof BundleFormat.VOTING_KEYS; keys: Uint8Array[] };

export interface SealedVaultEntry {
  version: number;
  credentialId: Uint8Array;
  recipientKey: Uint8Array;
  authKeyId: number;
  enc: Uint8Array;
  sealed: Uint8Array;
}

export class VaultCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultCryptoError';
  }
}

function need(cond: boolean, message: string): asserts cond {
  if (!cond) throw new VaultCryptoError(message);
}

const te = new TextEncoder();
const is32 = (b: Uint8Array) => b.length === 32;
const isU32 = (v: number) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

export function prfInput(contractId: Uint8Array): Uint8Array {
  need(is32(contractId), 'the vault contract id must be 32 bytes');
  return concatBytes(te.encode('govhub/vault/v1/prf'), contractId);
}

export function recipientFromPrf(prfOutput: Uint8Array): HpkeKeyPair {
  need(is32(prfOutput), 'the PRF output must be 32 bytes');
  return deriveKeyPair(prfOutput);
}

export function hpkeInfo(contractId: Uint8Array, ownerId: Uint8Array): Uint8Array {
  need(is32(contractId) && is32(ownerId), 'the contract and owner ids must be 32 bytes');
  return concatBytes(te.encode('govhub/vault/v1'), Uint8Array.of(0), contractId, ownerId);
}

export function entryAad(e: Pick<SealedVaultEntry, 'version' | 'credentialId' | 'recipientKey' | 'authKeyId'>): Uint8Array {
  need(Number.isInteger(e.version) && e.version >= 1 && e.version <= 255, 'the entry version is out of range');
  need(e.credentialId.length >= 16 && e.credentialId.length <= 255, 'the credential id must be 16 to 255 bytes');
  need(is32(e.recipientKey), 'the recipient key must be 32 bytes');
  need(isU32(e.authKeyId), 'the key id is out of range');
  return concatBytes(te.encode(VAULT_DOCUMENT_TYPE), Uint8Array.of(0, e.version, e.credentialId.length), e.credentialId, e.recipientKey, u32be(e.authKeyId));
}

const loginKeyShape = (k: { purpose: number; securityLevel: number; keyType: number }) =>
  k.purpose === KeyPurpose.AUTHENTICATION &&
  (k.securityLevel === SecurityLevel.HIGH || k.securityLevel === SecurityLevel.CRITICAL) &&
  (k.keyType === KeyType.ECDSA_SECP256K1 || k.keyType === KeyType.ECDSA_HASH160);

export function encodeBundle(b: VaultBundle): Uint8Array {
  const out = new Uint8Array(BUNDLE_LENGTH);
  out[0] = b.format;
  switch (b.format) {
    case BundleFormat.SEED:
      need(b.entropy.length === 16 || b.entropy.length === 32, 'seed entropy must be 16 or 32 bytes');
      need(isU32(b.identityIndex) && b.identityIndex < 0x80000000, 'identity index out of range');
      out[1] = b.entropy.length;
      out.set(u32be(b.identityIndex), 2);
      out.set(b.entropy, 6);
      return out;
    case BundleFormat.KEY: {
      const k = b.key;
      need(loginKeyShape(k), 'only a HIGH or CRITICAL authentication key may be stored (never MASTER or TRANSFER)');
      need(isU32(k.keyId) && isValidPrivateKey(k.privateKey), 'invalid key');
      out[1] = 1;
      out.set([k.purpose, k.securityLevel, k.keyType], 2);
      out.set(u32be(k.keyId), 5);
      out.set(k.privateKey, 9);
      return out;
    }
    case BundleFormat.VOTING_KEYS:
      need(b.keys.length >= 1 && b.keys.length <= MAX_VOTING_KEYS, `a voting-key bundle holds 1 to ${MAX_VOTING_KEYS} keys`);
      need(b.keys.every(isValidPrivateKey), 'invalid voting key');
      need(new Set(b.keys.map((k) => k.join(','))).size === b.keys.length, 'a voting key appears twice');
      out[1] = b.keys.length;
      b.keys.forEach((k, i) => out.set(k, 2 + i * 32));
      return out;
    default:
      throw new VaultCryptoError('unknown bundle format');
  }
}

/** Decodes and checks a bundle; refuses unknown formats, non-zero padding, MASTER/TRANSFER keys, and a KEY whose id is not `authKeyId`. */
export function decodeBundle(bytes: Uint8Array, authKeyId: number): VaultBundle {
  need(bytes.length === BUNDLE_LENGTH, 'the bundle has the wrong length');
  const format = bytes[0];
  const zeroFrom = (i: number) => need(bytes.subarray(i).every((x) => x === 0), "the bundle's padding is not zero");
  if (format === BundleFormat.SEED) {
    const len = bytes[1]!;
    need(len === 16 || len === 32, 'seed entropy must be 16 or 32 bytes');
    const identityIndex = readU32be(bytes, 2);
    need(identityIndex < 0x80000000, 'identity index out of range');
    zeroFrom(6 + len);
    return { format, identityIndex, entropy: bytes.slice(6, 6 + len) };
  }
  if (format === BundleFormat.KEY) {
    need(bytes[1] === 1, 'a key bundle holds one key');
    const key = { purpose: bytes[2]!, securityLevel: bytes[3]!, keyType: bytes[4]!, keyId: readU32be(bytes, 5), privateKey: bytes.slice(9, 41) };
    try {
      need(loginKeyShape(key), 'the bundle holds a key that may not be stored');
      need(key.keyId === authKeyId, "the bundle's key is not the entry's key id");
      need(isValidPrivateKey(key.privateKey), 'invalid key');
      zeroFrom(41);
    } catch (e) {
      key.privateKey.fill(0);
      throw e;
    }
    return { format, key };
  }
  if (format === BundleFormat.VOTING_KEYS) {
    const n = bytes[1]!;
    need(n >= 1 && n <= MAX_VOTING_KEYS, 'voting key count out of range');
    zeroFrom(2 + n * 32);
    const keys = Array.from({ length: n }, (_, i) => bytes.slice(2 + i * 32, 34 + i * 32));
    if (!keys.every(isValidPrivateKey)) {
      keys.forEach((k) => k.fill(0));
      throw new VaultCryptoError('invalid voting key');
    }
    return { format, keys };
  }
  throw new VaultCryptoError('unknown bundle format');
}

export function wipeBundle(b: VaultBundle): void {
  if (b.format === BundleFormat.SEED) b.entropy.fill(0);
  else if (b.format === BundleFormat.KEY) b.key.privateKey.fill(0);
  else b.keys.forEach((k) => k.fill(0));
}

/** Seals `bundle` to a passkey's recipient key. Needs no passkey ceremony (any signed-in device can re-seal). */
export function sealEntry(o: { contractId: Uint8Array; ownerId: Uint8Array; credentialId: Uint8Array; recipientKey: Uint8Array; authKeyId: number; bundle: VaultBundle; ephemeralIkm?: Uint8Array }): SealedVaultEntry {
  const fields = { version: VAULT_VERSION, credentialId: o.credentialId, recipientKey: o.recipientKey, authKeyId: o.authKeyId };
  if (o.bundle.format === BundleFormat.KEY) need(o.bundle.key.keyId === o.authKeyId, "the bundle's key is not the entry's key id");
  const aad = entryAad(fields);
  const pt = encodeBundle(o.bundle);
  try {
    const { enc, ciphertext } = sealBase(o.recipientKey, hpkeInfo(o.contractId, o.ownerId), aad, pt, o.ephemeralIkm);
    return { ...fields, enc, sealed: ciphertext };
  } finally {
    pt.fill(0);
  }
}

/** Opens an entry with its passkey's PRF output: refuses another passkey's entry before decrypting; wipes the derived secret. */
export function openEntry(o: { contractId: Uint8Array; ownerId: Uint8Array; entry: SealedVaultEntry; prfOutput: Uint8Array }): VaultBundle {
  const e = o.entry;
  need(e.version === VAULT_VERSION, 'unknown entry version');
  need(is32(e.enc), "the entry's encapsulated key must be 32 bytes");
  need(e.sealed.length === SEALED_LENGTH, "the entry's ciphertext has the wrong length");
  const r = recipientFromPrf(o.prfOutput);
  try {
    need(bytesEqual(r.publicKey, e.recipientKey), 'this passkey does not open this entry');
    let pt: Uint8Array;
    try {
      pt = openBase(e.enc, r.privateKey, hpkeInfo(o.contractId, o.ownerId), entryAad(e), e.sealed);
    } catch (err) {
      if (err instanceof VaultCryptoError) throw err;
      throw new VaultCryptoError('the entry does not decrypt');
    }
    try {
      return decodeBundle(pt, e.authKeyId);
    } finally {
      pt.fill(0);
    }
  } finally {
    r.privateKey.fill(0);
  }
}
