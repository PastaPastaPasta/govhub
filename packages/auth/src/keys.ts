// secp256k1 keys, WIF, addresses and the identity key model (purpose / security level / type numbers as rs-dpp defines them).
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { decodeWif, encodeWif, p2pkhAddress } from '@govhub/verify';
import { bytesEqual, hash160, hexToBytes, wipe } from './bytes.ts';

export type Network = 'mainnet' | 'testnet';

/** DIP-9 coin type: 5' on mainnet, 1' on every test network. */
export const coinType = (n: Network): number => (n === 'mainnet' ? 5 : 1);

/** rs-dpp `Purpose`. */
export const KeyPurpose = { AUTHENTICATION: 0, ENCRYPTION: 1, DECRYPTION: 2, TRANSFER: 3, SYSTEM: 4, VOTING: 5, OWNER: 6 } as const;
/** rs-dpp `SecurityLevel` (lower is stronger). */
export const SecurityLevel = { MASTER: 0, CRITICAL: 1, HIGH: 2, MEDIUM: 3 } as const;
/** rs-dpp `KeyType`. */
export const KeyType = { ECDSA_SECP256K1: 0, BLS12_381: 1, ECDSA_HASH160: 2, BIP13_SCRIPT_HASH: 3, EDDSA_25519_HASH160: 4 } as const;

/** A public key of an identity as read from Platform (proved), reduced to what sign-in needs. */
export interface IdentityKeyInfo {
  id: number;
  purpose: number;
  securityLevel: number;
  type: number;
  /** 33-byte compressed point (ECDSA_SECP256K1) or 20-byte hash (ECDSA_HASH160). */
  data: Uint8Array;
  disabled: boolean;
  /** The key is bound to a contract (it can only sign for that contract). */
  bound: boolean;
}

export const publicKeyOf = (priv: Uint8Array): Uint8Array => secp256k1.getPublicKey(priv, true);

export function isValidPrivateKey(priv: Uint8Array): boolean {
  if (priv.length !== 32) return false;
  try {
    secp256k1.getPublicKey(priv, true);
    return true;
  } catch {
    return false;
  }
}

/** Whether `priv` is the private half of the on-chain `key` (by point, or by hash160 for ECDSA_HASH160 keys). */
export function privateKeyMatches(priv: Uint8Array, key: Pick<IdentityKeyInfo, 'type' | 'data'>): boolean {
  const pub = publicKeyOf(priv);
  if (key.type === KeyType.ECDSA_SECP256K1) return bytesEqual(pub, key.data);
  if (key.type === KeyType.ECDSA_HASH160) return bytesEqual(hash160(pub), key.data);
  return false;
}

/** A key that may sign govhub documents and log in: enabled AUTHENTICATION at HIGH or CRITICAL, secp256k1, not contract-bound. Never MASTER. */
export function isLoginKey(k: IdentityKeyInfo): boolean {
  return (
    !k.disabled &&
    !k.bound &&
    k.purpose === KeyPurpose.AUTHENTICATION &&
    (k.securityLevel === SecurityLevel.HIGH || k.securityLevel === SecurityLevel.CRITICAL) &&
    (k.type === KeyType.ECDSA_SECP256K1 || k.type === KeyType.ECDSA_HASH160)
  );
}

export const wifOf = (priv: Uint8Array, network: Network): string => encodeWif(priv, true, network);
export const addressOf = (pub: Uint8Array, network: Network): string => p2pkhAddress(hash160(pub), network);

export class KeyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyInputError';
  }
}

/**
 * A pasted private key: WIF for `network`, or 32-byte hex (optionally 0x-prefixed). Returns fresh bytes the caller wipes.
 * The error never echoes the input.
 */
export function parsePrivateKey(input: string, network: Network): Uint8Array {
  const text = input.trim();
  let priv: Uint8Array;
  if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(text)) {
    priv = hexToBytes(text.replace(/^0x/, ''));
  } else {
    try {
      priv = decodeWif(text, network).privKey;
    } catch {
      const other: Network = network === 'mainnet' ? 'testnet' : 'mainnet';
      let wrongNet = false;
      try {
        wipe(decodeWif(text, other).privKey);
        wrongNet = true;
      } catch {
        /* not a WIF at all */
      }
      throw new KeyInputError(wrongNet ? `That key is for ${other}; this site uses ${network}.` : 'Enter a private key as WIF or 64 hex characters.');
    }
  }
  if (!isValidPrivateKey(priv)) {
    wipe(priv);
    throw new KeyInputError('That is not a valid secp256k1 private key.');
  }
  return priv;
}
