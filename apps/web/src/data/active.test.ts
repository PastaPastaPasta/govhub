import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { profileRegistry } from '../config/registry.ts';
import { HttpBridge } from './bridge.ts';
import { loadFixtures } from './fixtures.ts';

const platform = vi.hoisted(() => ({ queryDocs: vi.fn() }));
vi.mock('./platform.ts', async (original) => ({
  ...await original<typeof import('./platform.ts')>(),
  queryDocs: platform.queryDocs,
}));
const { liveSource } = await import('./repo.ts');

beforeEach(() => {
  platform.queryDocs.mockRejectedValue(new Error('Platform list not read'));
  vi.spyOn(HttpBridge.prototype, 'status').mockResolvedValue({ network: 'testnet', height: 100 });
  vi.spyOn(HttpBridge.prototype, 'proposals').mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

it('does not treat an empty bridge answer as a successful Platform list read', async () => {
  await expect(liveSource(profileRegistry('testnet')).active()).rejects.toThrow('Platform list not read');
});

it('also surfaces a failed Platform read when the bridge only has expired proposals', async () => {
  const { proposals } = await loadFixtures();
  vi.mocked(HttpBridge.prototype.proposals).mockResolvedValue(proposals.map(p => ({ ...p, endEpoch: 1 })));
  await expect(liveSource(profileRegistry('testnet')).active()).rejects.toThrow('Platform list not read');
});

it('allows a confirmed empty Platform list', async () => {
  platform.queryDocs.mockResolvedValue({ docs: [], height: 777 });
  await expect(liveSource(profileRegistry('testnet')).active()).resolves.toEqual([]);
});

it('keeps usable bridge records labelled with the Platform failure', async () => {
  const { proposals } = await loadFixtures();
  const proposal = { ...proposals[0]!, endEpoch: Math.floor(Date.now() / 1000) + 86400 };
  vi.mocked(HttpBridge.prototype.proposals).mockResolvedValue([proposal]);
  const result = await liveSource(profileRegistry('testnet')).active();
  expect(result).toEqual([{ value: proposal, prov: expect.objectContaining({ kind: 'reported', detail: 'Platform could not be read' }) }]);
});
