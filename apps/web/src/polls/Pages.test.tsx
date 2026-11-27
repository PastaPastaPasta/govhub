// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { click, render } from '../test/render.tsx';
import { DRAFT_KEY } from './model.ts';
const hold = vi.hoisted(() => ({ registry: { platformNetwork: 'testnet' }, networks: [] as string[], open: vi.fn(), list: vi.fn().mockResolvedValue([]), results: vi.fn(), forum: { names: async () => new Map() } }));
vi.mock('../app/context.tsx', () => ({ useApp: () => ({ registry: hold.registry }) }));
vi.mock('../app/forum.tsx', () => ({ useForum: () => ({ session: null, forum: hold.forum }) }));
vi.mock('../auth/context.tsx', () => ({ useAuth: () => ({ openSheet: hold.open }) }));
vi.mock('./source.ts', () => ({ pollSource: (registry: { platformNetwork: string }) => { hold.networks.push(registry.platformNetwork); return { list: hold.list, results: hold.results, estimate: async () => 40_000_000 }; } }));
const { NewPollPage, PollsPage } = await import('./Pages.tsx');
beforeEach(() => { sessionStorage.clear(); vi.clearAllMocks(); hold.networks.length = 0; hold.registry.platformNetwork = 'testnet'; hold.list.mockResolvedValue([]); });
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
  it('reads a labelled Testnet preview on Mainnet and clears profile overrides from the switch', async () => {
    hold.registry = { platformNetwork: 'mainnet' };
    hold.list.mockResolvedValue(Array.from({ length: 4 }, (_, i) => ({ id: `poll${i}`, createdAt: 1, endsAt: 2, question: `Question ${i}?`, options: ['Yes', 'No'] })));
    const r = await render(<MemoryRouter initialEntries={['/polls?network=mainnet&profile=mainnet&fixtures=1']}><PollsPage /></MemoryRouter>);
    await vi.waitFor(() => expect(r.el.textContent).toContain('Question 0?'));
    expect(r.el.textContent).toContain('Recent Testnet polls');
    expect(r.el.textContent).toContain('Read-only preview');
    expect(r.el.textContent).toContain('Yes · No');
    expect(r.el.textContent).not.toContain('Question 3?');
    expect(r.el.querySelector('a')!.getAttribute('href')).toBe('/polls?network=testnet');
    expect(r.el.querySelector('.poll-preview-list a')!.getAttribute('href')).toBe('/polls/poll0?network=testnet');
    expect(hold.networks).toEqual(['testnet']);
    expect(hold.results).not.toHaveBeenCalled();
    expect(r.el.querySelector('button')).toBeNull();
    await r.unmount();
  });
  it('keeps an honest empty preview when Testnet has no polls', async () => {
    hold.registry = { platformNetwork: 'mainnet' };
    const r = await render(<MemoryRouter><PollsPage /></MemoryRouter>);
    await vi.waitFor(() => expect(r.el.textContent).toContain('No Testnet polls yet'));
    expect(r.el.textContent).not.toContain('records checked');
    await r.unmount();
  });
  it('shows a retryable error instead of inventing Testnet polls', async () => {
    hold.registry = { platformNetwork: 'mainnet' };
    hold.list.mockRejectedValueOnce(Error('Testnet unavailable'));
    const r = await render(<MemoryRouter><PollsPage /></MemoryRouter>);
    await vi.waitFor(() => expect(r.el.textContent).toContain('The Testnet preview could not be read'));
    expect(r.el.querySelector('.poll-preview-list')).toBeNull();
    expect(r.el.textContent).not.toContain('records checked');
    const retry = [...r.el.querySelectorAll('button')].find(b => b.textContent === 'Retry')!;
    await click(retry);
    await vi.waitFor(() => expect(r.el.textContent).toContain('No Testnet polls yet'));
    expect(hold.list).toHaveBeenCalledTimes(2);
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
  it.each([
    { counts: [1, 1], selections: 2, text: 'Tied at 50%' },
    { counts: [3, 1], selections: 4, text: 'Yes leads with 75%' },
    { counts: [0, 0], selections: 0, text: 'No answers yet' },
    { counts: [2, 2, 1], selections: 5, text: 'Tied at 40%' },
  ])('summarizes $counts as $text and surfaces recent closed polls', async ({ counts, selections, text }) => {
    hold.list.mockResolvedValue([{ id: 'poll', owner: 'owner', createdAt: 1, endsAt: 2, question: 'Ship it?', options: ['Yes', 'No', 'Later'].slice(0, counts.length), multiChoice: false }]);
    hold.results.mockResolvedValue({ counts, selections, identities: selections, late: counts.map(() => 0), userChoices: [] });
    const r = await render(<MemoryRouter><PollsPage /></MemoryRouter>);
    await vi.waitFor(() => expect(r.el.textContent).toContain(text));
    expect(r.el.textContent).toContain('No open polls right now');
    expect(r.el.textContent).toContain('Recent closed polls');
    expect(r.el.querySelector('.poll-meta')?.textContent).toContain('Closed 1 Jan 1970');
    expect(r.el.querySelector('.poll-meta')?.textContent).not.toMatch(/closes/i);
    if (text.startsWith('Tied')) expect(r.el.textContent).not.toContain('leads with');
    const closed = [...r.el.querySelectorAll('button')].find(b => b.textContent === 'Closed')!;
    expect(closed.getAttribute('aria-pressed')).toBe('false');
    await click(closed);
    await vi.waitFor(() => expect(closed.getAttribute('aria-pressed')).toBe('true'));
    expect(r.el.textContent).not.toContain('No open polls right now');
    expect(r.el.textContent).toContain(text);
    await r.unmount();
  });

});
