// @vitest-environment happy-dom
// D-055: a page loaded through useAsync shows a WASM error's message, not "[object Object]".
import { describe, expect, it } from 'vitest';
import { flush, render } from '../test/render.tsx';
import { useAsync } from './hooks.ts';

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
