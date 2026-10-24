// Data mode: live Platform/DAPI/bridge reads, or the recorded mainnet fixture snapshot.
// `?fixtures=1` turns fixture mode on for the tab (sessionStorage), `?fixtures=0` turns it off;
// VITE_GOVHUB_FIXTURES=1 makes it the default for a build.
export type DataMode = 'live' | 'fixtures';

const KEY = 'govhub.fixtures';

export function resolveMode(search: string, session: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined, envDefault: string | undefined): DataMode {
  const p = new URLSearchParams(search).get('fixtures');
  if (p === '1' || p === 'true') session?.setItem(KEY, '1');
  else if (p === '0' || p === 'false') session?.setItem(KEY, '0');
  const stored = session?.getItem(KEY);
  if (stored === '1') return 'fixtures';
  if (stored === '0') return 'live';
  return envDefault === '1' ? 'fixtures' : 'live';
}

export function setMode(mode: DataMode, session: Pick<Storage, 'setItem'> | undefined = globalThis.sessionStorage): void {
  session?.setItem(KEY, mode === 'fixtures' ? '1' : '0');
}
