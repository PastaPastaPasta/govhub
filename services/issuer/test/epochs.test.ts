// Epoch housekeeping: key loading against the proved issuerKey, staged-key limit, key destruction, record deletion, reports.
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { epochOf, epochStart, issuanceWindow, keyDeadline, sha256, VARIANT, type IssuerKeyDoc } from '@govhub/badge';
import { openTokenStore, type TokenStore } from '../src/db.ts';
import { closableThrough, EpochManager } from '../src/epochs.ts';
import { keyFileName, keygen, manifestSpki } from '../src/keys.ts';
import type { IssuerPlatform } from '../src/platform.ts';
import { MnLists } from '../src/core.ts';
import { E, FakeCore, legacyClose, P, rnd, tmpDb } from './helpers.ts';

const sign = () => rnd(256);
const ISSUER = 'H62hSf5TpKbUSMov85GMhPQahZDbqsTipeoBsYPgveUH';

async function setup(epochs: number[], o: { lateDoc?: boolean; maxStaged?: number; startedAt?: number; store?: TokenStore } = {}) {
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
  const store = o.store ?? openTokenStore(':memory:');
  store.markStarted(o.startedAt ?? 0);
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
    expect(a.m.status.problem).toMatch(/CONFLICT: the key file of epoch .* does not match the published SPKI/);
    const b = await setup([E], { lateDoc: true });
    await b.m.tick();
    expect(b.m.status.problem).toMatch(/too late/);
    const c = await setup([E]);
    c.docs.clear();
    await c.m.tick();
    expect(c.m.status.problem).toMatch(/no issuerKey/);
  });

  it('a current-epoch key published mid-epoch (after the old S(E-1) deadline) is picked up at the next tick', async () => {
    const t = await setup([E - 1, E]);
    const doc = t.docs.get(E - 1)!;
    t.docs.delete(E - 1);
    await t.m.tick();
    expect(t.m.activeKey(E - 1)).toBeNull();
    expect(t.m.status.problem).toMatch(new RegExp(`no issuerKey document for epoch ${E - 1} on Platform yet: publish it`));
    // published now, inside E-1 (the current epoch at TIP): after S(E-2), before S(E) - margin
    t.docs.set(E - 1, { ...doc, createdAtCoreBlockHeight: t.core.tip - 2 });
    await t.m.tick();
    expect(t.m.activeKey(E - 1)).toMatchObject({ epoch: E - 1, keyCreatedAt: t.core.tip - 2 });
    expect(t.m.status).toMatchObject({ ready: true, problem: null });
    // at the bound it is too late
    const late = await setup([E - 1, E]);
    late.docs.get(E - 1)!.createdAtCoreBlockHeight = keyDeadline(P, E - 1);
    await late.m.tick();
    expect(late.m.activeKey(E - 1)).toBeNull();
    expect(late.m.status.problem).toMatch(/too late/);
  });

  it('a published key without a key file still opens the epoch, so it is reported (0 tokens) instead of flagged', async () => {
    const t = await setup([E]);
    const { rmSync } = await import('node:fs');
    rmSync(join(t.dir, keyFileName(E)));
    await t.m.tick();
    expect(t.m.status.problem).toMatch(new RegExp(`no key file for epoch ${E}, although an issuerKey is published`));
    t.core.tip = epochStart(P, E + 1) + P.boundaryMarginBlocks;
    await t.m.tick();
    expect(t.reports).toContainEqual({ epoch: E, tokensIssued: 0 });
  });

  it('the store start is the higher of the dashd tip and Platform\'s core height, and waits for Platform', async () => {
    const t = await setup([E]);
    const fresh = openTokenStore(':memory:');
    let ph: number | null = null;
    const platform: IssuerPlatform = { issuerKey: async () => null, issuerReport: async () => null, issuerRevocation: async () => null, coreHeight: async () => { if (ph === null) throw new Error('down'); return ph; }, publishIssuerKey: async () => 'x', publishIssuerReport: async () => 'x', publishIssuerRevocation: async () => 'x' };
    const m = new EpochManager({ params: P, issuerId: ISSUER, keyDir: t.dir, maxStagedKeys: 1, core: t.core, lists: new MnLists(t.core), store: fresh, platform: () => platform, reportKey: null });
    await m.tick();
    expect(fresh.startedHeight()).toBeNull(); // no Platform height yet
    ph = t.core.tip + 2; // Platform ahead of this dashd
    await m.tick();
    expect(fresh.startedHeight()).toBe(t.core.tip + 2);
  });

  it('a token store younger than a published key does not use it, and says so', async () => {
    // started inside E-1's window, after E-1's key (created at 1), but before E's window opens at S(E-1)
    const started = epochStart(P, E - 1) - 10;
    const u = await setup([E - 1, E], { startedAt: started });
    await u.m.tick();
    expect(u.m.activeKey(E - 1)).toBeNull();
    expect(u.m.status.problem).toMatch(new RegExp(`token store started at height ${started}, after epoch ${E - 1}'s window opened`));
    expect(u.m.activeKey(E)?.epoch).toBe(E);
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

  it('closes only epochs whose issuance window ended at least the margin before the tip', () => {
    for (let h = epochStart(P, E - 2); h < epochStart(P, E + 1); h++) {
      const c = closableThrough(P, h);
      expect(issuanceWindow(P, c).to + P.boundaryMarginBlocks).toBeLessThanOrEqual(h);
      expect(issuanceWindow(P, c + 1).to + P.boundaryMarginBlocks).toBeGreaterThan(h);
    }
    expect(closableThrough(P, 0)).toBe(0);
    expect(closableThrough(P, epochStart(P, 1) + P.boundaryMarginBlocks)).toBe(0);
  });

  // Testnet, 2026-10-25: the store came from an issuer on code before PR #11, when tokens for E were issued only during E-1 and
  // the closing rule closed E itself once the tip passed S(E) + margin. Under the current rule (tokens for E during E as well)
  // that left the current epoch closed; a key for it published late (PR #26) was loaded and listed in /v1/info, but every
  // request got `closed`.
  const preIssue11Closable = (h: number) => {
    const issuing = epochOf(P, h) + 1;
    return h >= epochStart(P, issuing - 1) + P.boundaryMarginBlocks ? issuing - 1 : issuing - 2;
  };
  const LATE_KEY_AT = 1_579_277; // the height the issuerKey for 2741 landed at
  function carriedOverStore(o: { issuedFor2741?: number } = {}): TokenStore {
    expect(E - 1).toBe(2741);
    const path = tmpDb();
    const old = openTokenStore(path);
    old.markStarted(0); // a legacy store (epochs table, no meta) gets started_height 0
    // the old issuer, during epoch 2740: issuing 2741 (tokens counted, if any), closing 2740
    for (let i = 0; i < (o.issuedFor2741 ?? 0); i++) old.reserve({ epoch: E - 1, windowFrom: 0, proTxHash: `p${i}`, collateral: `c${i}`, blindedHash: rnd(32) }, sign);
    old.openEpoch(E);
    old.close();
    legacyClose(path, preIssue11Closable(epochStart(P, E - 1) - 100));
    // ... and during epoch 2741, about two hours before the restart
    const oldTip = LATE_KEY_AT - 55;
    expect(preIssue11Closable(oldTip)).toBe(E - 1);
    expect(closableThrough(P, oldTip)).toBe(E - 2); // the current rule never closes 2741 there
    legacyClose(path, preIssue11Closable(oldTip));
    const store = openTokenStore(path);
    expect(store.closedThrough()).toBe(E - 1);
    return store;
  }

  it('reopens the current epoch that an older closing rule closed with no tokens issued, so a key published late signs', async () => {
    const store = carriedOverStore();
    const t = await setup([E - 1, E], { store });
    t.core.tip = LATE_KEY_AT;
    t.docs.get(E - 1)!.createdAtCoreBlockHeight = LATE_KEY_AT;
    await t.m.tick();
    expect(store.closedThrough()).toBe(E - 2);
    expect(t.m.activeKey(E - 1)?.epoch).toBe(E - 1);
    expect(Object.keys(t.m.status.keyIds).map(Number)).toEqual([E - 1, E]);
    expect(t.m.status).toMatchObject({ ready: true, problem: null });
    const windowFrom = epochStart(P, E - 2);
    expect(store.reserve({ epoch: E - 1, windowFrom, proTxHash: 'a', collateral: 'a', blindedHash: rnd(32) }, sign).kind).toBe('signed');
    expect(store.reserve({ epoch: E - 1, windowFrom, proTxHash: 'a', collateral: 'a', blindedHash: rnd(32) }, sign)).toEqual({ kind: 'conflict', reason: 'mn' });
    // the window then closes as usual, with the count reported
    t.core.tip = epochStart(P, E) + P.boundaryMarginBlocks;
    await t.m.tick();
    expect(store.closedThrough()).toBe(E - 1);
    expect(store.issued(E - 1)).toBe(1);
    // one-way: a tip that goes back into the window does not reopen it
    t.core.tip = LATE_KEY_AT;
    await t.m.tick();
    expect(store.closedThrough()).toBe(E - 1);
    expect(t.m.activeKey(E - 1)).toBeNull();
    expect(t.m.status.problem).toMatch(new RegExp(`closed through epoch ${E - 1}`));
  });

  it('does not reopen an epoch whose token rows were deleted, and does not report it as issuing', async () => {
    const store = carriedOverStore({ issuedFor2741: 2 });
    const t = await setup([E - 1, E], { store });
    t.core.tip = LATE_KEY_AT;
    await t.m.tick();
    expect(store.closedThrough()).toBe(E - 1);
    expect(store.issued(E - 1)).toBe(2);
    expect(t.m.activeKey(E - 1)).toBeNull();
    expect(Object.keys(t.m.status.keyIds).map(Number)).toEqual([E]);
    expect(t.m.status.ready).toBe(true); // E still issues
    expect(t.m.status.problem).toMatch(new RegExp(`token store is closed through epoch ${E - 1}, although epoch ${E - 1}'s issuance window is open`));
  });
});
