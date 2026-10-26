// @vitest-environment happy-dom
// /about: the plain-language page, and its links to the in-app explanations and the docs on GitHub.
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { render } from '../test/render.tsx';
import { AboutPage, DONATION_ADDRESS, PRIVACY_DOC_URL, SELF_HOSTING_DOC_URL } from './AboutPage.tsx';

describe('About page', () => {
  it('links the verification and trust pages in the app, and the privacy and self-hosting docs on GitHub', async () => {
    const r = await render(
      <MemoryRouter>
        <AboutPage />
      </MemoryRouter>,
    );
    expect(r.el.querySelector('h1')?.textContent).toBe('About govhub');
    const hrefs = [...r.el.querySelectorAll<HTMLAnchorElement>('a')].map((a) => a.getAttribute('href'));
    for (const h of ['/about/verification', '/about/trust', '/settings', PRIVACY_DOC_URL, SELF_HOSTING_DOC_URL]) expect(hrefs).toContain(h);
    expect(PRIVACY_DOC_URL).toBe('https://github.com/PastaPastaPasta/govhub/blob/main/docs/privacy.md');
    expect(SELF_HOSTING_DOC_URL).toBe('https://github.com/PastaPastaPasta/govhub/blob/main/docs/self-hosting.md');
    for (const a of r.el.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')) expect(a.rel).toContain('noopener');
    // the operations wallet, checked against the ops seed (m/44'/5'/0'/0/1) with two independent implementations
    expect(DONATION_ADDRESS).toBe('XcLkMQensjHhr5r9SAUVm4meh2HFKaeAXG');
    expect(r.el.querySelector('[data-testid="donation-address"]')?.getAttribute('href')).toBe(`dash:${DONATION_ADDRESS}`);
    await r.unmount();
  });
});
