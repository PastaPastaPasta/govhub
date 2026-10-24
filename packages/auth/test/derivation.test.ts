// Seed and DIP-13 derivation vectors, cross-checked against the implementations users restore in:
//  - Yappr (lib/crypto/dip13.test.ts pins the testnet MASTER key of identity 0 for the BIP39 test phrase)
//  - rust-dashcore key-wallet (Dash Evo Tool, rs-platform-wallet, the swift-sdk behind DashPay iOS), through evo-sdk's
//    WasmSdk.deriveKeyFromSeedWithExtendedPath, an independent BIP32 in Rust; and key-wallet's own path-string tests (bip32.rs)
//  - Dash Bridge (src/crypto/hd.ts getIdentityKeyDerivationPath), whose path format we reproduce
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex } from '../src/bytes.ts';
import { addressOf, wifOf } from '../src/keys.ts';
import {
  generatePhrase, identityKeyPath, isValidPhrase, normalizePhrase, PhraseError, registrationFundingPath, SeedWallet, topUpFundingPath,
} from '../src/seed.ts';

const TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PHRASE_24 = 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';

interface Wasm {
  deriveKeyFromSeedWithExtendedPath(p: { mnemonic: string; path: string; network: string }): { toJSON(): { privateKeyHex: string; publicKey: string }; free?(): void };
}
let wasm: Wasm;
beforeAll(async () => {
  const evo = (await import('@dashevo/evo-sdk')) as unknown as { WasmSdk: Wasm; ensureInitialized(): Promise<void> };
  await evo.ensureInitialized();
  wasm = evo.WasmSdk;
});
const keyWallet = (mnemonic: string, path: string, network: string) => {
  const r = wasm.deriveKeyFromSeedWithExtendedPath({ mnemonic, path, network });
  try {
    return r.toJSON();
  } finally {
    r.free?.();
  }
};

describe('paths', () => {
  it('match key-wallet (bip32.rs test_identity_authentication_path) and DIP-13', () => {
    expect(identityKeyPath('mainnet', 1, 2)).toBe("m/9'/5'/5'/0'/0'/1'/2'");
    expect(identityKeyPath('testnet', 0, 0)).toBe("m/9'/1'/5'/0'/0'/0'/0'");
    expect(registrationFundingPath('mainnet', 0)).toBe("m/9'/5'/5'/1'/0'");
    expect(registrationFundingPath('testnet', 3)).toBe("m/9'/1'/5'/1'/3'");
    expect(topUpFundingPath('mainnet', 0, 7)).toBe("m/9'/5'/5'/2'/0'/7");
    expect(topUpFundingPath('testnet', 2, 0)).toBe("m/9'/1'/5'/2'/2'/0");
  });

  it('match Dash Bridge getIdentityKeyDerivationPath(keyIndex, network, identityIndex)', () => {
    const bridge = (keyIndex: number, network: string, identityIndex = 0) => `m/9'/${network === 'mainnet' ? 5 : 1}'/5'/0'/0'/${identityIndex}'/${keyIndex}'`;
    for (const n of ['mainnet', 'testnet'] as const) for (const [i, k] of [[0, 0], [0, 2], [4, 1]] as const) expect(identityKeyPath(n, i, k)).toBe(bridge(k, n, i));
  });

  it('refuse out-of-range indexes', () => {
    expect(() => identityKeyPath('testnet', -1, 0)).toThrow();
    expect(() => identityKeyPath('testnet', 0x80000000, 0)).toThrow();
  });
});

describe('seed keys', () => {
  it("reproduce Yappr's pinned testnet MASTER key of identity 0", () => {
    const w = SeedWallet.fromPhrase(TEST_PHRASE, 'testnet');
    expect(bytesToHex(w.identityKey(0, 0).publicKey)).toBe('03a00f4853081aeb8c9debe37267303fa133bd7f6678bfb3299dfa001bfd0341db');
  });

  it('equal key-wallet (Evo Tool / rs-platform-wallet) for identity, registration and top-up keys on both networks', () => {
    for (const phrase of [TEST_PHRASE, PHRASE_24]) {
      for (const network of ['mainnet', 'testnet'] as const) {
        const w = SeedWallet.fromPhrase(phrase, network);
        const paths = [
          identityKeyPath(network, 0, 0), identityKeyPath(network, 0, 1), identityKeyPath(network, 0, 2), identityKeyPath(network, 1, 2),
          identityKeyPath(network, 0, 11), registrationFundingPath(network, 0), topUpFundingPath(network, 0, 0), topUpFundingPath(network, 1, 5),
        ];
        for (const path of paths) {
          const ref = keyWallet(phrase, path, network);
          const k = w.derive(path);
          expect(bytesToHex(k.privateKey), path).toBe(ref.privateKeyHex);
          expect(bytesToHex(k.publicKey), path).toBe(ref.publicKey);
        }
      }
    }
  });

  it('equal an independent BIP32 run over the BIP39 seed with an empty passphrase', () => {
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_PHRASE, ''));
    const w = SeedWallet.fromPhrase(TEST_PHRASE, 'mainnet');
    const p = identityKeyPath('mainnet', 0, 2);
    expect(bytesToHex(w.derive(p).privateKey)).toBe(bytesToHex(root.derive(p).privateKey!));
  });

  // Pinned outputs so a dependency change cannot silently move users' keys (computed by this code and key-wallet above).
  it('pins the mainnet and testnet key layouts of the test phrase', () => {
    const pins: Record<string, string> = {};
    for (const network of ['mainnet', 'testnet'] as const) {
      const w = SeedWallet.fromPhrase(TEST_PHRASE, network);
      for (const k of [0, 1, 2]) pins[`${network}/${k}`] = bytesToHex(w.identityKey(0, k).publicKey);
      pins[`${network}/funding`] = addressOf(w.derive(registrationFundingPath(network, 0)).publicKey, network);
    }
    expect(pins).toMatchSnapshot();
  });

  it('treats the phrase as BIP39 does: case, spacing, NFKD', () => {
    const a = SeedWallet.fromPhrase(`  ${TEST_PHRASE.toUpperCase().split(' ').join('\t ')}\n`, 'testnet');
    const b = SeedWallet.fromPhrase(TEST_PHRASE, 'testnet');
    expect(bytesToHex(a.identityKey(0, 2).publicKey)).toBe(bytesToHex(b.identityKey(0, 2).publicKey));
    expect(normalizePhrase(' Abandon\tABOUT ')).toBe('abandon about');
  });

  it('refuses a bad checksum, wrong word counts and non-words', () => {
    expect(() => SeedWallet.fromPhrase(TEST_PHRASE.replace(/about$/, 'abandon'), 'testnet')).toThrow(PhraseError);
    expect(isValidPhrase(TEST_PHRASE.split(' ').slice(0, 11).join(' '))).toBe(false);
    expect(isValidPhrase(TEST_PHRASE.replace('about', 'dashy'))).toBe(false);
    expect(isValidPhrase(PHRASE_24)).toBe(true);
  });

  it('round-trips through the entropy the vault stores', () => {
    for (const phrase of [TEST_PHRASE, PHRASE_24]) {
      const w = SeedWallet.fromPhrase(phrase, 'testnet');
      const e = w.entropy();
      expect(e.length).toBe(phrase.split(' ').length === 12 ? 16 : 32);
      const back = SeedWallet.fromEntropy(e, 'testnet');
      expect(back.phrase()).toBe(phrase);
      expect(bytesToHex(back.identityKey(0, 2).privateKey)).toBe(bytesToHex(w.identityKey(0, 2).privateKey));
    }
  });

  it('wipes: no derivation after wipe()', () => {
    const w = SeedWallet.fromPhrase(TEST_PHRASE, 'testnet');
    w.wipe();
    expect(w.wiped).toBe(true);
    expect(() => w.identityKey(0, 0)).toThrow();
  });
});

describe('phrase generation', () => {
  it('makes valid 12- and 24-word phrases, all different', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const p12 = generatePhrase(12);
      const p24 = generatePhrase(24);
      expect(p12.split(' ')).toHaveLength(12);
      expect(p24.split(' ')).toHaveLength(24);
      expect(isValidPhrase(p12) && isValidPhrase(p24)).toBe(true);
      seen.add(p12).add(p24);
    }
    expect(seen.size).toBe(40);
  });

  it('WIF of a derived key uses the network prefix', () => {
    const w = SeedWallet.fromPhrase(TEST_PHRASE, 'testnet');
    expect(wifOf(w.identityKey(0, 2).privateKey, 'testnet')).toMatch(/^c/);
    expect(wifOf(w.identityKey(0, 2).privateKey, 'mainnet')).toMatch(/^X/);
  });
});
