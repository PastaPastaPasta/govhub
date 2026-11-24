// @vitest-environment happy-dom
// D-055: a page loaded through useAsync shows a WASM error's message, not "[object Object]".
import { describe, expect, it } from 'vitest';
import { flush, render } from '../test/render.tsx';
import type { CollateralVerdict } from '../verify/collateral.ts';
import { heldVerdict, useAsync } from './hooks.ts';

class WasmSdkError {
  get message() {
    return 'Dapi client error: transport error';
  }
}

function Page() {
  const load = useAsync(() => Promise.reject(new WasmSdkError()), []);
  return <p>{load.loading ? 'loading' : load.error}</p>;
}

describe('D-055: useAsync', () => {
  it('reports the message of an error that is not an Error', async () => {
    const r = await render(<Page />);
    await flush();
    expect(r.el.textContent).toBe('Dapi client error: transport error');
    await r.unmount();
  });
});

describe('a collateral verdict the nodes held up', () => {
  const v = (over: Partial<CollateralVerdict>): CollateralVerdict => ({ ok: false, steps: [], ...over }) as CollateralVerdict;
  it('is retried only when nothing in it is a definite failure', () => {
    expect(heldVerdict(v({ inconclusive: true, throttled: true }))).toBe(true);
    expect(heldVerdict(v({ ok: true, anchorThrottled: true }))).toBe(true);
    expect(heldVerdict(v({ inconclusive: true }))).toBe(false);
    expect(heldVerdict(null)).toBe(false);
    const mismatch = v({ anchorThrottled: true, steps: [{ id: 'fields', status: 'fail', label: 'Displayed fields', detail: 'differ from the hashed data: amount' }] });
    expect(heldVerdict(mismatch)).toBe(false);
  });
});
