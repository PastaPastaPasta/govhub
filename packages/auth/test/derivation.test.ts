// Seed and DIP-13 derivation vectors, cross-checked against the implementations users restore in:
//  - Yappr (lib/crypto/dip13.test.ts pins the testnet MASTER key of identity 0 for the BIP39 test phrase)
//  - rust-dashcore key-wallet (Dash Evo Tool, rs-platform-wallet, the swift-sdk behind DashPay iOS), through evo-sdk's
//    WasmSdk.deriveKeyFromSeedWithExtendedPath, an independent BIP32 in Rust; and key-wallet's own path-string tests (bip32.rs)
//  - Dash Bridge (src/crypto/hd.ts getIdentityKeyDerivationPath), whose path format we reproduce
//  - rs-platform-wallet's own outputs for the test phrase (RS_PLATFORM_WALLET below): funding pools, auth keys, the legacy path
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex } from '../src/bytes.ts';
import { addressOf, wifOf } from '../src/keys.ts';
import {
  generatePhrase, identityKeyPath, isValidPhrase, legacyRegistrationFundingPath, normalizePhrase, PhraseError, registrationFundingPath, SeedWallet,
  topUpFundingPath,
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
    // key-wallet IdentityRegistration: an AddressPoolType::Absent pool, normal children
    expect(registrationFundingPath('mainnet', 0)).toBe("m/9'/5'/5'/1'/0");
    expect(registrationFundingPath('testnet', 3)).toBe("m/9'/1'/5'/1'/3");
    // key-wallet DerivationPath::identity_registration_path: what govhub used until 2026-10-25
    expect(legacyRegistrationFundingPath('mainnet', 0)).toBe("m/9'/5'/5'/1'/0'");
    expect(legacyRegistrationFundingPath('testnet', 3)).toBe("m/9'/1'/5'/1'/3'");
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
          identityKeyPath(network, 0, 11), registrationFundingPath(network, 0), registrationFundingPath(network, 4),
          legacyRegistrationFundingPath(network, 0), topUpFundingPath(network, 0, 0), topUpFundingPath(network, 1, 5),
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
      pins[`${network}/legacy-funding`] = addressOf(w.derive(legacyRegistrationFundingPath(network, 0)).publicKey, network);
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

// What rs-platform-wallet itself derives for the BIP39 test phrase: platform 371a3b3961c (key-wallet at rust-dashcore 40268cc), printed by
// a scratch program outside this repo that builds the wallet the way PlatformWalletManager::create_wallet_from_mnemonic does, then reads
//  - registration: the IdentityRegistration account's pool, addresses 0..2. AssetLockManager::peek_next_funding_address funds a
//    registration from its next unused address, which is index 0 for a fresh wallet (wallet/asset_lock/build.rs:396-512)
//  - topUp[i]: the IdentityTopUp { registration_index: i } pool that ensure_identity_topup_account adds (build.rs:569-640), 0..1
//  - auth[i][k]: derive_identity_auth_keypair(wallet, network, i, k) (wallet/identity/network/identity_handle.rs:197)
//  - legacy: key-wallet DerivationPath::identity_registration_path(network, i) (dip9.rs:692), the hardened path govhub used before
type AddrKey = readonly [address: string, publicKey: string];
const RS_PLATFORM_WALLET: Record<'mainnet' | 'testnet', { registration: AddrKey[]; topUp: AddrKey[][]; auth: string[][]; legacy: AddrKey[] }> = {
  mainnet: {
    registration: [
      ['Xb5hE8RDrAQXBkDYkAg1efNdkGhUxURj2M', '0238ce9ac38f16a5ca656d325fe6107428f7539bc70ae33e50db1d466da8e91b91'],
      ['Xodebp3T81LEGbYJpcAyNN83xVMErhtu3b', '035c44bdfd12cfdb71bea4a02f7d0294e9dde818f8ab8a0eed88953444ce3af75b'],
      ['XkYtfJUgu3La3kdNBnpSDWNCtfnbR3Cc3P', '03697d86bd039218d2a9d3e4be363cb98683b921ed5f9ebe99ccf54ace9166bc2a'],
    ],
    topUp: [
      [
        ['Xn9fFXNpaAyAiw9cBQtHvwM7iWXAXoxgez', '0253a528918e46021bd42553c17225e77a97ea8a769015059905cd1194558c7101'],
        ['Xf3uhcXvMzr3jt8iBsAt6PEM1DbJ4qgVKd', '034afcce793e7e6c1d5bb80f923293cef075f66de245e70aa43497bb65f74ce869'],
      ],
      [
        ['XuBHWCAR9Y2anfqGJdjjHvTwW7VvJWUyHu', '03498bdd01ac04a7741abcdfced8ad44576a5e5fded2814605a8b85495be8568e2'],
        ['XgJhnt4DeMcdBKzh9E2RbCRUY2Aivq9ews', '03bb271d00129b336eff58da8a344ec692646513a02aed6c810d09dc8ae971598a'],
      ],
    ],
    auth: [
      [
        '03de6e4f0a455c1f089e51c53ed937b172d46e5cec4a98e2d9977ea4638129d252', '02725184a963a31b362742455e4b1bd36b8b56b0d667f1f6c24688ed3d9b0e13e9',
        '0224fec3be710f5b8375faefd255efd97f1414bf571f4e7d6627e27aa179428a95', '02136f55ea0c496f9cf64c023d0b02b4c1a66dda56aeb40f761cf933b76578a417',
        '022c3e8d4b11cdcdbb2de4cafbcdcbdde877998e415f25b0381c440dd185e9879f', '02b27ace04e655a87a07a7a46513394ee5ce04870b91b30eb692c02a7f46c806d7',
      ],
      [
        '03a1d16e5996b98b2c08a3a81a2b4b922a76acd2094cd7bdfa560b1d91dffea5f6', '03c16c4428f119183ae4e1dfe0ae7e34cd8ffada86c60ee0e76d676baf0c158d7a',
        '03d44474281ab6a55451553d958037ac34dca0654c6aed7e07c26b6588fd574de4', '03fedfee09cd6255150772093acf225c3dd4756f0d5093cc3fc8ae5c4dc082a731',
        '0274a6518c65264dfd52e43b659f5f13c3c502df9d984db9bd3f1b12f3328d941d', '03515b3545472c3125f9dc2ffe1a7bfc7211a53900b77c8997a59382d6e383c47d',
      ],
    ],
    legacy: [
      ['XeGkvY8UbQpf8PgbGM9R8JWGSNiK1x5D6h', '02ca0c9daee0971b706b91f16be51a9caff687a8a6e9e91327ff7ba9941ffa9ae0'],
      ['XrMRZjHqccEbxFHAC5YLnkPU4mm5ykt11F', '0396eb658b83cc782d5c580a3b1c34cd4d2d95b446df1dbb12ec35c5c3ff2368b1'],
    ],
  },
  testnet: {
    registration: [
      ['yM5Wg7qxSi4sMiZuwrx37FxRdacdCyraaB', '0346d59c5e427e195065532d6237969b9fba21b978b2917a476de08ea4635452a9'],
      ['yMRA2wK887R7VWtiZZTQiSeNfiMmTbdz4W', '02e26e012bbdcf1eadddc0e84e6bef372b083ddd9c5802caeb59affb6e9de3b492'],
      ['yQ5zJTxGMQCnzfQvVad2t5uYyaNpDyQrAT', '038b9f05b4a71089d2f9846669ad51011aec7b3d749841fe7c103224879c1a7959'],
    ],
    topUp: [
      [
        ['yMRgYp4pmU3vKDneURy2wmeAzPCSpKsBbF', '0357fe070d752deda1a9917285d5aca9d061391388a4b733086bbc1b21887d1992'],
        ['ybr16yr9zB4s9EDuQnNYnTtd7CmCQ4sEr3', '02a96a29867b7e7c61e5fe563006ba6e7c018731f4b6056af6d84eb37548cddffd'],
      ],
      [
        ['yYWDezoGbVJ5EWw5WAXfmNBp8nJFSxNYR6', '024de45d054bd17e44e6a9aca93cd962b5d81c21ba4c3551172dd671cc0928355c'],
        ['yRgaV96jCESZjmK2GQKZawKnXAHqQdyDeb', '028042ebb1fbf20160f3ffa386b2c51c3163257d6220cc6e9ead46d12c15c87d40'],
      ],
    ],
    auth: [
      [
        '03a00f4853081aeb8c9debe37267303fa133bd7f6678bfb3299dfa001bfd0341db', '03280859fd14d1b8a7a75d918dd0a1bf922be5af7eff9aafa26f446ea5f16da616',
        '02cb109b54e542efbb86f3e5ba1d6a2da97d02cc4de0c706c23ab8ddb53ff7fe3e', '02711df617d984f97ad43dfb5eab5e780055f4a4dd68a1d95fe708ae1e9c9e17aa',
        '03d3c6c2629ff5c15703717a7a14c8a01b04b55dbf511cafc58d96519206f0213c', '02f521bfa606ef60d9a1b3582d9bdc6ed00c95177cd3546e3eef95e424a912795a',
      ],
      [
        '0312aa9ac813f9751da6747c4ac7798a9c5f778545788204785eafbfe287544144', '03a8150f657be60fe91fec7aefe69d655247417e9e7ab408d209261b57f798ce84',
        '03e1280783f1b2d0ed971a93ab9e1f7665e5555b1e5154201462cd33e9a7ab9a47', '02c5036f9253775c16dd64fb788e2f6ff62bc24b7785c74ad1ea011cf3fcc55a4e',
        '02025d6686712a76e128b92875b4e542f7192bdbe7c1dd8ec90fb09ce79d63111a', '03ce77cf2a2d8f1d479ede39cc827e464a10237ac5858a38d74c15443e92d23d2d',
      ],
    ],
    legacy: [
      ['yR8PUe4jSZ37A4HUtFwtLfe9WhB7braYG2', '03839936bf6d86146ad67092f3a7147d04d578a04cb10cda149fc1ba1ad7b05006'],
      ['yfSxTmSpJkWBZMaq9gEiYZ8B9hugtte5bS', '03218f69a029a4b0e8ed9eebf79de80c2a9f1ace3cdde7d011e49db78383b82fab'],
    ],
  },
};

describe('rs-platform-wallet vectors (BIP39 test phrase)', () => {
  for (const network of ['mainnet', 'testnet'] as const) {
    const v = RS_PLATFORM_WALLET[network];
    const w = SeedWallet.fromPhrase(TEST_PHRASE, network);
    const at = (path: string) => {
      const k = w.derive(path);
      return [addressOf(k.publicKey, network), bytesToHex(k.publicKey)];
    };

    it(`${network}: account-setup addresses are the IdentityRegistration pool's`, () => {
      v.registration.forEach((ref, i) => expect(at(registrationFundingPath(network, i)), `index ${i}`).toEqual(ref));
    });

    it(`${network}: top-up addresses are the IdentityTopUp { registration_index } pools'`, () => {
      v.topUp.forEach((pool, i) => pool.forEach((ref, n) => expect(at(topUpFundingPath(network, i, n)), `${i}/${n}`).toEqual(ref)));
    });

    it(`${network}: identity keys 0..5 of identities 0 and 1 are derive_identity_auth_keypair's`, () => {
      v.auth.forEach((keys, i) => keys.forEach((pub, k) => expect(bytesToHex(w.identityKey(i, k).publicKey), `${i}/${k}`).toBe(pub)));
    });

    it(`${network}: the legacy account-setup addresses are key-wallet identity_registration_path's (hardened)`, () => {
      v.legacy.forEach((ref, i) => expect(at(legacyRegistrationFundingPath(network, i)), `index ${i}`).toEqual(ref));
      // and none of them is an address the new path hands out
      const fresh = new Set(v.registration.map(([a]) => a));
      for (const [a] of v.legacy) expect(fresh.has(a)).toBe(false);
    });
  }
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
