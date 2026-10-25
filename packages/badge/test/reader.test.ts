// Reader rules (PLAN §8.6) on documents as a proved query would return them.
import { beforeAll, describe, expect, it } from 'vitest';
import { bytesToBase64, bytesToId, concat, sha256 } from '../src/bytes.ts';
import { VARIANT } from '../src/client.ts';
import { parseIssuerKeyDoc, parseMnBadgeDoc } from '../src/docs.ts';
import { EPOCH_PARAMS, epochStart } from '../src/epoch.ts';
import { acceptIssuerKey, verifyMnBadge, type IssuerKeyDoc, type MnBadgeDoc, type ReaderConfig } from '../src/reader.ts';
import { issueBadge, rnd, testKey } from './helpers.ts';

const T = EPOCH_PARAMS.testnet;
const E = 2742;
const cfg: ReaderConfig = { net: 'testnet', contractId: rnd(32) };
const issuerId = rnd(32);
const S = (e: number) => epochStart(T, e);

describe('reader rules', () => {
  let k: Awaited<ReturnType<typeof testKey>>;
  let keyDoc: IssuerKeyDoc;
  let badge: MnBadgeDoc;
  const now = S(E) + 100;

  beforeAll(async () => {
    k = await testKey(2048);
    keyDoc = { ownerId: issuerId, epoch: E, spki: k.spki, keyId: await sha256(k.spki), variant: VARIANT, createdAtCoreBlockHeight: S(E - 1) - 1 };
    const ownerId = rnd(32);
    const b = await issueBadge(k, { net: 'testnet', contractId: cfg.contractId, issuerId, epoch: E, ownerId });
    badge = { ownerId, issuerId, epoch: E, keyId: keyDoc.keyId, msgPrefix: b.msgPrefix, sig: b.sig, createdAtCoreBlockHeight: S(E) + 10 };
  });

  const accept = (over: Partial<IssuerKeyDoc> = {}, rev: Parameters<typeof acceptIssuerKey>[3] = null) => acceptIssuerKey(cfg, { issuerId, epoch: E }, { ...keyDoc, ...over }, rev);
  const verdict = async (over: Partial<MnBadgeDoc> = {}, at = now, keyOver: Partial<IssuerKeyDoc> = {}, rev: Parameters<typeof acceptIssuerKey>[3] = null) => {
    const a = await accept(keyOver, rev);
    if (!a.ok) return a;
    return verifyMnBadge(cfg, a.value, { ...badge, ...over }, at);
  };

  it('accepts a valid key and badge', async () => {
    expect((await accept()).ok).toBe(true);
    expect(await verdict()).toEqual({ ok: true, value: { epoch: E } });
  });

  it('key: must exist, be the trusted issuer, the right epoch, the variant, hashed, early, canonical', async () => {
    expect((await acceptIssuerKey(cfg, { issuerId, epoch: E }, null)).ok).toBe(false);
    expect((await accept({ ownerId: rnd(32) })).ok).toBe(false);
    expect((await accept({ epoch: E + 1 })).ok).toBe(false);
    expect((await accept({ variant: 'RSABSSA-SHA384-PSS-Deterministic' })).ok).toBe(false);
    expect((await accept({ keyId: rnd(32) })).ok).toBe(false);
    expect((await accept({ createdAtCoreBlockHeight: S(E + 1) - T.boundaryMarginBlocks })).ok).toBe(false); // not strictly before the bound
    expect((await accept({ createdAtCoreBlockHeight: S(E + 1) })).ok).toBe(false);
    expect((await accept({ createdAtCoreBlockHeight: S(E + 1) + T.graceBlocks })).ok).toBe(false);
    const nc = concat(k.spki, Uint8Array.of(0));
    expect((await accept({ spki: nc, keyId: await sha256(nc) })).ok).toBe(false);
  });

  it('key: published mid-window (after S(E-1), even during E) is accepted, up to S(E+1) - margin', async () => {
    for (const h of [S(E - 1), S(E - 1) + 1, S(E), S(E) + 200, S(E + 1) - T.boundaryMarginBlocks - 1]) {
      const a = await accept({ createdAtCoreBlockHeight: h });
      expect(a.ok, `key at ${h}`).toBe(true);
      expect(a.ok && a.value.keyCreatedAt).toBe(h);
    }
    // a badge made after a mid-epoch key verifies (Standard mode, posted at once)
    expect((await verdict({ createdAtCoreBlockHeight: S(E) + 200 }, now + 200, { createdAtCoreBlockHeight: S(E) + 150 })).ok).toBe(true);
  });

  it('key: two issuerKey documents for one epoch (impossible under the unique index) are refused', async () => {
    const other = await testKey(2048);
    const second: IssuerKeyDoc = { ...keyDoc, spki: other.spki, keyId: await sha256(other.spki), createdAtCoreBlockHeight: S(E) + 5 };
    expect(await acceptIssuerKey(cfg, { issuerId, epoch: E }, [keyDoc, second])).toEqual({ ok: false, reason: 'more than one issuerKey for this epoch' });
    expect(await acceptIssuerKey(cfg, { issuerId, epoch: E }, [keyDoc, keyDoc])).toMatchObject({ ok: false });
    expect((await acceptIssuerKey(cfg, { issuerId, epoch: E }, [keyDoc])).ok).toBe(true);
    expect((await acceptIssuerKey(cfg, { issuerId, epoch: E }, [])).ok).toBe(false);
  });

  it('badge: never older than its key', async () => {
    const keyAt = S(E) + 50;
    expect(await verdict({ createdAtCoreBlockHeight: keyAt - 1 }, now, { createdAtCoreBlockHeight: keyAt })).toEqual({ ok: false, reason: 'badge created before its issuerKey' });
    expect((await verdict({ createdAtCoreBlockHeight: keyAt }, now, { createdAtCoreBlockHeight: keyAt })).ok).toBe(true); // same core height
    expect((await verdict({ createdAtCoreBlockHeight: keyAt + 1 }, now, { createdAtCoreBlockHeight: keyAt })).ok).toBe(true);
  });

  it('badge: issuer, epoch and keyId must match the accepted key', async () => {
    expect((await verdict({ issuerId: rnd(32) })).ok).toBe(false);
    expect((await verdict({ epoch: E + 1 })).ok).toBe(false);
    expect((await verdict({ keyId: rnd(32) })).ok).toBe(false);
  });

  it('badge: copied to another identity fails (message rebuilt with $ownerId)', async () => {
    expect(await verdict({ ownerId: rnd(32) })).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('badge: tampered prefix / signature fail', async () => {
    const p = badge.msgPrefix.slice();
    p[0]! ^= 1;
    expect((await verdict({ msgPrefix: p })).ok).toBe(false);
    const s = badge.sig.slice();
    s[5]! ^= 1;
    expect((await verdict({ sig: s })).ok).toBe(false);
  });

  it('badge height: not before S(E), not after S(E+1)+W', async () => {
    expect((await verdict({ createdAtCoreBlockHeight: S(E) - 1 })).ok).toBe(false);
    expect((await verdict({ createdAtCoreBlockHeight: S(E) })).ok).toBe(true);
    expect((await verdict({ createdAtCoreBlockHeight: S(E + 1) + T.graceBlocks }, S(E + 1) + T.graceBlocks)).ok).toBe(true);
    expect((await verdict({ createdAtCoreBlockHeight: S(E + 1) + T.graceBlocks + 1 }, S(E + 1) + T.graceBlocks + 1)).ok).toBe(false);
  });

  it('display: shown only while S(E) <= now <= S(E+1)+W', async () => {
    expect((await verdict({}, S(E + 1) + T.graceBlocks)).ok).toBe(true);
    expect((await verdict({}, S(E + 1) + T.graceBlocks + 1)).ok).toBe(false);
    expect((await verdict({}, S(E) - 1)).ok).toBe(false);
  });

  it('revocation voids badges created at or after its effective height', async () => {
    const rev = (h: number) => ({ ownerId: issuerId, epoch: E, keyId: keyDoc.keyId, effectiveCoreHeight: h, createdAtCoreBlockHeight: h });
    expect((await verdict({}, now, {}, rev(badge.createdAtCoreBlockHeight + 1))).ok).toBe(true);
    expect((await verdict({}, now, {}, rev(badge.createdAtCoreBlockHeight))).ok).toBe(false);
    expect((await accept({}, { ...rev(1), ownerId: rnd(32) })).ok).toBe(false);
  });

  it('parses the JSON shape evo-sdk returns (base64 bytes, base58 identifiers)', async () => {
    const json = {
      $ownerId: bytesToId(badge.ownerId),
      $createdAtCoreBlockHeight: badge.createdAtCoreBlockHeight,
      issuerId: bytesToId(issuerId),
      epoch: E,
      keyId: bytesToBase64(badge.keyId),
      msgPrefix: bytesToBase64(badge.msgPrefix),
      sig: bytesToBase64(badge.sig),
    };
    expect(parseMnBadgeDoc(json)).toEqual(badge);
    expect(() => parseMnBadgeDoc({ ...json, sig: bytesToBase64(rnd(255)) })).toThrow();
    expect(() => parseMnBadgeDoc({ ...json, epoch: -1 })).toThrow();
    const kj = { $ownerId: bytesToId(issuerId), $createdAtCoreBlockHeight: keyDoc.createdAtCoreBlockHeight, epoch: E, spki: bytesToBase64(k.spki), keyId: bytesToBase64(keyDoc.keyId), variant: VARIANT };
    expect(parseIssuerKeyDoc(kj)).toEqual(keyDoc);
  });
});
