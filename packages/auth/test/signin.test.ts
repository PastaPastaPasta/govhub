import { describe, expect, it } from 'vitest';
import { bytesToHex, randomBytes, toBase58 } from '../src/bytes.ts';
import { KeyInputError, KeyPurpose, KeyType, parsePrivateKey, SecurityLevel, wifOf } from '../src/keys.ts';
import { SeedWallet } from '../src/seed.ts';
import { discoverIdentities, findKeyIdentities, pickSeedKey, signInWithKey, signInWithKeyBytes, signInWithSeed, SignInError } from '../src/signin.ts';
import { FakePlatform } from './fake-platform.ts';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const A = SecurityLevel;
const P = KeyPurpose.AUTHENTICATION;
const id = () => toBase58(randomBytes(32));

function govhubIdentity(fp: FakePlatform, w: SeedWallet, identityIndex: number): string {
  const i = id();
  fp.addIdentity(i, [0, 1, 2].map((k) => ({ id: k, purpose: P, securityLevel: [A.MASTER, A.CRITICAL, A.HIGH][k]!, priv: w.identityKey(identityIndex, k).privateKey })));
  return i;
}

describe('seed discovery', () => {
  it('finds identities by key-0 hash with a gap of 5 (DashPay / Yappr), across a gap', async () => {
    const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
    const fp = new FakePlatform();
    const i0 = govhubIdentity(fp, w, 0);
    const i3 = govhubIdentity(fp, w, 3);
    const found = await discoverIdentities(w, fp);
    expect(found).toEqual([
      { identityIndex: 0, identityId: i0 },
      { identityIndex: 3, identityId: i3 },
    ]);
    expect(fp.lookups).toBe(4 + 5); // indexes 0..8: two hits, then five misses after index 3
  });

  it('signs in with the HIGH key, never MASTER', async () => {
    const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
    const fp = new FakePlatform();
    const i0 = govhubIdentity(fp, w, 0);
    const s = await signInWithSeed(w, { identityIndex: 0, identityId: i0 }, fp);
    expect(s.keyId).toBe(2);
    expect(s.securityLevel).toBe(A.HIGH);
    expect(bytesToHex(s.privateKey)).toBe(bytesToHex(w.identityKey(0, 2).privateKey));
    s.end();
    expect(s.privateKey.every((b) => b === 0)).toBe(true);
    expect(w.wiped).toBe(true);
  });

  it('falls back to CRITICAL, and probes key indexes 0..11 when ids differ from indexes (Evo Tool layouts)', () => {
    const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
    const fp = new FakePlatform();
    const i = id();
    // HIGH key disabled; CRITICAL registered under id 7 but derived at index 9
    fp.addIdentity(i, [
      { id: 0, purpose: P, securityLevel: A.MASTER, priv: w.identityKey(0, 0).privateKey },
      { id: 2, purpose: P, securityLevel: A.HIGH, priv: w.identityKey(0, 2).privateKey, disabled: true },
      { id: 7, purpose: P, securityLevel: A.CRITICAL, priv: w.identityKey(0, 9).privateKey },
    ]);
    const picked = pickSeedKey(w, 0, fp.identities.get(i)!);
    expect(picked?.key.id).toBe(7);
    expect(bytesToHex(picked!.privateKey)).toBe(bytesToHex(w.identityKey(0, 9).privateKey));
  });

  it('refuses a seed that holds only the MASTER key', async () => {
    const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
    const fp = new FakePlatform();
    const i = id();
    fp.addIdentity(i, [
      { id: 0, purpose: P, securityLevel: A.MASTER, priv: w.identityKey(0, 0).privateKey },
      { id: 2, purpose: P, securityLevel: A.HIGH, priv: randomBytes(32).fill(7) },
    ]);
    await expect(signInWithSeed(w, { identityIndex: 0, identityId: i }, fp)).rejects.toThrow(SignInError);
  });

  it('ignores contract-bound, non-auth and HASH160-typed keys appropriately', () => {
    const w = SeedWallet.fromPhrase(PHRASE, 'testnet');
    const fp = new FakePlatform();
    const i = id();
    fp.addIdentity(i, [
      { id: 2, purpose: P, securityLevel: A.HIGH, priv: w.identityKey(0, 2).privateKey, bound: true },
      { id: 3, purpose: KeyPurpose.TRANSFER, securityLevel: A.CRITICAL, priv: w.identityKey(0, 3).privateKey },
      { id: 1, purpose: P, securityLevel: A.CRITICAL, priv: w.identityKey(0, 1).privateKey, type: KeyType.ECDSA_HASH160 },
    ]);
    expect(pickSeedKey(w, 0, fp.identities.get(i)!)?.key.id).toBe(1);
  });
});

describe('key paste', () => {
  const priv = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const fp = new FakePlatform();
  const i = id();
  const master = Uint8Array.from({ length: 32 }, (_, k) => k + 100);
  fp.addIdentity(i, [
    { id: 0, purpose: P, securityLevel: A.MASTER, priv: master },
    { id: 2, purpose: P, securityLevel: A.HIGH, priv },
  ]);

  it('accepts WIF and hex for the HIGH key', async () => {
    for (const input of [wifOf(priv, 'testnet'), bytesToHex(priv), `0x${bytesToHex(priv)}`, `  ${wifOf(priv, 'testnet')}\n`]) {
      const s = await signInWithKey(input, fp);
      expect(s.identityId).toBe(i);
      expect(s.keyId).toBe(2);
      expect(s.wallet).toBeNull();
    }
  });

  it('refuses a mainnet WIF on testnet without echoing it, and a MASTER key with advice', async () => {
    const wif = wifOf(priv, 'mainnet');
    let msg = '';
    try {
      parsePrivateKey(wif, 'testnet');
    } catch (e) {
      expect(e).toBeInstanceOf(KeyInputError);
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/mainnet/);
    expect(msg).not.toContain(wif);
    await expect(findKeyIdentities(master, fp)).rejects.toThrow(/MASTER key/);
    await expect(signInWithKey('not a key', fp)).rejects.toThrow(KeyInputError);
    await expect(signInWithKey('00'.repeat(32), fp)).rejects.toThrow(/valid/);
  });

  it('signs in from key bytes, which the session owns (wiped on failure), keeping the source and passkey credential', async () => {
    const cred = new Uint8Array(16).fill(5);
    const key = priv.slice();
    const s = await signInWithKeyBytes(key, fp, undefined, 'passkey', cred);
    expect(s).toMatchObject({ identityId: i, keyId: 2, source: 'passkey', credentialId: cred });
    expect(s.privateKey).toBe(key);
    const bad = master.slice();
    await expect(signInWithKeyBytes(bad, fp)).rejects.toThrow(/MASTER key/);
    expect(bad.every((b) => b === 0)).toBe(true);
  });
});
