// @vitest-environment happy-dom
// EvoVote's old links forward to /names/<label>?network=…&from=vote: the arrival is explained once, and the marker leaves the URL.
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { render } from '../test/render.tsx';
import { MovedFromVote } from './MovedFromVote.tsx';

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

const at = (url: string) => (
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="*" element={<><MovedFromVote /><Where /></>} />
    </Routes>
  </MemoryRouter>
);

describe('arriving from EvoVote', () => {
  it('says where EvoVote went, and keeps the network but drops the marker', async () => {
    const r = await render(at('/names/g01d?network=testnet&from=vote'));
    expect(r.el.querySelector('[data-testid="moved-from-vote"]')?.textContent).toContain('EvoVote now lives here');
    expect(r.el.querySelector('[data-testid="where"]')?.textContent).toBe('/names/g01d?network=testnet');
    await r.unmount();
  });
  it('says nothing to anyone else', async () => {
    const r = await render(at('/names/g01d?network=mainnet'));
    expect(r.el.querySelector('[data-testid="moved-from-vote"]')).toBeNull();
    await r.unmount();
  });
});
