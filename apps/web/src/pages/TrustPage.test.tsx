// @vitest-environment happy-dom
// "What we can and can't lie about": the plain-language trust page, and the link to it from the "How do we know?" drawer.
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Proposal } from '../data/types.ts';
import { click, render } from '../test/render.tsx';
import { aggregate, REQUIRED } from '../verify/aggregate.ts';
import type { ProposalTrust } from '../ui/trust/useProposalTrust.ts';
import { TRUST_DOC_URL, TrustPage } from './TrustPage.tsx';

vi.mock('../app/context.tsx', () => ({
  useApp: () => ({ mode: 'fixtures', source: { bridgeDescriptor: () => null, now: () => 1_790_000_000 } }),
}));

const { VerificationDrawer } = await import('../ui/trust/VerificationDrawer.tsx');

const proposal: Proposal = {
  govHash: 'ab'.repeat(32),
  parentHash: '00'.repeat(32),
  revision: 1,
  time: 1_789_000_000,
  dataHex: '7b7d',
  name: 'test-proposal',
  url: 'https://example.org',
  paymentAddress: 'XpESxaUmonkq8RaLLp46Brx2K39ggQe226',
  paymentAmount: 1,
  startEpoch: 1_789_000_000,
  endEpoch: 1_792_000_000,
  collateralTxid: 'cd'.repeat(32),
  collateralHeight: 2_500_000,
};

const run = { result: null, error: null, progress: '', running: true };
const trust: ProposalTrust = {
  aggregate: aggregate(REQUIRED.map((id) => ({ id, state: { status: 'pending' } }))),
  collateral: { verdict: null, progress: '', error: null },
  chain: { report: null, progress: '', error: null, unavailable: null, payments: { pending: false, error: null, progress: '' } } as unknown as ProposalTrust['chain'],
  votes: run,
  ranking: null,
  funded: null,
  shown: null,
  targets: [],
  recheck: () => {},
  rankNow: null,
};

describe('trust page', () => {
  it('lists what a backend could and could not lie about, and links to docs/TRUST.md', async () => {
    const r = await render(
      <MemoryRouter>
        <TrustPage />
      </MemoryRouter>,
    );
    const points = r.el.querySelectorAll('[data-testid="trust-points"] > li');
    expect(points.length).toBeGreaterThanOrEqual(5);
    expect(points.length).toBeLessThanOrEqual(8);
    expect(r.el.querySelector('h1')?.textContent).toBe('What we can and can’t lie about');
    const doc = r.el.querySelector<HTMLAnchorElement>('[data-testid="trust-doc-link"]')!;
    expect(doc.href).toBe(TRUST_DOC_URL);
    expect(TRUST_DOC_URL).toMatch(/^https:\/\/github\.com\/PastaPastaPasta\/govhub\/blob\/main\/docs\/TRUST\.md$/);
    expect(doc.rel).toContain('noopener');
    await r.unmount();
  });

  it('is linked from the "How do we know?" drawer, which closes on the way', async () => {
    const onClose = vi.fn();
    const r = await render(
      <MemoryRouter initialEntries={['/p/h/x']}>
        <Routes>
          <Route path="/p/h/x" element={<VerificationDrawer sp={{ value: proposal, prov: { kind: 'fixture', source: 'test' } }} trust={trust} cycle={null} open onClose={onClose} />} />
          <Route path="/about/trust" element={<TrustPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const link = r.el.querySelector<HTMLAnchorElement>('[data-testid="trust-page-link"]')!;
    expect(link.textContent).toBe("What we can and can't lie about");
    expect(link.getAttribute('href')).toBe('/about/trust');
    await click(link);
    expect(onClose).toHaveBeenCalled();
    expect(r.el.querySelector('h1')?.textContent).toBe('What we can and can’t lie about');
    await r.unmount();
  });
});
