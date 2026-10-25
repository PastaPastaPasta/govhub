// `issuer revoke`: what it publishes is what readers apply (packages/badge acceptIssuerKey), a dry run publishes nothing, an existing
// revocation is reported (already in force, or a conflict that cannot be replaced: the squatting case of README "Revoking a key").
import { describe, expect, it } from 'vitest';
import { acceptIssuerKey, bytesToId, EPOCH_PARAMS, epochStart, idToBytes, sha256, toHex, VARIANT, type IssuerKeyDoc, type IssuerRevocationDoc } from '@govhub/badge';
import type { IssuerPlatform } from '../src/platform.ts';
import { parseEpochRange, revokeEpochs } from '../src/revoke.ts';
import { generateIssuerKey } from '../src/signer.ts';
import { rnd } from './helpers.ts';

const P = EPOCH_PARAMS.testnet;
const E = 2742;
const ISSUER = bytesToId(rnd(32));
const KEY = { identityId: ISSUER, keyId: 1, privateKeyHex: '11'.repeat(32) };

async function fakePlatform() {
  const { spki } = generateIssuerKey(2048);
  const keys = new Map<number, IssuerKeyDoc>();
  for (const e of [E, E + 1]) keys.set(e, { ownerId: idToBytes(ISSUER), epoch: e, spki, keyId: await sha256(spki), variant: VARIANT, createdAtCoreBlockHeight: epochStart(P, e - 1) - 10 });
  const revocations = new Map<number, IssuerRevocationDoc>();
  const published: Array<{ epoch: number; keyId: string; effectiveCoreHeight: number }> = [];
  const platform: Pick<IssuerPlatform, 'issuerKey' | 'issuerRevocation' | 'publishIssuerRevocation'> = {
    issuerKey: async (_i, e) => keys.get(e) ?? null,
    issuerRevocation: async (_i, e) => revocations.get(e) ?? null,
    publishIssuerRevocation: async (k, o) => {
      if (revocations.has(o.epoch)) throw new Error('duplicate unique index');
      expect(k.keyId).toBe(1);
      published.push({ epoch: o.epoch, keyId: toHex(o.keyId), effectiveCoreHeight: o.effectiveCoreHeight });
      revocations.set(o.epoch, { ownerId: idToBytes(k.identityId), epoch: o.epoch, keyId: o.keyId, effectiveCoreHeight: o.effectiveCoreHeight, createdAtCoreBlockHeight: epochStart(P, E) + 50 });
      return `rev-${o.epoch}`;
    },
  };
  return { platform, keys, revocations, published };
}

describe('issuer revoke', () => {
  it('publishes a revocation per epoch that readers apply from the given height; a dry run publishes nothing', async () => {
    const f = await fakePlatform();
    const H = epochStart(P, E) + 40;
    const dry = await revokeEpochs(f.platform, KEY, { epochs: parseEpochRange(E, E + 2), fromHeight: H, publish: false });
    expect(dry.map((r) => r.status)).toEqual(['would publish', 'would publish', 'would publish']);
    expect(f.published).toEqual([]);

    const res = await revokeEpochs(f.platform, KEY, { epochs: parseEpochRange(E, E + 2), fromHeight: H, publish: true });
    expect(res.map((r) => [r.epoch, r.status])).toEqual([
      [E, 'published'],
      [E + 1, 'published'],
      [E + 2, 'published'],
    ]);
    expect(f.published[0]).toEqual({ epoch: E, keyId: toHex(f.keys.get(E)!.keyId), effectiveCoreHeight: H });
    // an epoch without a key is revoked with a zero keyId: readers match a revocation by (issuer, epoch) only
    expect(res[2]).toMatchObject({ keyId: '00'.repeat(32), note: expect.stringMatching(/no issuerKey/) });

    // the reader rules: the key is accepted with revokedFrom = H, so badges created at or after H are void
    const cfg = { net: 'testnet' as const, contractId: rnd(32) };
    const accepted = await acceptIssuerKey(cfg, { issuerId: idToBytes(ISSUER), epoch: E }, f.keys.get(E)!, f.revocations.get(E)!);
    expect(accepted.ok && accepted.value.revokedFrom).toBe(H);
  });

  it('an existing revocation is reported: in force when at or below the height, a conflict (exit 3) when later', async () => {
    const f = await fakePlatform();
    await revokeEpochs(f.platform, KEY, { epochs: [E], fromHeight: 1000, publish: true });
    // someone holding the CRITICAL key squatted E+1 with a revocation that never takes effect
    f.revocations.set(E + 1, { ownerId: idToBytes(ISSUER), epoch: E + 1, keyId: f.keys.get(E + 1)!.keyId, effectiveCoreHeight: 0xffffffff, createdAtCoreBlockHeight: 5 });
    const res = await revokeEpochs(f.platform, KEY, { epochs: [E, E + 1], fromHeight: 2000, publish: true });
    expect(res[0]).toMatchObject({ status: 'already revoked', effectiveCoreHeight: 1000 });
    expect(res[1]).toMatchObject({ status: 'conflict', effectiveCoreHeight: 0xffffffff, note: expect.stringMatching(/cannot be replaced/) });
    expect(f.published).toHaveLength(1);
  });

  it('a failed publish stops the run but keeps the epochs already published in the report', async () => {
    const f = await fakePlatform();
    const publish = f.platform.publishIssuerRevocation;
    f.platform.publishIssuerRevocation = async (k, o) => (o.epoch === E + 1 ? Promise.reject(new Error('nonce already present')) : publish(k, o));
    const res = await revokeEpochs(f.platform, KEY, { epochs: parseEpochRange(E, E + 2), fromHeight: 1000, publish: true });
    expect(res.map((r) => [r.epoch, r.status])).toEqual([
      [E, 'published'],
      [E + 1, 'error'],
    ]);
    expect(res[1]!.note).toMatch(/nonce already present/);
    f.platform.publishIssuerRevocation = publish;
    const again = await revokeEpochs(f.platform, KEY, { epochs: parseEpochRange(E, E + 2), fromHeight: 1000, publish: true });
    expect(again.map((r) => r.status)).toEqual(['already revoked', 'published', 'published']);
  });

  it('validates the epoch range and the height', async () => {
    expect(parseEpochRange(E, undefined)).toEqual([E]);
    expect(() => parseEpochRange(E, E - 1)).toThrow(/--through/);
    expect(() => parseEpochRange(0, undefined)).toThrow(/--epoch/);
    expect(() => parseEpochRange(E, E + 64)).toThrow(/at most 64/);
    const f = await fakePlatform();
    await expect(revokeEpochs(f.platform, KEY, { epochs: [E], fromHeight: -1, publish: true })).rejects.toThrow(/--from-height/);
    await expect(revokeEpochs(f.platform, KEY, { epochs: [E], fromHeight: 2 ** 32, publish: true })).rejects.toThrow(/--from-height/);
  });
});
