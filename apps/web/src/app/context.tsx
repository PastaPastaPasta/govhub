// App-wide state: endpoint registry, data mode, the data source built from them, theme, and the
// governance snapshot (cycle, height, active proposals, tallies) shared by the header and lists.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { loadRegistry, saveRegistry, type Registry } from '../config/registry.ts';
import { resolveMode, setMode as persistMode, type DataMode } from '../config/mode.ts';
import { createSource, type DataSource } from '../data/repo.ts';
import type { Cycle, Proposal, Sourced, Tally } from '../data/types.ts';
import { GOV_PARAMS, type GovParams } from '../lib/governance.ts';

export type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'govhub.theme';

export interface Load<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

export interface GovSnapshot {
  cycle: Load<Sourced<Cycle> | null>;
  height: Load<Sourced<number> | null>;
  active: Load<Sourced<Proposal>[]>;
  tallies: Map<string, Sourced<Tally>>;
  bridgeTallies: Map<string, Sourced<Tally>>;
  usd: Sourced<number> | null;
}

interface Ctx {
  registry: Registry;
  setRegistry(r: Registry): void;
  mode: DataMode;
  setMode(m: DataMode): void;
  source: DataSource;
  params: GovParams;
  theme: Theme;
  setTheme(t: Theme): void;
  gov: GovSnapshot;
  reload(): void;
}

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useGovSnapshot(source: DataSource, nonce: number): GovSnapshot {
  const [cycle, setCycle] = useState<Load<Sourced<Cycle> | null>>({ loading: true });
  const [height, setHeight] = useState<Load<Sourced<number> | null>>({ loading: true });
  const [active, setActive] = useState<Load<Sourced<Proposal>[]>>({ loading: true });
  const [tallies, setTallies] = useState(new Map<string, Sourced<Tally>>());
  const [bridgeTallies, setBridgeTallies] = useState(new Map<string, Sourced<Tally>>());
  const [usd, setUsd] = useState<Sourced<number> | null>(null);

  useEffect(() => {
    let live = true;
    const guard = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => live && f(...a);
    setCycle({ loading: true });
    setHeight({ loading: true });
    setActive({ loading: true });
    source.cycle(guard((c) => setCycle({ data: c, loading: true }))).then(guard((c) => setCycle({ data: c, loading: false })), guard((e) => setCycle({ error: errText(e), loading: false })));
    source.height().then(guard((h) => setHeight({ data: h, loading: false })), guard((e) => setHeight({ error: errText(e), loading: false })));
    source
      .active(guard((ps) => setActive({ data: ps, loading: true })))
      .then(
        guard(async (ps) => {
          setActive({ data: ps, loading: false });
          if (!ps.length) return;
          const t = await source.tallies(ps.map((p) => p.value.govHash));
          if (live) setTallies(t);
        }),
        guard((e) => setActive({ error: errText(e), loading: false })),
      )
      .catch(() => {});
    source.bridgeTallies().then(guard(setBridgeTallies), () => {});
    source.usdPrice().then(guard(setUsd), () => {});
    return () => {
      live = false;
    };
  }, [source, nonce]);

  return useMemo(() => ({ cycle, height, active, tallies, bridgeTallies, usd }), [cycle, height, active, tallies, bridgeTallies, usd]);
}

export function AppProvider({ children, initialMode }: { children: ReactNode; initialMode?: DataMode }) {
  const [registry, setRegistryState] = useState<Registry>(() => loadRegistry());
  const [mode, setModeState] = useState<DataMode>(() => initialMode ?? resolveMode(location.search, sessionStorage, import.meta.env.VITE_GOVHUB_FIXTURES));
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem(THEME_KEY) as Theme | null) ?? 'system');
  const [nonce, setNonce] = useState(0);
  const source = useMemo(() => createSource(mode, registry), [mode, registry]);
  const gov = useGovSnapshot(source, nonce);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', theme);
  }, [theme]);

  const setRegistry = useCallback((r: Registry) => {
    saveRegistry(r);
    setRegistryState(r);
  }, []);
  const setMode = useCallback((m: DataMode) => {
    persistMode(m);
    setModeState(m);
  }, []);
  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(THEME_KEY, t);
    setThemeState(t);
  }, []);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const value = useMemo<Ctx>(
    () => ({ registry, setRegistry, mode, setMode, source, params: GOV_PARAMS[registry.coreNetwork], theme, setTheme, gov, reload }),
    [registry, setRegistry, mode, setMode, source, theme, setTheme, gov, reload],
  );
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
