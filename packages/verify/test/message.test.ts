import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { bytesToHex, concatBytes, dashMessageHash, decodeWif, hexToBytes, recoverMessageSigner, sha256d, signMessage, signMessageWif, utf8ToBytes, verifyMessage, MESSAGE_MAGIC, hash160, p2pkhAddress } from '../src/index.ts';
import { fixture } from './helpers.ts';

const sigs = fixture('messages.regtest.json').signatures as Array<any>;

describe('Dash signmessage format vs Core (signmessagewithprivkey / verifymessage on regtest)', () => {
  it('fixture has several keys and messages including empty and multi-byte-length messages', () => {
    expect(new Set(sigs.map((s) => s.address)).size).toBeGreaterThanOrEqual(4);
    expect(sigs.some((s) => s.message === '')).toBe(true);
    expect(sigs.some((s) => s.message.length > 252)).toBe(true);
    expect(sigs.every((s) => s.coreVerifiesOwn && !s.coreVerifiesOther)).toBe(true);
  });

  for (const s of sigs) {
    const label = `${s.address.slice(0, 6)} ${JSON.stringify(s.message.slice(0, 24))}`;
    it(`our signature is byte-identical to Core's (RFC6979 + low-S): ${label}`, () => {
      expect(signMessageWif(s.wif, s.message, 'regtest')).toBe(s.coreSigBase64);
    });
    it(`recovers Core's signer + verifies: ${label}`, () => {
      const r = recoverMessageSigner(s.coreSigBase64, s.message, 'regtest');
      expect(r?.address).toBe(s.address);
      expect(bytesToHex(r!.pubkey)).toBe(s.pubkey);
      expect(r!.compressed).toBe(true);
      expect(verifyMessage(s.address, s.coreSigBase64, s.message, 'regtest')).toBe(true);
      expect(verifyMessage(s.address, s.coreSigBase64, s.message + ' ', 'regtest')).toBe(false);
      const other = sigs.find((x) => x.address !== s.address)!;
      expect(verifyMessage(other.address, s.coreSigBase64, s.message, 'regtest')).toBe(false);
    });
  }
});

describe('message hash', () => {
  it('magic is "DarkCoin Signed Message:\\n" and both strings carry CompactSize prefixes', () => {
    expect(MESSAGE_MAGIC.length).toBe(25);
    const pre = concatBytes(Uint8Array.of(25), utf8ToBytes(MESSAGE_MAGIC), Uint8Array.of(5), utf8ToBytes('hello'));
    expect(dashMessageHash('hello')).toEqual(sha256d(pre));
    // length >= 253 switches to 0xfd + u16
    const long = 'x'.repeat(300);
    expect(dashMessageHash(long)).toEqual(sha256d(concatBytes(Uint8Array.of(25), utf8ToBytes(MESSAGE_MAGIC), Uint8Array.of(0xfd, 0x2c, 0x01), utf8ToBytes(long))));
  });
});

describe('compact signature encoding', () => {
  const key = hexToBytes('11'.repeat(32));
  it('header = 27 + recid + 4 (compressed), 27 + recid (uncompressed), always 65 bytes, low-S', () => {
    for (let i = 0; i < 40; i++) {
      const sigC = base64.decode(signMessage(key, 'm' + i));
      const sigU = base64.decode(signMessage(key, 'm' + i, { compressed: false }));
      expect(sigC.length).toBe(65);
      expect(sigC[0]! - 31).toBeGreaterThanOrEqual(0);
      expect(sigC[0]! - 31).toBeLessThanOrEqual(3);
      expect(sigU[0]! - 27).toBeGreaterThanOrEqual(0);
      expect(sigU[0]! - 27).toBeLessThanOrEqual(3);
      expect(sigC[0]! - 4).toBe(sigU[0]);
      // s <= n/2  => first byte of s < 0x80 or ... compare as bigint
      const s = BigInt('0x' + bytesToHex(sigC.subarray(33)));
      expect(s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true);
    }
  });
  it('an uncompressed-flag signature recovers a 65-byte key with a DIFFERENT key id', () => {
    const msg = 'abc';
    const c = recoverMessageSigner(signMessage(key, msg), msg, 'mainnet')!;
    const u = recoverMessageSigner(signMessage(key, msg, { compressed: false }), msg, 'mainnet')!;
    expect(c.pubkey.length).toBe(33);
    expect(u.pubkey.length).toBe(65);
    expect(c.address).not.toBe(u.address);
    expect(bytesToHex(c.keyId)).toBe(bytesToHex(hash160(c.pubkey)));
    expect(c.address).toBe(p2pkhAddress(c.keyId, 'mainnet'));
  });
  it('strict mode rejects aliased headers and high-S, default mode (like Core) accepts them', () => {
    const msg = 'abc';
    const sig = base64.decode(signMessage(key, msg));
    const alias = sig.slice();
    alias[0] = sig[0]! + 8; // (h-27)&7 unchanged => Core recovers the same key
    expect(recoverMessageSigner(alias, msg, 'mainnet')?.address).toBe(recoverMessageSigner(sig, msg, 'mainnet')?.address);
    expect(recoverMessageSigner(alias, msg, 'mainnet', { strict: true })).toBeNull();
    // high-S twin: s' = n - s, recid ^= 1 recovers the same key
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt('0x' + bytesToHex(sig.subarray(33)));
    const hs = (n - s).toString(16).padStart(64, '0');
    const twin = concatBytes(Uint8Array.of(27 + ((sig[0]! - 27) ^ 1)), sig.subarray(1, 33), hexToBytes(hs));
    expect(recoverMessageSigner(twin, msg, 'mainnet')?.address).toBe(recoverMessageSigner(sig, msg, 'mainnet')?.address);
    expect(recoverMessageSigner(twin, msg, 'mainnet', { strict: true })).toBeNull();
  });
  it('malformed signatures never throw', () => {
    expect(recoverMessageSigner('not base64!!', 'x', 'mainnet')).toBeNull();
    expect(recoverMessageSigner(new Uint8Array(64), 'x', 'mainnet')).toBeNull();
    expect(recoverMessageSigner(new Uint8Array(65), 'x', 'mainnet')).toBeNull();
    expect(recoverMessageSigner(concatBytes(Uint8Array.of(31), new Uint8Array(64).fill(255)), 'x', 'mainnet')).toBeNull();
    expect(verifyMessage('garbage', 'AAAA', 'x', 'mainnet')).toBe(false);
  });
  it('WIF decode matches the fixture keys', () => {
    const s = sigs[0];
    const { privKey, compressed } = decodeWif(s.wif, 'regtest');
    expect(compressed).toBe(true);
    expect(privKey.length).toBe(32);
  });
});
