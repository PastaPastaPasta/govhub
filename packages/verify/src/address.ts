// Base58Check Dash addresses (P2PKH / P2SH). Version bytes: src/chainparams.cpp in Dash Core
// (mainnet chainparams.cpp:262,264,266: PUBKEY 76 = 0x4c, SCRIPT 16 = 0x10, SECRET 204 = 0xcc; testnet :466,468,470, devnet :649-653,
// regtest :932-936: PUBKEY 140 = 0x8c, SCRIPT 19 = 0x13, SECRET 239 = 0xef). DecodeDestination: key_io.cpp:42-77.
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from './bytes.ts';

/** `testnet`, `devnet` and `regtest` share address prefixes, but they are distinct networks for vote signing (see vote.ts). */
export type Network = 'mainnet' | 'testnet' | 'devnet' | 'regtest';

export const ADDRESS_VERSION = {
  mainnet: { p2pkh: 0x4c, p2sh: 0x10, wif: 0xcc },
  testnet: { p2pkh: 0x8c, p2sh: 0x13, wif: 0xef },
  devnet: { p2pkh: 0x8c, p2sh: 0x13, wif: 0xef },
  regtest: { p2pkh: 0x8c, p2sh: 0x13, wif: 0xef },
} as const;

const b58c = base58check(sha256);

export type AddressType = 'p2pkh' | 'p2sh';
export interface DecodedAddress {
  type: AddressType;
  hash160: Uint8Array;
}

/**
 * Mirrors Core's DecodeDestination for Base58 strings (key_io.cpp:42-77): the payload must be exactly
 * 1 version byte + 20 bytes, and the version byte must be this network's PUBKEY or SCRIPT prefix.
 * Anything else (including DIP-18 Platform bech32m addresses, which Core refuses as L1 destinations) returns null.
 */
export function decodeAddress(address: string, network: Network): DecodedAddress | null {
  let data: Uint8Array;
  try {
    data = b58c.decode(address);
  } catch {
    return null;
  }
  if (data.length !== 21) return null;
  const v = ADDRESS_VERSION[network];
  const version = data[0]!;
  const hash = data.slice(1);
  if (version === v.p2pkh) return { type: 'p2pkh', hash160: hash };
  if (version === v.p2sh) return { type: 'p2sh', hash160: hash };
  return null;
}

export function encodeAddress(type: AddressType, hash160: Uint8Array, network: Network): string {
  if (hash160.length !== 20) throw new Error('hash160 must be 20 bytes');
  return b58c.encode(concatBytes(Uint8Array.of(ADDRESS_VERSION[network][type]), hash160));
}

/** P2PKH address for a hash160 (`CKeyID`). */
export const p2pkhAddress = (hash: Uint8Array, network: Network): string => encodeAddress('p2pkh', hash, network);

/** WIF (compressed flag optional) -> 32-byte private key. Network must match. */
export function decodeWif(wif: string, network: Network): { privKey: Uint8Array; compressed: boolean } {
  const data = b58c.decode(wif);
  const ver = ADDRESS_VERSION[network].wif;
  if (data[0] !== ver) throw new Error('WIF network mismatch');
  if (data.length === 33) return { privKey: data.slice(1), compressed: false };
  if (data.length === 34 && data[33] === 1) return { privKey: data.slice(1, 33), compressed: true };
  throw new Error('invalid WIF length');
}

export function encodeWif(privKey: Uint8Array, compressed: boolean, network: Network): string {
  if (privKey.length !== 32) throw new Error('private key must be 32 bytes');
  const version = Uint8Array.of(ADDRESS_VERSION[network].wif);
  return b58c.encode(compressed ? concatBytes(version, privKey, Uint8Array.of(1)) : concatBytes(version, privKey));
}
