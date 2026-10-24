// Publisher idempotency, throttling, restart safety and the mismatch hold, against an in-memory fake of the Platform client.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { PlatformClient, type PlatformDoc, type QueryOptions } from '../src/publish/platform.ts';
import { Publisher } from '../src/publish/publisher.ts';
import type { CoreComparison } from '../src/tally.ts';
import { fixtureBridge } from './world.ts';

class FakePlatform {
  contractId = 'GovContract1111111111111111111111111111111';
  identityId = 'Bridge11111111111111111111111111111111111111';
  docs = new Map<string, { type: string; id: string; revision: number; data: Record<string, unknown> }>();
  writes: Array<{ op: string; type: string; key: string; revision: number }> = [];
  failNextCreateAfterLanding = false;
  private n = 0;
  balanceCredits = 10_000_000_000n;

  private key(type: string, data: Record<string, unknown>): string {
    return type === 'cycle' ? String(data.superblockHeight) : Buffer.from(data.govHash as Uint8Array).toString('hex');
  }
  async balance(): Promise<bigint> {
    return this.balanceCredits;
  }
  async query(type: string, q: QueryOptions): Promise<PlatformDoc[]> {
    const [field, , value] = q.where![0]!;
    const key = field === 'superblockHeight' ? String(value) : Buffer.from(String(value), 'base64').toString('hex');
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

async function setup(env: Record<string, string> = {}) {
  const b = await fixtureBridge();
  const cfg = loadConfig({ GOV_CONTRACT_ID: 'x', BRIDGE_IDENTITY_KEY_FILE: '/dev/null', MIN_COLLATERAL_CONFS: '6', ...env });
  const fake = new FakePlatform();
  const pub = new Publisher(b.db, fake as unknown as PlatformClient, cfg);
  // the fixture MN list is a subset, so align Core's threshold with it; every tally "agreed with Core"
  b.lastRun!.coreThreshold = b.lastRun!.threshold;
  const matchAll = agreeing(b);
  return { b, fake, pub, cfg, matchAll, cycles: () => b.cycles(b.lastRun!) };
}

describe('publisher', () => {
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
