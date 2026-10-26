// @vitest-environment happy-dom
// AuthorName: a self-chosen name gets an "i" that says what it is and isn't; a Dash username alone gets none.
import { describe, expect, it } from 'vitest';
import { render } from '../test/render.tsx';
import { AuthorName } from './Identity.tsx';

const ID = 'ATWqrABCDEFGHJKLMNPQRSTUVWXYZabcdefghiXi8rs';
const profile = { ownerId: ID, displayName: 'Pasta' } as never;

describe('AuthorName', () => {
  it('a self-chosen name has an info popover saying it is not unique and not a Dash username', async () => {
    const r = await render(<AuthorName id={ID} profile={profile} />);
    const btn = r.el.querySelector<HTMLButtonElement>('[data-testid="name-info"]')!;
    expect(btn.getAttribute('aria-label')).toBe('About this name');
    const pop = r.el.querySelector(`[id="${btn.getAttribute('popovertarget')}"]`)!;
    expect(pop.textContent).toMatch(/“Pasta” is a name the poster chose\. Anyone can pick any name, and two people can pick the same one/);
    expect(pop.textContent).toMatch(/It isn’t a Dash username/);
    await r.unmount();
  });

  it('next to a Dash username, it points at the username as the unique one', async () => {
    const r = await render(<AuthorName id={ID} profile={profile} dpns="pasta.dash" />);
    expect(r.el.querySelector('[role="note"]')!.textContent).toMatch(/The underlined pasta\.dash is their Dash username, which is unique/);
    await r.unmount();
  });

  it('a Dash username with no chosen name gets no info button', async () => {
    const r = await render(<AuthorName id={ID} dpns="pasta.dash" />);
    expect(r.el.querySelector('[data-testid="name-info"]')).toBeNull();
    await r.unmount();
  });
});
