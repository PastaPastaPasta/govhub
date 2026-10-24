// RFC 9474 Appendix A.1 (RSABSSA-SHA384-PSS-Randomized, 4096-bit key) through the client wrappers
// and through the Node/OpenSSL issuer.
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { constants, privateDecrypt } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bigIntToBytes, bytesToBigInt, copy, fromHex, toHex } from '../src/bytes.js';
import { blind, finalize, importIssuerKey, prepare, verify } from '../src/client.js';
import { BlindIssuer } from '../src/issuer.js';
import { loadVector, modInv, pkcs8Of, spkiOf, vectorPrivateKey } from './helpers.js';

const v = loadVector();
const priv = vectorPrivateKey(v);
const opts = { allowedModulusBits: [4096] } as const;

afterEach(() => vi.restoreAllMocks());

describe('RFC 9474 A.1 RSABSSA-SHA384-PSS-Randomized', () => {
  it('vector sanity: prepared_msg = msg_prefix || msg', () => {
    expect(v.prepared_msg).toBe(v.msg_prefix! + v.msg!);
    expect(v.msg_prefix!.length / 2).toBe(32);
  });

  it('client: verify(sig, prepared_msg) accepts the RFC signature', async () => {
    const key = await importIssuerKey(spkiOf(priv), opts);
    expect(await verify(key, fromHex(v.sig!), fromHex(v.prepared_msg!))).toBe(true);
    // negative: flipped message bit
    const bad = fromHex(v.prepared_msg!);
    bad[40]! ^= 1;
    expect(await verify(key, fromHex(v.sig!), bad)).toBe(false);
  });

  it('client: blind() reproduces blinded_msg when fed the RFC salt and blinding factor', async () => {
    const key = await importIssuerKey(spkiOf(priv), opts);
    const n = key.n;
    const r = modInv(bytesToBigInt(fromHex(v.inv!)), n); // inv = r^-1 mod n
    const queue = [fromHex(v.salt!), bigIntToBytes(r, key.modulusBytes)];
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((arr: Uint8Array) => {
      const next = queue.shift();
      if (!next || next.length !== arr.length) throw new Error(`unexpected getRandomValues(${arr.length})`);
      arr.set(next);
      return arr;
    }) as typeof crypto.getRandomValues);
    const out = await blind(key, fromHex(v.prepared_msg!));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(toHex(out.blindedMsg)).toBe(v.blinded_msg);
    expect(toHex(out.inv)).toBe(v.inv);
  });

  it('client: finalize(blind_sig, inv) reproduces sig', async () => {
    const key = await importIssuerKey(spkiOf(priv), opts);
    const sig = await finalize(key, fromHex(v.prepared_msg!), fromHex(v.blind_sig!), fromHex(v.inv!));
    expect(toHex(sig)).toBe(v.sig);
  });

  it('Node issuer: blindSign(blinded_msg) == RFC blind_sig', () => {
    const issuer = new BlindIssuer(priv, opts);
    expect(toHex(issuer.blindSign(fromHex(v.blinded_msg!)))).toBe(v.blind_sig);
  });

  it('end to end: RFC blinded_msg -> Node issuer -> client finalize -> RFC sig', async () => {
    const key = await importIssuerKey(spkiOf(priv), opts);
    const issuer = new BlindIssuer(priv, opts);
    const blindSig = issuer.blindSign(fromHex(v.blinded_msg!));
    const sig = await finalize(key, fromHex(v.prepared_msg!), blindSig, fromHex(v.inv!));
    expect(toHex(sig)).toBe(v.sig);
  });

  it("library's own blindSign (sjcl, non-CRT) matches the RFC blind_sig and the Node issuer", async () => {
    const lib = RSABSSA.SHA384.PSS.Randomized();
    const sk = await crypto.subtle.importKey('pkcs8', copy(pkcs8Of(priv)), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['sign']);
    const s = await lib.blindSign(sk, fromHex(v.blinded_msg!));
    expect(toHex(s)).toBe(v.blind_sig);
  });

  it('OpenSSL raw private op via privateDecrypt(RSA_NO_PADDING) equals blinded^d mod n', () => {
    const n = BigInt('0x' + v.n);
    const d = BigInt('0x' + v.d);
    const m = BigInt('0x' + v.blinded_msg);
    const expected = (() => {
      let result = 1n, base = m % n, exp = d;
      while (exp > 0n) {
        if (exp & 1n) result = (result * base) % n;
        base = (base * base) % n;
        exp >>= 1n;
      }
      return result;
    })();
    const out = privateDecrypt({ key: priv, padding: constants.RSA_NO_PADDING }, fromHex(v.blinded_msg!));
    expect(bytesToBigInt(new Uint8Array(out))).toBe(expected);
  });

  it('prepare() on a vector message yields a 32-byte fresh prefix each time', () => {
    const a = prepare(fromHex(v.msg!));
    const b = prepare(fromHex(v.msg!));
    expect(a.msgPrefix.length).toBe(32);
    expect(toHex(a.msgPrefix)).not.toBe(toHex(b.msgPrefix));
    expect(toHex(a.preparedMsg.slice(32))).toBe(v.msg);
  });
});
