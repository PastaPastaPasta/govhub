// @vitest-environment happy-dom
// A link to a proposal on another network (a Mainnet link opened on Testnet) offers that network instead of a bare "Not found".
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileId, Registry } from '../config/registry.ts';
import { button, click, flush, render } from '../test/render.tsx';

const HASH = 'ab'.repeat(32);
const NAME = 'Dash_Italia_SiGMA_AIBC_Rome_Refund';
const doc = { value: { govHash: HASH, name: NAME }, prov: { kind: 'proof', source: 'test' } };

type Holds = Partial<Record<ProfileId, 'has' | 'none' | 'error'>>;
const hold = vi.hoisted(() => ({ on: {} as Record<string, string>, asked: [] as string[] }));
const answer = async <T,>(id: ProfileId, yes: T, no: T): Promise<T> => {
  hold.asked.push(id);
  const a = hold.on[id] ?? 'none';
  if (a === 'error') throw new Error('unreachable');
  return a === 'has' ? yes : no;
};
vi.mock('../data/repo.ts', () => ({
  liveSource: (r: Registry) => ({ proposal: () => answer(r.profile, doc, null), byName: () => answer(r.profile, [doc], []) }),
}));

const switchProfile = vi.fn();
const app = {
  mode: 'live',
  registry: { profile: 'testnet', forum: { claimPortals: [] } },
  switchProfile,
  source: { proposal: async () => null, byName: async () => [] },
};
vi.mock('../app/context.tsx', () => ({ useApp: () => app }));
const { ProposalByHash, ProposalByName } = await import('./ProposalPage.tsx');

beforeEach(() => {
  hold.on = {};
  hold.asked = [];
  app.mode = 'live';
  app.registry.profile = 'testnet';
  switchProfile.mockReset();
});

const at = async (path: string, el: ReactElement, route: string, on: Holds) => {
  hold.on = on;
  const r = await render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={el} />
      </Routes>
    </MemoryRouter>,
  );
  await flush();
  await flush();
  return r;
};

describe('a proposal that exists on another network', () => {
  it('a Mainnet proposal opened by name on Testnet: says it is on Mainnet, and one button switches', async () => {
    const r = await at(`/p/${NAME}`, <ProposalByName />, '/p/:name', { mainnet: 'has' });
    const el = r.el.querySelector('[data-testid="elsewhere"]')!;
    expect(el.textContent).toContain('This proposal is on Mainnet');
    expect(el.textContent).toContain(`You are viewing Testnet, which has no record of a proposal named "${NAME}"`);
    expect(r.el.textContent).not.toMatch(/Not found/);
    expect(hold.asked).toEqual(['mainnet']); // Mainnet first, and nothing after a hit
    await click(button(r.el, /Switch to Mainnet/));
    expect(switchProfile).toHaveBeenCalledWith('mainnet');
    await r.unmount();
  });

  it('by hash, on Mainnet, found on Testnet: offers Testnet; Dev is never offered, even when it has it', async () => {
    app.registry.profile = 'mainnet';
    const r = await at(`/p/h/${HASH}`, <ProposalByHash />, '/p/h/:hash', { testnet: 'has' });
    expect(r.el.textContent).toContain('This proposal is on Testnet');
    expect(hold.asked).toEqual(['testnet']);
    await r.unmount();

    hold.asked = [];
    const r2 = await at(`/p/h/${HASH}`, <ProposalByHash />, '/p/h/:hash', { dev: 'has' });
    expect(r2.el.textContent).toContain('Not found');
    expect(hold.asked).toEqual(['testnet']);
    await r2.unmount();
  });

  it('on Dev: a profile that cannot be read is skipped, and the next one is asked', async () => {
    app.registry.profile = 'dev';
    const r = await at(`/p/h/${HASH}`, <ProposalByHash />, '/p/h/:hash', { mainnet: 'error', testnet: 'has' });
    expect(r.el.textContent).toContain('This proposal is on Testnet');
    expect(hold.asked).toEqual(['mainnet', 'testnet']);
    await r.unmount();
  });

  it('a malformed hash asks no network', async () => {
    const r = await at('/p/h/nothex', <ProposalByHash />, '/p/h/:hash', { mainnet: 'has' });
    expect(r.el.textContent).toContain('Not found');
    expect(r.el.textContent).not.toMatch(/Checking the other networks/);
    expect(hold.asked).toEqual([]);
    await r.unmount();
  });

  it('a switch that cannot be saved says why', async () => {
    switchProfile.mockImplementation(() => {
      throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    });
    const r = await at(`/p/${NAME}`, <ProposalByName />, '/p/:name', { mainnet: 'has' });
    await click(button(r.el, /Switch to Mainnet/));
    expect(r.el.querySelector('[role="alert"]')!.textContent).toMatch(/storage for govhub is full/);
    await r.unmount();
  });

  it('nowhere: the plain "Not found", naming the network it looked on', async () => {
    const r = await at(`/p/${NAME}`, <ProposalByName />, '/p/:name', {});
    expect(r.el.textContent).toContain('Not found');
    expect(r.el.textContent).toContain(`Platform has no record of a proposal named "${NAME}" on Testnet`);
    expect(r.el.querySelector('[data-testid="elsewhere"]')).toBeNull();
    expect(hold.asked).toEqual(['mainnet']);
    await r.unmount();
  });

  it('fixture mode asks no other network', async () => {
    app.mode = 'fixtures';
    const r = await at(`/p/${NAME}`, <ProposalByName />, '/p/:name', { mainnet: 'has' });
    expect(r.el.textContent).toContain('Not found');
    expect(hold.asked).toEqual([]);
    await r.unmount();
  });
});
