// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render } from '../test/render.tsx';
import { DRAFT_KEY } from './model.ts';
const hold = vi.hoisted(() => ({ registry: { platformNetwork: 'testnet' }, open: vi.fn(), list: vi.fn().mockResolvedValue([]) }));
vi.mock('../app/context.tsx', () => ({ useApp: () => ({ registry: hold.registry }) }));
vi.mock('../app/forum.tsx', () => ({ useForum: () => ({ session: null, forum: { names: async () => new Map() } }) }));
vi.mock('../auth/context.tsx', () => ({ useAuth: () => ({ openSheet: hold.open }) }));
vi.mock('./source.ts', () => ({ pollSource: () => ({ list: hold.list, estimate: async () => 40_000_000 }) }));
const { NewPollPage, PollsPage } = await import('./Pages.tsx');
beforeEach(() => { sessionStorage.clear(); vi.clearAllMocks(); hold.registry.platformNetwork = 'testnet'; });
const composer = () => render(<MemoryRouter initialEntries={['/polls/new?network=testnet']}><NewPollPage /></MemoryRouter>);
describe('Polls within Governance', () => {
  it('preserves all fields through sign-in and a full remount', async () => {
    const draft = { question: 'Which day should we meet?', options: ['Saturday', 'Sunday'], multiChoice: true, close: '2030-01-01T12:00' };
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    const first = await composer();
    first.el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(hold.open).toHaveBeenCalledWith('choose'));
    await first.unmount();
    const second = await composer();
    expect(second.el.querySelector('textarea')!.value).toBe(draft.question);
    expect([...second.el.querySelectorAll<HTMLInputElement>('input[maxlength]')].map(i => i.value)).toEqual(draft.options);
    expect(second.el.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);
    expect(second.el.querySelector<HTMLInputElement>('input[type=datetime-local]')!.value).toBe(draft.close);
    await second.unmount();
  });
  it('shows the Testnet action on Mainnet without reading polls', async () => {
    hold.registry = { platformNetwork: 'mainnet' };
    const r = await render(<MemoryRouter initialEntries={['/polls?network=mainnet']}><PollsPage /></MemoryRouter>);
    expect(r.el.textContent).toContain('Polls run on Testnet');
    expect(r.el.querySelector('a')!.getAttribute('href')).toBe('/polls?network=testnet');
    expect(hold.list).not.toHaveBeenCalled();
    await r.unmount();
  });
  it('offers one create action in the empty list and none in the archive', async () => {
    const current = await render(<MemoryRouter><PollsPage /></MemoryRouter>);
    expect(current.el.querySelectorAll('a[href="/polls/new"]')).toHaveLength(1);
    expect(current.el.textContent).not.toContain('Example:');
    await current.unmount();
    const archive = await render(<MemoryRouter><PollsPage archive /></MemoryRouter>);
    expect(archive.el.querySelector('a[href="/polls/new"]')).toBeNull();
    expect(archive.el.textContent).toContain('read-only');
    await archive.unmount();
  });
});
