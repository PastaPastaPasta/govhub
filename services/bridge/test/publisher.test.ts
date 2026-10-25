// Publisher idempotency, throttling, restart safety and the mismatch hold, against an in-memory fake of the Platform client, for the
// three gov shapes a bridge meets: the legacy testnet contract (full proposal, per-proposal tallies), the testnet contract after
// its update (full proposal + talliesSet) and mainnet gov.json (slim proposal + talliesSet).
import govMainnet from '@govhub/contracts-v1/gov.json' with { type: 'json' };
import govTestnet from '@govhub/contracts-v1/gov-testnet.json' with { type: 'json' };
import { decodeTallySet, TALLY_SET_MAX_ENTRIES } from '@govhub/verify';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { PlatformClient, type PlatformDoc, type QueryOptions } from '../src/publish/platform.ts';
import { Publisher } from '../src/publish/publisher.ts';
import type { ComputedTally, CoreComparison } from '../src/tally.ts';
import { fixtureBridge } from './world.ts';

type Schemas = Record<string, { properties?: Record<string, unknown> }>;
const LEGACY: Schemas = Object.fromEntries(Object.entries(govTestnet).filter(([t]) => t !== 'talliesSet'));
const TESTNET: Schemas = govTestnet;
const MAINNET: Schemas = govMainnet;

class FakePlatform {
  schemas: Schemas;
  constructor(schemas: Schemas) {
    this.schemas = schemas;
  }
  hasDocType = PlatformClient.prototype.hasDocType;
  hasProperty = PlatformClient.prototype.hasProperty;
  contractId = 'GovContract1111111111111111111111111111111';
  identityId = 'Bridge11111111111111111111111111111111111111';
  docs = new Map<string, { type: string; id: string; revision: number; data: Record<string, unknown> }>();
  writes: Array<{ op: string; type: string; key: string; revision: number }> = [];
  failNextCreateAfterLanding = false;
  private n = 0;
  balanceCredits = 10_000_000_000n;

  private key(type: string, data: Record<string, unknown>): string {
    return type === 'cycle' ? String(data.superblockHeight) : type === 'talliesSet' ? String(data.page) : Buffer.from(data.govHash as Uint8Array).toString('hex');
  }
  async balance(): Promise<bigint> {
    return this.balanceCredits;
  }
  async query(type: string, q: QueryOptions): Promise<PlatformDoc[]> {
    const [field, , value] = q.where![0]!;
    const key = field === 'superblockHeight' || field === 'page' ? String(value) : Buffer.from(String(value), 'base64').toString('hex');
    const d = this.docs.get(`${type}:${key}`);
    return d ? [{ id: d.id, revision: d.revision, data: d.data }] : [];
  }
  async create(type: string, props: Record<string, unknown>): Promise<{ id: string }> {
    const key = this.key(type, props);
    if (this.docs.has(`${type}:${key}`)) throw new Error('duplicate unique index [code 40105]');
    const id = `doc${++this.n}`;
    this.docs.set(`${type}:${key}`, { type, id, revision: 1, data: props });
    this.writes.push({ op: 'create', type, key, revision: 1 });
    this.balanceCredits -= 25_000_000n;
    if (this.failNextCreateAfterLanding) {
      this.failNextCreateAfterLanding = false;
      throw new Error('timeout waiting for the state transition result');
    }
    return { id };
  }
  async replace(type: string, id: string, revision: number, props: Record<string, unknown>): Promise<void> {
    const d = [...this.docs.values()].find((x) => x.id === id)!;
    if (revision !== d.revision + 1) throw new Error(`invalid revision ${revision}, current ${d.revision}`);
    d.revision = revision;
    d.data = props;
    this.writes.push({ op: 'replace', type, key: this.key(type, props), revision });
    this.balanceCredits -= 2_500_000n;
  }
  withRetries = PlatformClient.prototype.withRetries;
  async refreshNonce(): Promise<void> {}
}

function agreeing(b: Awaited<ReturnType<typeof fixtureBridge>>): Map<string, CoreComparison> {
  return new Map(
    b.lastRun!.tallies.map((t) => {
      const n = { yes: t.weighted.yes, no: t.weighted.no, abstain: t.weighted.abstain, absoluteYes: t.absoluteYes };
      return [t.govHash, { govHash: t.govHash, match: true, core: n, bridge: n, missingSigned: [], extra: [] }];
    }),
  );
}

async function setup(env: Record<string, string> = {}, schemas: Schemas = LEGACY) {
  const b = await fixtureBridge();
  const cfg = loadConfig({ GOV_CONTRACT_ID: 'x', BRIDGE_IDENTITY_KEY_FILE: '/dev/null', MIN_COLLATERAL_CONFS: '6', ...env });
  const fake = new FakePlatform(schemas);
  const pub = new Publisher(b.db, fake as unknown as PlatformClient, cfg);
  // the fixture MN list is a subset, so align Core's threshold with it; every tally "agreed with Core"
  b.lastRun!.coreThreshold = b.lastRun!.threshold;
  const matchAll = agreeing(b);
  return { b, fake, pub, cfg, matchAll, cycles: () => b.cycles(b.lastRun!) };
}

describe('publisher, legacy contract (no talliesSet: one tally per proposal)', () => {
  it('publishes proposals, tallies and cycles once; a second pass writes nothing', async () => {
    const { b, fake, pub, matchAll, cycles } = await setup();
    const s1 = await pub.publish(b.lastRun!, matchAll, cycles());
    const n = b.lastRun!.tallies.length;
    expect(s1.created).toBe(28 + n + 2);
    expect(s1.failed).toBe(0);
    expect(BigInt(s1.creditsBefore!) - BigInt(s1.creditsAfter!)).toBe(BigInt(28 + n + 2) * 25_000_000n);
    const s2 = await pub.publish(b.lastRun!, matchAll, cycles());
    expect([s2.created, s2.replaced]).toEqual([0, 0]);
  });

  it('replaces a changed tally with revision + 1, throttled by TALLY_PUBLISH_INTERVAL_S', async () => {
    const { b, fake, pub, matchAll, cycles } = await setup({ TALLY_PUBLISH_INTERVAL_S: '3600' });
    await pub.publish(b.lastRun!, matchAll, cycles());
    const t = b.lastRun!.tallies[0]!;
    t.weighted.yes += 4;
    const throttled = await pub.publish(b.lastRun!, matchAll, cycles());
    expect(throttled.replaced).toBe(0);
    const forced = await pub.publish(b.lastRun!, matchAll, cycles(), { force: true });
    expect(forced.replaced).toBe(1);
    expect(fake.writes.at(-1)).toMatchObject({ op: 'replace', type: 'tally', key: t.govHash, revision: 2 });
    // asOfHeight alone is not a change
    t.asOfHeight += 1;
    expect((await pub.publish(b.lastRun!, matchAll, cycles(), { force: true })).replaced).toBe(0);
  });

  it('fails closed: holds a tally that disagrees with Core, has no Core comparison, or whose threshold differs', async () => {
    const { b, fake, pub, matchAll, cycles } = await setup();
    const [t0, t1] = b.lastRun!.tallies;
    const cmp = new Map(matchAll);
    cmp.set(t0!.govHash, { govHash: t0!.govHash, match: false, core: { yes: 1, no: 0, abstain: 0, absoluteYes: 1 }, bridge: { yes: 0, no: 0, abstain: 0, absoluteYes: 0 }, missingSigned: ['x'], extra: [] });
    cmp.delete(t1!.govHash);
    const s = await pub.publish(b.lastRun!, cmp, cycles());
    expect(s.held).toBe(2);
    expect(fake.docs.has(`tally:${t0!.govHash}`)).toBe(false);
    expect(fake.docs.has(`tally:${t1!.govHash}`)).toBe(false);
    b.lastRun!.coreThreshold = b.lastRun!.threshold + 1;
    expect((await pub.publish(b.lastRun!, matchAll, cycles())).held).toBe(b.lastRun!.tallies.length);
  });

  it('PUBLISH_ON_MISMATCH=1 publishes anyway', async () => {
    const { b, fake, pub, cycles } = await setup({ PUBLISH_ON_MISMATCH: '1' });
    const s = await pub.publish(b.lastRun!, new Map(), cycles());
    expect(s.held).toBe(0);
    expect(fake.docs.has(`tally:${b.lastRun!.tallies[0]!.govHash}`)).toBe(true);
  });

  it('retires the tally of a proposal that left the active set (rank 0, not in the next budget), once', async () => {
    const { b, fake, pub, matchAll, cycles } = await setup({ TALLY_PUBLISH_INTERVAL_S: '0' });
    await pub.publish(b.lastRun!, matchAll, cycles());
    const gone = b.lastRun!.tallies.shift()!;
    await pub.publish(b.lastRun!, matchAll, cycles());
    const d = fake.docs.get(`tally:${gone.govHash}`)!;
    expect(d.revision).toBe(2);
    expect([d.data.rank, d.data.inNextBudget]).toEqual([0n, false]);
    const before = fake.writes.length;
    await pub.publish(b.lastRun!, matchAll, cycles());
    expect(fake.writes.length).toBe(before);
  });

  it('is restart-safe: adopts documents already on Platform instead of creating duplicates', async () => {
    const { b, fake, matchAll, cycles, cfg } = await setup();
    await new Publisher(b.db, fake as unknown as PlatformClient, cfg).publish(b.lastRun!, matchAll, cycles());
    const before = fake.writes.length;
    // a fresh archive (lost platform_docs) pointing at the same Platform state
    const b2 = await fixtureBridge();
    const s = await new Publisher(b2.db, fake as unknown as PlatformClient, cfg).publish(b2.lastRun!, matchAll, b2.cycles(b2.lastRun!));
    expect(s.created).toBe(0);
    expect(s.adopted).toBe(28);
    // adopted mutable documents are re-published once (their content is unknown), as replaces
    expect(fake.writes.slice(before).every((w) => w.op === 'replace')).toBe(true);
  });

  it('a create that landed but reported an error is not retried into a duplicate', async () => {
    const { b, fake, pub, matchAll, cycles } = await setup();
    fake.failNextCreateAfterLanding = true;
    const s = await pub.publish(b.lastRun!, matchAll, cycles());
    expect(s.failed).toBe(0);
    expect(fake.writes.filter((w) => w.op === 'create').length).toBe(s.created);
  });

  it('only publishes proposals whose collateral has enough confirmations', async () => {
    const { b, pub } = await setup({ MIN_COLLATERAL_CONFS: '100000000' });
    expect(pub.publishableProposals(b.lastRun!.height).ok.length).toBe(0);
  });
});

/** The entries of talliesSet page `page` on the fake Platform. */
const packed = (fake: FakePlatform, page = 0) => {
  const d = fake.docs.get(`talliesSet:${page}`)!;
  return { d, entries: decodeTallySet([d.data.b0 as Uint8Array, d.data.b1 as Uint8Array | undefined, d.data.b2 as Uint8Array | undefined]) };
};

describe('publisher, mainnet gov.json (slim proposal + talliesSet)', () => {
  it('publishes slim proposals, ONE packed tally document for every tally, and cycles; a second pass writes nothing', async () => {
    const { b, fake, pub, matchAll, cycles } = await setup({}, MAINNET);
    const s1 = await pub.publish(b.lastRun!, matchAll, cycles());
    const n = b.lastRun!.tallies.length;
    expect(n).toBeGreaterThan(5);
    expect(s1.created).toBe(28 + 1 + 2);
    expect(s1.failed).toBe(0);
    expect(fake.writes.filter((w) => w.type === 'tally')).toEqual([]);
    const { d, entries } = packed(fake);
    expect(d.data.asOfHeight).toBe(BigInt(b.lastRun!.height));
    expect(entries.map((e) => e.govHash).sort()).toEqual(b.lastRun!.tallies.map((t) => t.govHash).sort());
    const t = b.lastRun!.tallies[0]!;
    expect(entries.find((e) => e.govHash === t.govHash)).toEqual({
      govHash: t.govHash, yesWeighted: t.weighted.yes, noWeighted: t.weighted.no, abstainWeighted: t.weighted.abstain, yesCount: t.unweighted.yes,
      noCount: t.unweighted.no, abstainCount: t.unweighted.abstain, voteSetHash: t.voteSetHash, rank: t.rank, inNextBudget: t.inNextBudget, margin: t.margin,
    });
    // slim: the duplicated fields are not sent (the contract would reject them)
    const p = [...fake.docs.values()].find((x) => x.type === 'proposal')!;
    expect(Object.keys(p.data).sort()).toEqual(['collateralHeight', 'collateralTxid', 'dataHex', 'endEpoch', 'govHash', 'name', 'parentHash', 'revision', 'time']);
    const s2 = await pub.publish(b.lastRun!, matchAll, cycles());
    expect([s2.created, s2.replaced]).toEqual([0, 0]);
  });

  it('one changed tally replaces the packed document once (revision + 1), throttled; a new height alone is no change', async () => {
    const { b, fake, pub, matchAll, cycles } = await setup({ TALLY_PUBLISH_INTERVAL_S: '3600' }, MAINNET);
    await pub.publish(b.lastRun!, matchAll, cycles());
    const t = b.lastRun!.tallies[0]!;
    t.weighted.yes += 4;
    b.lastRun!.height += 3;
    expect((await pub.publish(b.lastRun!, matchAll, cycles())).replaced).toBe(0);
    const before = fake.writes.length;
    const forced = await pub.publish(b.lastRun!, matchAll, cycles(), { force: true });
    expect(forced.replaced).toBe(1);
    expect(fake.writes.slice(before)).toEqual([{ op: 'replace', type: 'talliesSet', key: '0', revision: 2 }]);
    const { d, entries } = packed(fake);
    expect(d.data.asOfHeight).toBe(BigInt(b.lastRun!.height));
    expect(entries.find((e) => e.govHash === t.govHash)!.yesWeighted).toBe(t.weighted.yes);
    b.lastRun!.height += 1;
    expect((await pub.publish(b.lastRun!, matchAll, cycles(), { force: true })).replaced).toBe(0);
  });

  it('fails closed: a held tally is left out of the set, never sent with numbers Core disagrees with', async () => {
    const { b, fake, pub, matchAll, cycles } = await setup({}, MAINNET);
    const t0 = b.lastRun!.tallies[0]!;
    const cmp = new Map(matchAll);
    cmp.set(t0.govHash, { ...cmp.get(t0.govHash)!, match: false });
    const s = await pub.publish(b.lastRun!, cmp, cycles());
    expect(s.held).toBe(1);
    expect(packed(fake).entries.map((e) => e.govHash)).not.toContain(t0.govHash);
    expect(packed(fake).entries).toHaveLength(b.lastRun!.tallies.length - 1);
  });

  it('a proposal that left the active set gets its final tally once, as a per-proposal tally (its last packed entry, rank 0)', async () => {
    const { b, fake, pub, matchAll, cycles } = await setup({ TALLY_PUBLISH_INTERVAL_S: '0' }, MAINNET);
    await pub.publish(b.lastRun!, matchAll, cycles());
    const publishedAt = b.lastRun!.height;
    const gone = b.lastRun!.tallies.shift()!;
    const entry = packed(fake).entries.find((e) => e.govHash === gone.govHash)!;
    b.lastRun!.height += 10;
    const s = await pub.publish(b.lastRun!, matchAll, cycles());
    expect(s.created).toBe(1);
    const d = fake.docs.get(`tally:${gone.govHash}`)!;
    expect(d.revision).toBe(1);
    expect(d.data).toMatchObject({ asOfHeight: BigInt(publishedAt), yesWeighted: BigInt(entry.yesWeighted), noWeighted: BigInt(entry.noWeighted), rank: 0n, inNextBudget: false, margin: BigInt(entry.margin) });
    expect(Buffer.from(d.data.voteSetHash as Uint8Array).toString('hex')).toBe(entry.voteSetHash);
    // the packed set no longer carries it
    expect(packed(fake).entries.map((e) => e.govHash)).not.toContain(gone.govHash);
    const before = fake.writes.length;
    await pub.publish(b.lastRun!, matchAll, cycles());
    expect(fake.writes.length).toBe(before);
  });

  it('a final tally that failed is retried on the next run, after the packed set dropped the entry', async () => {
    const { b, fake, pub, matchAll, cycles } = await setup({ TALLY_PUBLISH_INTERVAL_S: '0' }, MAINNET);
    await pub.publish(b.lastRun!, matchAll, cycles());
    const gone = b.lastRun!.tallies.shift()!;
    const create = fake.create.bind(fake);
    fake.create = async (type, props) => (type === 'tally' ? Promise.reject(new Error('invalid state transition [code 10000]')) : create(type, props));
    expect((await pub.publish(b.lastRun!, matchAll, cycles())).failed).toBe(1);
    expect(fake.docs.has(`tally:${gone.govHash}`)).toBe(false);
    fake.create = create;
    expect((await pub.publish(b.lastRun!, matchAll, cycles())).created).toBe(1);
    expect(fake.docs.get(`tally:${gone.govHash}`)!.data.rank).toBe(0n);
  });

  it('is restart-safe: adopts the packed document already on Platform', async () => {
    const { b, fake, matchAll, cycles, cfg } = await setup({}, MAINNET);
    await new Publisher(b.db, fake as unknown as PlatformClient, cfg).publish(b.lastRun!, matchAll, cycles());
    const b2 = await fixtureBridge();
    b2.lastRun!.coreThreshold = b2.lastRun!.threshold;
    const before = fake.writes.length;
    const s = await new Publisher(b2.db, fake as unknown as PlatformClient, cfg).publish(b2.lastRun!, matchAll, b2.cycles(b2.lastRun!));
    expect(s.created).toBe(0);
    expect(fake.writes.slice(before).filter((w) => w.type === 'talliesSet')).toEqual([{ op: 'replace', type: 'talliesSet', key: '0', revision: 2 }]);
  });

  it('more than 161 tallies spill into page 1; when they shrink again, page 1 is emptied once', async () => {
    const { b, fake, pub, matchAll, cycles } = await setup({ TALLY_PUBLISH_INTERVAL_S: '0', PUBLISH_ON_MISMATCH: '1' }, MAINNET);
    const real = b.lastRun!.tallies;
    // synthetic tallies for proposals the archive "published" (the publisher only packs proposals it has a record of)
    const extra: ComputedTally[] = Array.from({ length: TALLY_SET_MAX_ENTRIES + 10 - real.length }, (_, i) => ({ ...real[0]!, govHash: (i + 1).toString(16).padStart(64, 'e') }));
    for (const t of extra) b.db.prepare("INSERT INTO platform_docs VALUES (?, 'proposal', ?, 'x', 1, 'h', '[]', 0)").run(fake.contractId, t.govHash);
    b.lastRun!.tallies = [...real, ...extra];
    await pub.publish(b.lastRun!, matchAll, cycles());
    expect([packed(fake, 0).entries.length, packed(fake, 1).entries.length]).toEqual([TALLY_SET_MAX_ENTRIES, 10]);
    b.lastRun!.tallies = real;
    await pub.publish(b.lastRun!, matchAll, cycles());
    expect([packed(fake, 0).entries.length, packed(fake, 1).entries.length]).toEqual([real.length, 0]);
    const before = fake.writes.filter((w) => w.type === 'talliesSet').length;
    await pub.publish(b.lastRun!, matchAll, cycles());
    expect(fake.writes.filter((w) => w.type === 'talliesSet').length).toBe(before);
  });
});

describe('publisher, testnet gov after its update (full proposal + talliesSet)', () => {
  it('keeps the full proposal shape, packs the tallies, and retires a pre-update per-proposal tally with the packed values when it ends', async () => {
    const legacy = await setup({ TALLY_PUBLISH_INTERVAL_S: '0' }, LEGACY);
    await legacy.pub.publish(legacy.b.lastRun!, legacy.matchAll, legacy.cycles());
    // the contract update adds talliesSet; the same archive and Platform state carry over
    legacy.fake.schemas = TESTNET;
    const { b, fake, pub, matchAll, cycles } = legacy;
    const t = b.lastRun!.tallies[0]!;
    t.weighted.yes += 8;
    b.lastRun!.height += 5;
    await pub.publish(b.lastRun!, matchAll, cycles());
    expect(packed(fake).entries.find((e) => e.govHash === t.govHash)!.yesWeighted).toBe(t.weighted.yes);
    // the per-proposal document of an active proposal is left alone (the reader takes the newer of the two)
    expect(fake.docs.get(`tally:${t.govHash}`)!.revision).toBe(1);
    const p = [...fake.docs.values()].find((x) => x.type === 'proposal')!;
    expect(p.data).toHaveProperty('url');
    b.lastRun!.tallies.shift();
    await pub.publish(b.lastRun!, matchAll, cycles());
    const d = fake.docs.get(`tally:${t.govHash}`)!;
    expect([d.revision, d.data.yesWeighted, d.data.asOfHeight, d.data.rank]).toEqual([2, BigInt(t.weighted.yes), BigInt(b.lastRun!.height), 0n]);
  });
});
