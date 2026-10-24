// RFC 9474 Appendix A.1 (RSABSSA-SHA384-PSS-Randomized, 4096-bit key) through the client wrappers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bigIntToBytes, bytesToBigInt, fromHex, toHex } from '../src/bytes.ts';
import { blind, finalize, importIssuerKey, prepare, verify } from '../src/client.ts';
import { loadVector, modInv, rawSign, spkiOf, vectorPrivateKey } from './helpers.ts';

const v = loadVector();
const priv = vectorPrivateKey(v);
const opts = { allowedModulusBits: [4096] } as const;

afterEach(() => vi.restoreAllMocks());

describe('RFC 9474 A.1 RSABSSA-SHA384-PSS-Randomized', () => {
  it('vector sanity: prepared_msg = msg_prefix || msg', () => {
    expect(v.prepared_msg).toBe(v.msg_prefix! + v.msg!);
    expect(v.msg_prefix!.length / 2).toBe(32);
  });

  it('the production import refuses the 4096-bit vector key (2048/3072 only)', async () => {
    await expect(importIssuerKey(spkiOf(priv))).rejects.toThrow(/4096 bits not allowed/);
  });

  it('verify(sig, prepared_msg) accepts the RFC signature and rejects a flipped bit', async () => {
    const key = await importIssuerKey(spkiOf(priv), opts);
    expect(await verify(key, fromHex(v.sig!), fromHex(v.prepared_msg!))).toBe(true);
    const bad = fromHex(v.prepared_msg!);
    bad[40]! ^= 1;
    expect(await verify(key, fromHex(v.sig!), bad)).toBe(false);
  });

  it('blind() reproduces blinded_msg and inv when fed the RFC salt and blinding factor', async () => {
    const key = await importIssuerKey(spkiOf(priv), opts);
    const r = modInv(bytesToBigInt(fromHex(v.inv!)), key.n); // inv = r^-1 mod n
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

  it('a raw RSA private operation on blinded_msg gives blind_sig', () => {
    expect(toHex(rawSign(priv, fromHex(v.blinded_msg!)))).toBe(v.blind_sig);
  });

  it('finalize(blind_sig, inv) reproduces sig', async () => {
    const key = await importIssuerKey(spkiOf(priv), opts);
    expect(toHex(await finalize(key, fromHex(v.prepared_msg!), fromHex(v.blind_sig!), fromHex(v.inv!)))).toBe(v.sig);
  });

  it('prepare() yields a fresh 32-byte prefix each time', () => {
    const a = prepare(fromHex(v.msg!));
    const b = prepare(fromHex(v.msg!));
    expect(a.msgPrefix.length).toBe(32);
    expect(toHex(a.msgPrefix)).not.toBe(toHex(b.msgPrefix));
    expect(toHex(a.preparedMsg.slice(32))).toBe(v.msg);
  });
});
