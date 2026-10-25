// `issuer publish-keys`: the current epoch's key can still be published; a duplicate is adopted only when it is our SPKI.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { epochStart, keyDeadline, sha256, VARIANT, type IssuerKeyDoc } from '@govhub/badge';
import { keygen, manifestSpki } from '../src/keys.ts';
import type { IssuerPlatform } from '../src/platform.ts';
import { publishExitCode, publishKeys } from '../src/publish.ts';
import { E, P, rnd } from './helpers.ts';

const KEY = { identityId: 'H62hSf5TpKbUSMov85GMhPQahZDbqsTipeoBsYPgveUH', keyId: 1, privateKeyHex: '11'.repeat(32) };

type Mode = 'ok' | 'fail' | 'landed-then-fail' | 'raced-other';

async function setup(epochs: number[]) {
  const manifest = await keygen(mkdtempSync(join(tmpdir(), 'pub-')), Math.min(...epochs), Math.max(...epochs) - Math.min(...epochs) + 1, 2048);
  const other = manifestSpki((await keygen(mkdtempSync(join(tmpdir(), 'pub-o-')), 1, 1, 2048))[0]!);
  const docs = new Map<number, IssuerKeyDoc>();
  const ctl = { height: epochStart(P, E) + 100, mode: 'ok' as Mode, published: [] as number[] };
  const put = async (epoch: number, spki: Uint8Array) => docs.set(epoch, { ownerId: rnd(32), epoch, spki, keyId: await sha256(spki), variant: VARIANT, createdAtCoreBlockHeight: ctl.height });
  const platform: Pick<IssuerPlatform, 'issuerKey' | 'coreHeight' | 'publishIssuerKey'> = {
    issuerKey: async (_i, e) => docs.get(e) ?? null,
    coreHeight: async () => ctl.height,
    async publishIssuerKey(_k, o) {
      if (ctl.mode === 'fail') throw new Error('timeout');
      if (ctl.mode === 'raced-other') {
        await put(o.epoch, other);
        throw new Error('duplicate unique index');
      }
      if (docs.has(o.epoch)) throw new Error('duplicate unique index');
      await put(o.epoch, o.spki);
      ctl.published.push(o.epoch);
      if (ctl.mode === 'landed-then-fail') throw new Error('timeout waiting for the result');
      return `doc-${o.epoch}`;
    },
  };
  const entry = (e: number) => manifest.find((m) => m.epoch === e)!;
  return { manifest, other, docs, ctl, put, platform, entry };
}

describe('publish-keys', () => {
  it('publishes the CURRENT epoch key mid-epoch (after the old S(E-1) deadline) and the next ones', async () => {
    const t = await setup([E, E + 1, E + 2]);
    // inside E: the old rule refused E (deadline S(E-1)) and E+1 (deadline S(E))
    const r = await publishKeys(t.platform, KEY, t.manifest, P);
    expect(r.map((x) => [x.epoch, x.status])).toEqual([[E, 'published'], [E + 1, 'published'], [E + 2, 'published']]);
    expect(r[0]).toMatchObject({ id: `doc-${E}`, createdAtCoreBlockHeight: t.ctl.height, deadline: epochStart(P, E + 1) - P.boundaryMarginBlocks });
    expect(publishExitCode(r)).toBe(0);
  });

  it('skips an epoch that can no longer land before S(E+1) - margin', async () => {
    const t = await setup([E, E + 1]);
    t.ctl.height = keyDeadline(P, E) - P.boundaryMarginBlocks;
    const r = await publishKeys(t.platform, KEY, t.manifest, P);
    expect(r.map((x) => x.status)).toEqual(['too late', 'published']);
    expect(t.docs.has(E)).toBe(false);
    // one block earlier it still goes out
    const u = await setup([E]);
    u.ctl.height = keyDeadline(P, E) - P.boundaryMarginBlocks - 1;
    expect((await publishKeys(u.platform, KEY, u.manifest, P))[0]!.status).toBe('published');
  });

  it('a second run, or a write that landed although the SDK failed, adopts our own key; nothing is published twice', async () => {
    const t = await setup([E, E + 1]);
    await publishKeys(t.platform, KEY, t.manifest, P);
    const again = await publishKeys(t.platform, KEY, t.manifest, P);
    expect(again.map((x) => x.status)).toEqual(['already published', 'already published']);
    expect(t.ctl.published).toEqual([E, E + 1]);

    const u = await setup([E]);
    u.ctl.mode = 'landed-then-fail';
    const r = await publishKeys(u.platform, KEY, u.manifest, P);
    expect(r[0]).toMatchObject({ status: 'adopted', createdAtCoreBlockHeight: u.ctl.height });
    expect(r[0]!.note).toMatch(/timeout waiting/);
    expect(publishExitCode(r)).toBe(0);
  });

  it('a slot holding ANOTHER key is a loud conflict (before or while publishing); a failed publish is an error', async () => {
    const t = await setup([E, E + 1]);
    await t.put(E, t.other); // someone else's key already in E's slot
    const r = await publishKeys(t.platform, KEY, t.manifest, P);
    expect(r[0]).toMatchObject({ epoch: E, status: 'conflict', keyId: Buffer.from(await sha256(t.other)).toString('hex') });
    expect(r[0]!.note).toMatch(/CRITICAL key is compromised/);
    expect(r[1]!.status).toBe('published');
    expect(publishExitCode(r)).toBe(3);

    const u = await setup([E]);
    u.ctl.mode = 'raced-other';
    expect((await publishKeys(u.platform, KEY, u.manifest, P))[0]!.status).toBe('conflict');

    // our SPKI, but in a form readers reject (another variant): the slot is burnt
    const w = await setup([E]);
    await w.put(E, manifestSpki(w.entry(E)));
    w.docs.get(E)!.variant = 'RSABSSA-SHA384-PSS-Deterministic';
    expect((await publishKeys(w.platform, KEY, w.manifest, P))[0]!.status).toBe('conflict');

    const v = await setup([E]);
    v.ctl.mode = 'fail';
    const f = await publishKeys(v.platform, KEY, v.manifest, P);
    expect(f[0]).toMatchObject({ status: 'error' });
    expect(f[0]!.note).toMatch(/publishing failed: timeout/);
    expect(publishExitCode(f)).toBe(1);
  });

  it('our key already published but past the deadline is an error, and a manifest whose keyId is not SHA256(spki) is refused', async () => {
    const t = await setup([E]);
    t.ctl.height = keyDeadline(P, E);
    await t.put(E, manifestSpki(t.entry(E)));
    expect((await publishKeys(t.platform, KEY, t.manifest, P))[0]!.status).toBe('error');

    const u = await setup([E]);
    const bad = [{ ...u.entry(E), keyId: '00'.repeat(32) }];
    const r = await publishKeys(u.platform, KEY, bad, P);
    expect(r[0]).toMatchObject({ status: 'error' });
    expect(u.docs.size).toBe(0);
  });
});
