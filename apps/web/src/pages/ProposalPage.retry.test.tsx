// @vitest-environment happy-dom
// F4: one failed Platform or quorum read no longer strands the proposal page: plain words and a Retry that re-runs the load in place.
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { click, flush, render } from '../test/render.tsx';

const HASH = 'ab'.repeat(32);
let reads: Array<() => Promise<unknown>> = [];
let calls = 0;
const source = { proposal: () => (calls++, (reads.shift() ?? (async () => null))()), byName: () => (calls++, (reads.shift() ?? (async () => []))()) };
const app = { source, registry: { forum: { claimPortals: [] } } };
vi.mock('../app/context.tsx', () => ({ useApp: () => app }));
const { ProposalByHash, ProposalByName } = await import('./ProposalPage.tsx');

beforeEach(() => {
  reads = [];
  calls = 0;
});

const at = (path: string, el: ReactElement, route: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={el} />
      </Routes>
    </MemoryRouter>,
  );

describe('F4: the proposal page retries a failed read', () => {
  it('a dropped connection: plain words with a Retry; Retry re-runs the read without a reload', async () => {
    reads = [async () => Promise.reject(new Error('Failed to prefetch quorums: HTTP request error: error sending request'))];
    const r = await at(`/p/h/${HASH}`, <ProposalByHash />, '/p/h/:hash');
    await flush();
    const err = r.el.querySelector('[data-testid="read-error"]')!;
    expect(err.textContent).toMatch(/Could not reach Platform just now/);
    expect(err.textContent).toMatch(/Try again in a moment/);
    expect(err.textContent).not.toMatch(/^Platform could not be read: Failed/);
    expect(calls).toBe(1);
    await click(err.querySelector<HTMLButtonElement>('[data-testid="read-retry"]')!);
    await flush();
    expect(calls).toBe(2);
    expect(r.el.querySelector('[data-testid="read-error"]')).toBeNull();
    expect(r.el.textContent).toMatch(/Not found/); // the second read answered: no such proposal
    await r.unmount();
  });

  it('another failure keeps its text, after "The proposal could not be read", and also has Retry', async () => {
    reads = [async () => Promise.reject(new Error('the bridge answered HTTP 418'))];
    const r = await at(`/p/h/${HASH}`, <ProposalByHash />, '/p/h/:hash');
    await flush();
    const err = r.el.querySelector('[data-testid="read-error"]')!;
    expect(err.textContent).toContain('The proposal could not be read: the bridge answered HTTP 418');
    expect(err.querySelector('[data-testid="read-retry"]')).toBeTruthy();
    await r.unmount();
  });

  it('the by-name page too', async () => {
    reads = [async () => Promise.reject(new Error('WebAssembly compilation aborted: Network error'))];
    const r = await at('/p/some-name', <ProposalByName />, '/p/:name');
    await flush();
    expect(r.el.querySelector('[data-testid="read-error"]')!.textContent).toMatch(/Could not reach Platform just now/);
    await click(r.el.querySelector<HTMLButtonElement>('[data-testid="read-retry"]')!);
    await flush();
    expect(calls).toBe(2);
    expect(r.el.textContent).toMatch(/Not found/);
    await r.unmount();
  });
});
