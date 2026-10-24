import { describe, expect, it } from 'vitest';
import { bytesToHex, concatBytes, identifierBytes, randomBytes, toBase58 } from '../src/bytes.ts';
import { KeyPurpose, KeyType, SecurityLevel } from '../src/keys.ts';
import { SeedWallet } from '../src/seed.ts';
import { makeSession, signInWithSeed } from '../src/signin.ts';
import {
  BUNDLE_LENGTH, BundleFormat, decodeBundle, encodeBundle, entryAad, hpkeInfo, openEntry, prfInput, recipientFromPrf, SEALED_LENGTH, sealEntry, VaultCryptoError,
  type VaultBundle,
} from '../src/vault/bundle.ts';
import { openVault, storeInVault } from '../src/vault/service.ts';
import { parseUserHandle, userHandleFor } from '../src/vault/webauthn.ts';
import { FakePlatform } from './fake-platform.ts';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';
const contract = randomBytes(32);
const contractId = toBase58(contract);
const owner = randomBytes(32);
const ownerId = toBase58(owner);
const cred = randomBytes(20);
const prf = randomBytes(32);
const recipient = recipientFromPrf(prf).publicKey;
const P = KeyPurpose.AUTHENTICATION;
const L = SecurityLevel;

const keyBundle = (level: number = L.HIGH, keyId = 2, purpose: number = P): VaultBundle => ({
  format: BundleFormat.KEY,
  key: { keyId, purpose, securityLevel: level, keyType: KeyType.ECDSA_SECP256K1, privateKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1) },
});

describe('bundle encoding', () => {
  it('pads every format to the same length (the chain cannot tell them apart)', () => {
    const seed: VaultBundle = { format: BundleFormat.SEED, identityIndex: 3, entropy: randomBytes(16) };
    const votes: VaultBundle = { format: BundleFormat.VOTING_KEYS, keys: [randomBytes(32).fill(5), randomBytes(32).fill(6)] };
    for (const b of [seed, keyBundle(), votes]) {
      const e = encodeBundle(b);
      expect(e.length).toBe(BUNDLE_LENGTH);
      expect(decodeBundle(e, 2)).toEqual(b);
    }
  });

  it('never stores MASTER, TRANSFER or MEDIUM keys, nor a key that is not the entry key id', () => {
    expect(() => encodeBundle(keyBundle(L.MASTER, 0))).toThrow(VaultCryptoError);
    expect(() => encodeBundle(keyBundle(L.CRITICAL, 3, KeyPurpose.TRANSFER))).toThrow(VaultCryptoError);
    expect(() => encodeBundle(keyBundle(L.MEDIUM))).toThrow(VaultCryptoError);
    const e = encodeBundle(keyBundle());
    expect(() => decodeBundle(e, 1)).toThrow(/key id/);
    const forged = e.slice();
    forged[3] = L.MASTER;
    expect(() => decodeBundle(forged, 2)).toThrow(VaultCryptoError);
  });

  it('refuses non-zero padding, unknown formats, bad entropy lengths and too many voting keys', () => {
    const e = encodeBundle({ format: BundleFormat.SEED, identityIndex: 0, entropy: randomBytes(16) });
    const pad = e.slice();
    pad[200] = 1;
    expect(() => decodeBundle(pad, 2)).toThrow(/padding/);
    const fmt = e.slice();
    fmt[0] = 9;
    expect(() => decodeBundle(fmt, 2)).toThrow(/format/);
    const len = e.slice();
    len[1] = 20;
    expect(() => decodeBundle(len, 2)).toThrow(/entropy/);
    expect(() => encodeBundle({ format: BundleFormat.VOTING_KEYS, keys: Array.from({ length: 8 }, (_, i) => randomBytes(32).fill(i + 1)) })).toThrow();
  });
});

describe('seal and open', () => {
  const sealed = () => sealEntry({ contractId: contract, ownerId: owner, credentialId: cred, recipientKey: recipient, authKeyId: 2, bundle: keyBundle() });

  it('round-trips, with the sealed size the contract allows', () => {
    const s = sealed();
    expect(s.sealed.length).toBe(SEALED_LENGTH);
    expect(s.sealed.length).toBeLessThanOrEqual(256);
    expect(s.enc.length).toBe(32);
    expect(openEntry({ contractId: contract, ownerId: owner, entry: s, prfOutput: prf })).toEqual(keyBundle());
  });

  it('refuses another passkey before decrypting, and any change to contract, owner, credential, key id, recipient or ciphertext', () => {
    const s = sealed();
    expect(() => openEntry({ contractId: contract, ownerId: owner, entry: s, prfOutput: randomBytes(32) })).toThrow(/does not open/);
    expect(() => openEntry({ contractId: randomBytes(32), ownerId: owner, entry: s, prfOutput: prf })).toThrow(/decrypt/);
    expect(() => openEntry({ contractId: contract, ownerId: randomBytes(32), entry: s, prfOutput: prf })).toThrow(/decrypt/);
    expect(() => openEntry({ contractId: contract, ownerId: owner, entry: { ...s, credentialId: randomBytes(20) }, prfOutput: prf })).toThrow(/decrypt/);
    expect(() => openEntry({ contractId: contract, ownerId: owner, entry: { ...s, authKeyId: 1 }, prfOutput: prf })).toThrow(/decrypt/);
    const flipped = s.sealed.slice();
    flipped[10]! ^= 1;
    expect(() => openEntry({ contractId: contract, ownerId: owner, entry: { ...s, sealed: flipped }, prfOutput: prf })).toThrow(/decrypt/);
    expect(() => openEntry({ contractId: contract, ownerId: owner, entry: { ...s, version: 2 }, prfOutput: prf })).toThrow(/version/);
  });

  it('pins the labels (a change orphans every stored entry)', () => {
    expect(new TextDecoder().decode(prfInput(contract).subarray(0, 19))).toBe('govhub/vault/v1/prf');
    expect(bytesToHex(hpkeInfo(contract, owner))).toBe(bytesToHex(concatBytes(new TextEncoder().encode('govhub/vault/v1'), Uint8Array.of(0), contract, owner)));
    const aad = entryAad({ version: 1, credentialId: cred, recipientKey: recipient, authKeyId: 2 });
    expect(bytesToHex(aad.subarray(0, 8))).toBe(bytesToHex(concatBytes(new TextEncoder().encode('vault'), Uint8Array.of(0, 1, cred.length))));
  });

  it('a fixed vector stays stable', () => {
    const fixed = sealEntry({
      contractId: new Uint8Array(32).fill(1), ownerId: new Uint8Array(32).fill(2), credentialId: new Uint8Array(16).fill(3),
      recipientKey: recipientFromPrf(new Uint8Array(32).fill(4)).publicKey, authKeyId: 2, bundle: keyBundle(), ephemeralIkm: new Uint8Array(32).fill(5),
    });
    expect({ enc: bytesToHex(fixed.enc), sealedHead: bytesToHex(fixed.sealed.subarray(0, 16)), tag: bytesToHex(fixed.sealed.subarray(-16)) }).toMatchSnapshot();
  });
});

describe('vault service: the chain check', () => {
  function setup() {
    const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
    const fp = new FakePlatform();
    fp.addIdentity(ownerId, [0, 1, 2].map((k) => ({ id: k, purpose: P, securityLevel: [L.MASTER, L.CRITICAL, L.HIGH][k]!, priv: w.identityKey(0, k).privateKey })));
    return { w, fp, ctx: { platform: fp, contractId } };
  }
  const assertion = (handle = userHandleFor(ownerId, contractId)) => ({ credentialId: cred, userHandle: handle, prfOutput: prf });

  it('stores a seed session and opens it back into a session with the HIGH key', async () => {
    const { w, fp, ctx } = setup();
    const s = await signInWithSeed(w, { identityIndex: 0, identityId: ownerId }, fp);
    await storeInVault(ctx, s, cred, recipient);
    expect(fp.vaultDocs).toHaveLength(1);
    const back = await openVault(ctx, assertion());
    expect(back.source).toBe('passkey');
    expect(back.keyId).toBe(2);
    expect(back.wallet?.phrase()).toBe(PHRASE);
    expect(bytesToHex(back.privateKey)).toBe(bytesToHex(s.privateKey));
  });

  it('stores a key session as a KEY bundle (no seed) and replaces the entry on a second store', async () => {
    const { w, fp, ctx } = setup();
    const s = makeSession({ network: 'testnet', identityId: ownerId, identityIndex: null, keyId: 2, securityLevel: L.HIGH, source: 'key', privateKey: w.identityKey(0, 2).privateKey, wallet: null });
    await storeInVault(ctx, s, cred, recipient);
    await storeInVault(ctx, s, cred, recipient);
    expect(fp.vaultDocs).toHaveLength(1);
    expect(fp.vaultDocs[0]!.revision).toBe(2);
    const back = await openVault(ctx, assertion());
    expect(back.wallet).toBeNull();
    expect(back.keyId).toBe(2);
  });

  it('refuses a planted entry: a bundle that opens but holds keys the owner does not have', async () => {
    const { fp, ctx } = setup();
    const attacker = SeedWallet.fromPhrase('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'testnet');
    const planted = sealEntry({ contractId: contract, ownerId: owner, credentialId: cred, recipientKey: recipient, authKeyId: 2, bundle: { format: BundleFormat.SEED, identityIndex: 0, entropy: attacker.entropy() } });
    fp.vaultDocs.push({ ...planted, id: 'x', ownerId, revision: 1 });
    await expect(openVault(ctx, assertion())).rejects.toThrow(/doesn't control/);
    const plantedKey = sealEntry({ contractId: contract, ownerId: owner, credentialId: cred, recipientKey: recipient, authKeyId: 2, bundle: keyBundle() });
    fp.vaultDocs = [{ ...plantedKey, id: 'y', ownerId, revision: 1 }];
    await expect(openVault(ctx, assertion())).rejects.toThrow(/isn't an active key/);
  });

  it('refuses a passkey from another vault or with no handle', async () => {
    const { ctx } = setup();
    await expect(openVault(ctx, assertion(userHandleFor(ownerId, toBase58(randomBytes(32)))))).rejects.toThrow(/this network/);
    await expect(openVault(ctx, { ...assertion(), userHandle: null })).rejects.toThrow(/govhub passkey/);
    expect(parseUserHandle(userHandleFor(ownerId, contractId), contractId).identityId).toBe(ownerId);
    expect(identifierBytes(ownerId)).toHaveLength(32);
  });
});
