// PlatformClient without a network: the PV13 query lint on every bridge query, and the protocol version taken from proved metadata
// (the SDK's own version() can lag it), which decides the create id rule.
import { describe, expect, it } from 'vitest';
import { PlatformClient } from '../src/publish/platform.ts';

const CONTRACT = '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ';
const IDENTITY = '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv';

function fakeClient(o: { sdkVersion: number; queryPv?: number; noncePv?: number }) {
  const sent: unknown[] = [];
  const createdIds: Uint8Array[] = [];
  const sdk = {
    version: () => o.sdkVersion,
    documents: {
      queryWithProof: async (req: unknown) => (sent.push(req), { data: new Map(), metadata: { protocolVersion: o.queryPv ?? o.sdkVersion } }),
      query: async (req: unknown) => (sent.push(req), new Map()),
      create: async ({ document }: { document: { $id: Uint8Array } }) => (createdIds.push(document.$id), { id: { toString: () => 'id' } }),
    },
    identities: { contractNonceWithProof: async () => ({ data: 1n, metadata: { protocolVersion: o.noncePv ?? o.sdkVersion } }) },
  };
  const w = { Document: { fromObject: (obj: unknown) => obj }, PlatformVersion: { latest: () => ({}) } };
  const c = new PlatformClient('mainnet', CONTRACT);
  Object.assign(c as unknown as Record<string, unknown>, { sdk, w, connected: true, identityId: IDENTITY });
  return { c, sent, createdIds };
}

describe('PlatformClient queries pass the PV13 lint', () => {
  it('sends the publisher shapes (G8, G8b, G1, G5b)', async () => {
    const { c, sent } = fakeClient({ sdkVersion: 13 });
    await c.query('talliesSet', { where: [['page', '>=', 0]], orderBy: [['page', 'asc']], limit: 8 });
    await c.query('talliesSet', { where: [['page', '==', 0]], limit: 2 });
    await c.query('proposal', { where: [['govHash', '==', Buffer.alloc(32, 1).toString('base64')]], limit: 2 });
    await c.query('tally', { where: [['govHash', '==', Buffer.alloc(32, 1).toString('base64')]], limit: 2 });
    expect(sent).toHaveLength(4);
  });

  it('refuses a shape PV13 would answer with a silent [] (or rc.8 could not verify) before it reaches the network', async () => {
    const { c, sent } = fakeClient({ sdkVersion: 13 });
    await expect(c.query('proposal', { where: [['govHash', '==', 'abcd'.repeat(16)]] })).rejects.toThrow(/PV13 query rules.*R6/);
    await expect(c.query('cycle', { where: [['superblockHeight', '>', 0]], orderBy: [['superblockHeight', 'desc']], startAfter: IDENTITY })).rejects.toThrow(/R8/);
    await expect(c.query('tally', { where: [['asOfHeight', '>', 0]], orderBy: [['asOfHeight', 'asc']] })).rejects.toThrow(/R1/);
    expect(sent).toHaveLength(0);
  });
});

describe('PlatformClient protocol version comes from proved metadata', () => {
  it('a proved query reporting 14 lifts the version above an SDK that still says 13', async () => {
    const { c } = fakeClient({ sdkVersion: 13, queryPv: 14 });
    expect(c.protocolVersion).toBe(13);
    await c.query('talliesSet', { where: [['page', '==', 0]], limit: 2 });
    expect(c.protocolVersion).toBe(14);
  });

  it('create derives the PV13 id on PV13 and leaves it to the SDK (zero id) once a proved read shows PV14', async () => {
    const pv13 = fakeClient({ sdkVersion: 13, noncePv: 13 });
    await pv13.c.create('cycle', {});
    expect(pv13.createdIds[0]!.some((b) => b !== 0)).toBe(true);
    const pv14 = fakeClient({ sdkVersion: 13, noncePv: 14 });
    await pv14.c.create('cycle', {});
    expect(pv14.createdIds[0]!.every((b) => b === 0)).toBe(true);
  });
});
