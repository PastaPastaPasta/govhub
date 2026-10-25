// Epoch housekeeping: key loading against the proved issuerKey, staged-key limit, key destruction, record deletion, reports.
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { epochStart, keyDeadline, sha256, VARIANT, type IssuerKeyDoc } from '@govhub/badge';
import { openTokenStore } from '../src/db.ts';
import { EpochManager } from '../src/epochs.ts';
import { keyFileName, keygen, manifestSpki } from '../src/keys.ts';
import type { IssuerPlatform } from '../src/platform.ts';
import { MnLists } from '../src/core.ts';
import { E, FakeCore, P, rnd } from './helpers.ts';

const ISSUER = 'H62hSf5TpKbUSMov85GMhPQahZDbqsTipeoBsYPgveUH';

async function setup(epochs: number[], o: { lateDoc?: boolean; maxStaged?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'issuer-keys-'));
  const manifest = await keygen(dir, Math.min(...epochs), Math.max(...epochs) - Math.min(...epochs) + 1, 2048);
  const docs = new Map<number, IssuerKeyDoc>();
  for (const m of manifest) {
    const spki = manifestSpki(m);
    docs.set(m.epoch, { ownerId: rnd(32), epoch: m.epoch, spki, keyId: await sha256(spki), variant: VARIANT, createdAtCoreBlockHeight: o.lateDoc ? keyDeadline(P, m.epoch) : 1 });
  }
  const reports: Array<{ epoch: number; tokensIssued: number }> = [];
  const core = new FakeCore();
  const ctl: { platformHeight: number | null } = { platformHeight: null };
  const platform: IssuerPlatform = {
    issuerKey: async (_i, e) => docs.get(e) ?? null,
    issuerReport: async () => null,
    issuerRevocation: async () => null,
    coreHeight: async () => ctl.platformHeight ?? core.tip,
    publishIssuerKey: async () => 'x',
    publishIssuerReport: async (_k, r) => (reports.push(r), `report-${r.epoch}`),
    publishIssuerRevocation: async () => 'x',
  };
  const store = openTokenStore(':memory:');
  store.markStarted(0);
  const m = new EpochManager({ params: P, issuerId: ISSUER, keyDir: dir, maxStagedKeys: o.maxStaged ?? 1, core, lists: new MnLists(core), store, platform: () => platform, reportKey: { identityId: ISSUER, keyId: 2, privateKeyHex: '11'.repeat(32) } });
  return {
    dir, docs, core, store, m, reports,
    get platformHeight() { return ctl.platformHeight; },
    set platformHeight(v: number | null) { ctl.platformHeight = v; },
  };
}

describe('epoch manager', () => {
  it('loads the key for the issuing epoch when it matches the proved issuerKey', async () => {
    const t = await setup([E, E + 1]);
    await t.m.tick();
    // issuing E-1 (current: no key for it here) and E (next)
    expect(t.m.status).toMatchObject({ issuingEpochs: [E - 1, E], ready: true });
    expect(t.m.status.problem).toMatch(/no key file for epoch/);
    expect(t.m.activeKey(E)?.epoch).toBe(E);
    expect(t.m.activeKey(E + 1)).toBeNull();
    expect(t.m.activeKey(E - 1)).toBeNull();
  });

  it('refuses a key that differs from the published SPKI, a late issuerKey, or a missing one', async () => {
    const a = await setup([E]);
    a.docs.get(E)!.spki = manifestSpki((await keygen(mkdtempSync(join(tmpdir(), 'k-')), 1, 1, 2048))[0]!);
    a.docs.get(E)!.keyId = await sha256(a.docs.get(E)!.spki);
    await a.m.tick();
    expect(a.m.status.ready).toBe(false);
    expect(a.m.status.problem).toMatch(/published SPKI/);
    const b = await setup([E], { lateDoc: true });
    await b.m.tick();
    expect(b.m.status.problem).toMatch(/too late/);
    const c = await setup([E]);
    c.docs.clear();
    await c.m.tick();
    expect(c.m.status.problem).toMatch(/no issuerKey/);
  });

  it('refuses to issue while more later keys are staged than allowed', async () => {
    const t = await setup([E, E + 1, E + 2]);
    await t.m.tick();
    expect(t.m.status.problem).toMatch(/later epochs/);
    expect(t.m.activeKey(E)).toBeNull();
    const ok = await setup([E, E + 1, E + 2], { maxStaged: 2 });
    await ok.m.tick();
    expect(ok.m.status.ready).toBe(true);
  });

  it('rejects a key file readable by others', async () => {
    const t = await setup([E]);
    chmodSync(join(t.dir, keyFileName(E)), 0o644);
    await t.m.tick();
    expect(t.m.status.problem).toMatch(/chmod 600/);
  });

  it('at the roll-over: destroys the old key, deletes its token rows, reports the count, switches keys', async () => {
    const t = await setup([E, E + 1]);
    await t.m.tick();
    t.store.reserve({ epoch: E, windowFrom: 0, proTxHash: 'a', collateral: 'a', blindedHash: rnd(32) }, () => rnd(256));
    t.store.reserve({ epoch: E, windowFrom: 0, proTxHash: 'b', collateral: 'b', blindedHash: rnd(32) }, () => rnd(256));
    // during E the key of E still signs (Standard mode)
    t.core.tip = epochStart(P, E) + 10;
    await t.m.tick();
    expect(t.m.activeKey(E)?.epoch).toBe(E);
    // inside the reorg margin after S(E+1): nothing destroyed yet
    t.core.tip = epochStart(P, E + 1) + P.boundaryMarginBlocks - 1;
    await t.m.tick();
    expect(existsSync(join(t.dir, keyFileName(E)))).toBe(true);
    expect(t.m.status.issuingEpochs).toEqual([E + 1, E + 2]);
    t.core.tip = epochStart(P, E + 1) + P.boundaryMarginBlocks;
    await t.m.tick();
    expect(existsSync(join(t.dir, keyFileName(E)))).toBe(false);
    expect(t.store.issued(E)).toBe(2);
    expect(t.store.reserve({ epoch: E, windowFrom: 0, proTxHash: 'c', collateral: 'c', blindedHash: rnd(32) }, () => rnd(256))).toEqual({ kind: 'closed' });
    expect(t.reports).toContainEqual({ epoch: E, tokensIssued: 2 });
    expect(t.m.activeKey(E + 1)?.epoch).toBe(E + 1);
  });

  it('a syncing dashd: nothing is issued and no start height is recorded', async () => {
    const t = await setup([E]);
    t.core.isSynced = false;
    await t.m.tick();
    expect(t.m.status).toMatchObject({ ready: false, problem: 'dashd is not synced' });
  });

  it('the report waits for Platform\'s core height to reach S(E+1) (tokens for E can be issued during E)', async () => {
    const t = await setup([E, E + 1]);
    await t.m.tick();
    t.store.reserve({ epoch: E, windowFrom: 0, proTxHash: 'a', collateral: 'a', blindedHash: rnd(32) }, () => rnd(256));
    t.core.tip = epochStart(P, E + 1) + P.boundaryMarginBlocks;
    t.platformHeight = epochStart(P, E + 1) - 1;
    await t.m.tick();
    expect(t.reports).toEqual([]);
    t.platformHeight = epochStart(P, E + 1) + 1;
    await t.m.tick();
    expect(t.reports).toEqual([{ epoch: E, tokensIssued: 1 }]);
  });

  it('a stray key file for an old epoch is destroyed even if never used', async () => {
    const t = await setup([E]);
    writeFileSync(join(t.dir, keyFileName(E - 5)), 'junk', { mode: 0o600 });
    await t.m.tick();
    expect(existsSync(join(t.dir, keyFileName(E - 5)))).toBe(false);
  });
});
