// The one standard Dash seed (PLAN 4.1): BIP39 English, 12 or 24 words, NO passphrase, keys along DIP-9/DIP-13 paths. The same
// phrase restores in DashPay iOS, Dash Evo Tool and Yappr; test/derivation.test.ts pins vectors from those implementations.
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, generateMnemonic, mnemonicToEntropy, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { wipe } from './bytes.ts';
import { coinType, publicKeyOf, type Network } from './keys.ts';

export type PhraseLength = 12 | 24;

/** A phrase as BIP39 reads it: NFKD, lower case, single spaces. */
export function normalizePhrase(input: string): string {
  return input.normalize('NFKD').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

export const isValidPhrase = (input: string): boolean => {
  const p = normalizePhrase(input);
  const n = p.split(' ').length;
  return (n === 12 || n === 24) && validateMnemonic(p, wordlist);
};

/** A fresh phrase from Web Crypto randomness (128 bits for 12 words, 256 for 24). */
export const generatePhrase = (words: PhraseLength = 12): string => generateMnemonic(wordlist, words === 24 ? 256 : 128);

export const WORDLIST: readonly string[] = wordlist;

export class PhraseError extends Error {
  constructor() {
    super("That recovery phrase isn't valid. Check each word and try again.");
    this.name = 'PhraseError';
  }
}

// ---- DIP-9 / DIP-13 paths -------------------------------------------------------------------------------------------------

function hardened(i: number): string {
  if (!Number.isInteger(i) || i < 0 || i >= 0x80000000) throw new RangeError(`invalid derivation index ${i}`);
  return `${i}'`;
}
function normal(i: number): string {
  if (!Number.isInteger(i) || i < 0 || i >= 0x80000000) throw new RangeError(`invalid derivation index ${i}`);
  return `${i}`;
}

/** `m/9'/coin'/5'/0'/0'/identity'/key'`: ECDSA identity authentication key (DIP-13 "identity authentication", key type 0' = ECDSA). */
export const identityKeyPath = (n: Network, identityIndex: number, keyIndex: number): string =>
  `m/9'/${coinType(n)}'/5'/0'/0'/${hardened(identityIndex)}/${hardened(keyIndex)}`;

/**
 * `m/9'/coin'/5'/1'/identity`: the one-time key that funds the registration of identity `identityIndex` (DIP-13 registration funding).
 * The last index is NOT hardened: key-wallet's `IdentityRegistration` account is an `AddressPoolType::Absent` pool (normal children),
 * which is what rs-platform-wallet funds registrations from and what Dash Evo Tool and the iOS develop wallet scan.
 */
export const registrationFundingPath = (n: Network, identityIndex: number): string => `m/9'/${coinType(n)}'/5'/1'/${normal(identityIndex)}`;

/**
 * `m/9'/coin'/5'/1'/identity'`: the hardened registration funding key govhub used until 2026-10-25 (and the phase-0 mainnet run).
 * Scan-only: no new funding uses it. The Recover tool scans it, and an unfinished funding this browser began there finishes there.
 */
export const legacyRegistrationFundingPath = (n: Network, identityIndex: number): string =>
  `m/9'/${coinType(n)}'/5'/1'/${hardened(identityIndex)}`;

/** `m/9'/coin'/5'/2'/registration'/n`: the n-th top-up funding key of identity `identityIndex` (key-wallet `IdentityTopUp { registration_index }`, an `Absent` pool). */
export const topUpFundingPath = (n: Network, identityIndex: number, topUpIndex: number): string =>
  `m/9'/${coinType(n)}'/5'/2'/${hardened(identityIndex)}/${normal(topUpIndex)}`;

/** Discovery stops after this many unused identity indexes in a row (rs-platform-wallet IDENTITY_GAP_LIMIT, DashPay, Yappr). */
export const IDENTITY_GAP_LIMIT = 5;
/** Evo Tool looks for an identity's keys among key indexes 0..11 of its identity index. */
export const KEY_PROBE_LIMIT = 12;

export interface DerivedKey {
  privateKey: Uint8Array;
  /** 33-byte compressed point. */
  publicKey: Uint8Array;
}

/**
 * A key-deriving handle for one phrase. Keeps the BIP32 root and the BIP39 entropy (what the passkey vault seals), not the phrase
 * string. Every derived private key is a fresh copy the caller may wipe; `wipe()` clears the root and entropy.
 */
export class SeedWallet {
  readonly network: Network;
  #root: HDKey | null;
  #entropy: Uint8Array | null;

  private constructor(root: HDKey, entropy: Uint8Array, network: Network) {
    this.#root = root;
    this.#entropy = entropy;
    this.network = network;
  }

  static fromPhrase(input: string, network: Network): SeedWallet {
    const phrase = normalizePhrase(input);
    if (!isValidPhrase(phrase)) throw new PhraseError();
    const seed = mnemonicToSeedSync(phrase, ''); // DashPay and Evo Tool use no BIP39 passphrase
    try {
      return new SeedWallet(HDKey.fromMasterSeed(seed), mnemonicToEntropy(phrase, wordlist), network);
    } finally {
      wipe(seed);
    }
  }

  static fromEntropy(entropy: Uint8Array, network: Network): SeedWallet {
    if (entropy.length !== 16 && entropy.length !== 32) throw new PhraseError();
    return SeedWallet.fromPhrase(entropyToMnemonic(entropy, wordlist), network);
  }

  get wiped(): boolean {
    return this.#root === null;
  }

  /** Copy of the BIP39 entropy (16 or 32 bytes); the caller wipes it. */
  entropy(): Uint8Array {
    if (!this.#entropy) throw new Error('wallet was wiped');
    return this.#entropy.slice();
  }

  /** The phrase, for the "show my phrase" screen only. */
  phrase(): string {
    if (!this.#entropy) throw new Error('wallet was wiped');
    return entropyToMnemonic(this.#entropy, wordlist);
  }

  derive(path: string): DerivedKey {
    if (!this.#root) throw new Error('wallet was wiped');
    const node = this.#root.derive(path);
    try {
      if (!node.privateKey) throw new Error(`no private key at ${path}`);
      const privateKey = node.privateKey.slice();
      return { privateKey, publicKey: publicKeyOf(privateKey) };
    } finally {
      node.wipePrivateData();
    }
  }

  identityKey(identityIndex: number, keyIndex: number): DerivedKey {
    return this.derive(identityKeyPath(this.network, identityIndex, keyIndex));
  }

  wipe(): void {
    this.#root?.wipePrivateData();
    this.#root = null;
    wipe(this.#entropy);
    this.#entropy = null;
  }
}
