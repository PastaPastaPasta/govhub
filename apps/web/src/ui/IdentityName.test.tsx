// @vitest-environment happy-dom
// One way to name an identity: its primary DPNS name when it has one, else its short id, the full id in the tooltip either way; the
// signed-in account chip names the user the same way (DPNS name, then the self-chosen name, then the short id).
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush, render } from '../test/render.tsx';

const ID = 'ATWqrABCDEFGHJKLMNPQRSTUVWXYZabcdefghiXi8rs';
const OTHER = 'GgZekwh38XcWQTyWWWvmw6CEYFnLU7yiZFPWZEjqKHit';
const h = vi.hoisted(() => ({ names: new Map<string, string>(), asked: [] as string[][], profileName: null as string | null, session: null as unknown }));
const forum = {
  names: async (ids: readonly string[]) => {
    h.asked.push([...ids]);
    return new Map(ids.filter((i) => h.names.has(i)).map((i) => [i, h.names.get(i)!]));
  },
  reader: { profiles: async (ids: string[]) => new Map(h.profileName ? ids.map((i) => [i, { ownerId: i, displayName: h.profileName }]) : []) },
};
vi.mock('../app/forum.tsx', () => ({ useForum: () => ({ forum, session: h.session, balance: null }) }));
vi.mock('../auth/context.tsx', () => ({ OPEN_SIGNIN_EVENT: 'x', useAuth: () => ({ session: null, restoring: false, openSheet: () => {}, signOut: () => {} }) }));
vi.mock('../app/context.tsx', () => ({ useApp: () => ({ theme: 'system', setTheme: () => {} }) }));

const { IdentityName } = await import('./Identity.tsx');
const { SessionControl } = await import('./SignIn.tsx');

afterEach(() => {
  h.names = new Map();
  h.asked = [];
  h.profileName = null;
  h.session = null;
  document.body.innerHTML = '';
});

describe('IdentityName', () => {
  it('shows the DPNS name, with the full id in the tooltip', async () => {
    h.names.set(ID, 'pasta.dash');
    const r = await render(<IdentityName id={ID} />);
    await flush();
    const el = r.el.querySelector('[data-testid="identity-name"]')!;
    expect(el.textContent).toBe('pasta.dash');
    expect(el.getAttribute('title')).toContain(ID);
    await r.unmount();
  });

  it('falls back to the short id when there is no name, the full id still in the tooltip', async () => {
    const r = await render(<IdentityName id={ID} />);
    await flush();
    const el = r.el.querySelector('[data-testid="identity-name"]')!;
    expect(el.textContent).toBe('ATWq…i8rs');
    expect(el.getAttribute('title')).toBe(ID);
    await r.unmount();
  });

  it('takes a name the caller already has without asking again', async () => {
    const r = await render(<IdentityName id={ID} dpns="known.dash" />);
    await flush();
    expect(r.el.textContent).toBe('known.dash');
    expect(h.asked).toEqual([]);
    await r.unmount();
  });
});

describe('the account chip', () => {
  const signedIn = (id: string) => (h.session = { identityId: id, label: 'Dash wallet, key 6 (HIGH)' });

  it('names the user by their DPNS name before their self-chosen one', async () => {
    h.names.set(ID, 'pasta.dash');
    h.profileName = 'Pasta';
    signedIn(ID);
    const r = await render(<MemoryRouter><SessionControl /></MemoryRouter>);
    await flush();
    expect(r.el.querySelector('[data-testid="session-name"]')!.textContent).toBe('pasta.dash');
    expect(r.el.querySelector('[data-testid="session-button"]')!.getAttribute('title')).toContain(ID);
    expect(r.el.querySelector('.menu-name')!.textContent).toBe('pasta.dashPasta');
    await r.unmount();
  });

  it('without a DPNS name: the self-chosen name, else the short id', async () => {
    h.profileName = 'Pasta';
    signedIn(ID);
    const r = await render(<MemoryRouter><SessionControl /></MemoryRouter>);
    await flush();
    expect(r.el.querySelector('[data-testid="session-name"]')!.textContent).toBe('Pasta');
    await r.unmount();
    h.profileName = null;
    signedIn(OTHER);
    const r2 = await render(<MemoryRouter><SessionControl /></MemoryRouter>);
    await flush();
    expect(r2.el.querySelector('[data-testid="session-name"]')!.textContent).toBe('GgZe…KHit');
    await r2.unmount();
  });
});
