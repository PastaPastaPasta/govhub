import { useLocation, useNavigate } from 'react-router-dom';
import { profileFromSearch, profileSearch } from '../config/network.ts';
// App-wide state: endpoint registry, data mode, the data source built from them, and the
// governance snapshot (cycle, height, active proposals, tallies) shared by the header and lists.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { loadSavedRegistry, registryScope, saveRegistry, registryForProfile, type ProfileId, type Registry } from '../config/registry.ts';
import { resolveMode, setMode as persistMode, type DataMode } from '../config/mode.ts';
import { cacheDeleteWhere, cacheGet, cachePut } from '../data/cache.ts';
import { REFRESH_MS, type UsdState } from '../data/price.ts';
import { createSource, type DataSource } from '../data/repo.ts';
import type { Cycle, Proposal, Sourced, Tally } from '../data/types.ts';
import { errText, setDashUnit } from '../lib/format.ts';
import type { GovParams } from '../lib/governance.ts';
import { byRank, deriveRow, partitionByCheck, type Checked, type Row } from '../lib/view.ts';
import { ProposalChecks, type CheckCache, type StoredCheck } from '../verify/checks.ts';
import { runVerification } from '../verify/client.ts';


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
  /** True until both tally reads (Platform's and the bridge's) have answered or failed: counts over the tallies wait for it. */
  talliesLoading: boolean;
  /**
   * Both reads are done, proposals are listed, and not one of them has a tally: the votes couldn't be read (a failed read leaves the
   * maps empty), so nothing counted over them may read as "none in the budget".
   */
  talliesFailed: boolean;
  /** The DASH/USD quote and whether its latest refresh failed (design/PRICE.md); empty off Mainnet. */
  usd: UsdState;
  /** Governance parameters reported for the data's Core network, once known. */
  params: Sourced<GovParams> | null;
}

/**
 * Active proposals as rows, rank order, split into shown, lame ducks (still on the network but nothing left to pay: a collapsed
 * section, outside the budget numbers) and failed-verification (hidden by default).
 */
export interface ActiveRows {
  shown: Checked<Row>[];
  lameDucks: Checked<Row>[];
  failed: Checked<Row>[];
}

interface Ctx {
  registry: Registry;
  /** Saves and applies; throws when the settings cannot be saved (a full storage quota), leaving the current ones in place. */
  setRegistry(r: Registry): void;
  /** Why the saved settings were not used (they failed validation, so the defaults are shown), until dismissed or replaced. */
  settingsProblem: string[] | null;
  dismissSettingsProblem(): void;
  /** One action: the profile's settings replace the current ones, the old profile's document cache is dropped, data reloads. */
  switchProfile(id: ProfileId): void;
  mode: DataMode;
  setMode(m: DataMode): void;
  source: DataSource;
  params: GovParams;
  gov: GovSnapshot;
  checks: ProposalChecks;
  activeRows: ActiveRows;
  reload(): void;
}

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}

const NO_USD: UsdState = { quote: null, failedAt: null };

function useGovSnapshot(source: DataSource, nonce: number): GovSnapshot {
  const [cycle, setCycle] = useState<Load<Sourced<Cycle> | null>>({ loading: true });
  const [height, setHeight] = useState<Load<Sourced<number> | null>>({ loading: true });
  const [active, setActive] = useState<Load<Sourced<Proposal>[]>>({ loading: true });
  const [tallies, setTallies] = useState(new Map<string, Sourced<Tally>>());
  const [bridgeTallies, setBridgeTallies] = useState(new Map<string, Sourced<Tally>>());
  const [tallyReads, setTallyReads] = useState({ platform: false, bridge: false });
  const [usd, setUsd] = useState<UsdState>(NO_USD);
  const [params, setParams] = useState<Sourced<GovParams> | null>(null);
  // A new source (profile, network, endpoints) must not render, or start checks on, the previous source's data for even one frame.
  const resetLoaded = () => {
    setCycle({ loading: true });
    setHeight({ loading: true });
    setActive({ loading: true });
    setParams(null);
    setTallies(new Map());
    setBridgeTallies(new Map());
    setTallyReads({ platform: false, bridge: false });
  };
  const [shownSource, setShownSource] = useState(source);
  if (shownSource !== source) {
    setShownSource(source);
    resetLoaded();
    setUsd(NO_USD);
  }

  useEffect(() => {
    let live = true;
    const guard = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => live && f(...a);
    const settled = (which: 'platform' | 'bridge') => live && setTallyReads((r) => ({ ...r, [which]: true }));
    resetLoaded();
    source.params().then(guard(setParams), () => {});
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
      .catch(() => {})
      .finally(() => settled('platform'));
    source.bridgeTallies().then(guard(setBridgeTallies), () => {}).finally(() => settled('bridge'));
    return () => {
      live = false;
    };
  }, [source, nonce]);

  // the price refreshes on its own clock while the page is open; a failed refresh keeps the last good quote, marked as such
  useEffect(() => {
    let live = true;
    const refresh = () =>
      source.usdPrice().then(
        (quote) => live && setUsd(quote ? { quote, failedAt: null } : NO_USD),
        () => live && setUsd((s) => ({ quote: s.quote, failedAt: Date.now() })),
      );
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [source]);

  const talliesLoading = !(tallyReads.platform && tallyReads.bridge);
  const listed = active.data ?? [];
  const talliesFailed = !talliesLoading && listed.length > 0 && listed.every((p) => !tallies.has(p.value.govHash) && !bridgeTallies.has(p.value.govHash));
  return useMemo(
    () => ({ cycle, height, active, tallies, bridgeTallies, talliesLoading, talliesFailed, usd, params }),
    [cycle, height, active, tallies, bridgeTallies, talliesLoading, talliesFailed, usd, params],
  );
}

const checkCache: CheckCache = {
  get: async (k) => (await cacheGet<StoredCheck>(k))?.value,
  put: (k, v) => cachePut(k, v, null),
};

/** A short, stable tag of a string (FNV-1a), for cache keys. */
function tag(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

const CHECK_TIMEOUT_MS = 90_000;

/**
 * Background collateral checks for a data source: the light variant (node answers, no block proof), two at a time, each given up
 * (inconclusive) after 90 s. Results are keyed by the DAPI nodes asked too: fixing a bad node list re-checks.
 */
function makeChecks(source: DataSource): ProposalChecks {
  const dapi = source.dapiDescriptor();
  return new ProposalChecks({
    scope: `${source.scope}:${tag(JSON.stringify(dapi))}`,
    run: (p) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the check timed out')), CHECK_TIMEOUT_MS);
        runVerification({ kind: 'collateral', proposal: p, dapi, light: true })
          .then((r) => resolve(r.verdict), reject)
          .finally(() => clearTimeout(timer));
      }),
    cache: checkCache,
    concurrency: 2,
  });
}

export function AppProvider({ children, initialMode }: { children: ReactNode; initialMode?: DataMode }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const [saved] = useState(() => loadSavedRegistry());
  const [configuredRegistry, setRegistryState] = useState<Registry>(saved.registry);
  const profile = profileFromSearch(loc.search);
  const registry = useMemo(() => configuredRegistry.profile === profile ? configuredRegistry : registryForProfile(configuredRegistry, profile), [configuredRegistry, profile]);
  const [settingsProblem, setSettingsProblem] = useState<string[] | null>(saved.errors.length ? saved.errors : null);
  const [mode, setModeState] = useState<DataMode>(() => initialMode ?? resolveMode(location.search, sessionStorage, import.meta.env.VITE_GOVHUB_FIXTURES));
  const [nonce, setNonce] = useState(0);
  const source = useMemo(() => createSource(mode, registry), [mode, registry]);
  // before anything below renders an amount: Testnet's practice coins are tDASH
  setDashUnit(source.coreNetwork === 'testnet' ? 'tDASH' : 'DASH');
  const gov = useGovSnapshot(source, nonce);
  const params = gov.params?.value ?? source.defaultParams;
  const checks = useMemo(() => makeChecks(source), [source]);
  useEffect(() => () => checks.dispose(), [checks]);
  const checksVersion = useSyncExternalStore(checks.subscribe, checks.getVersion);
  useEffect(() => {
    if (gov.active.data) checks.ensure(gov.active.data.map((p) => p.value));
  }, [checks, gov.active.data]);
  const now = source.now();
  const activeRows = useMemo<ActiveRows>(() => {
    const rows = (gov.active.data ?? []).map((p) => deriveRow(p, gov.tallies, gov.bridgeTallies, gov.cycle.data ?? null, params, now)).sort(byRank);
    const { shown, failed } = partitionByCheck(rows, (r) => checks.state(r.p.value));
    return { shown: shown.filter((x) => !x.item.lameDuck), lameDucks: shown.filter((x) => x.item.lameDuck), failed };
    // checksVersion: re-split when a check result lands
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gov.active.data, gov.tallies, gov.bridgeTallies, gov.cycle.data, params, now, checks, checksVersion]);

  const setRegistry = useCallback((r: Registry) => {
    saveRegistry(r);
    setRegistryState(r);
    setSettingsProblem(null);
    const search = profileSearch(loc.search, r.profile);
    if (search !== loc.search) navigate({ pathname: loc.pathname, search, hash: loc.hash }, { replace: true });
  }, [loc, navigate]);
  const dismissSettingsProblem = useCallback(() => setSettingsProblem(null), []);
  const setMode = useCallback((m: DataMode) => {
    persistMode(m);
    setModeState(m);
  }, []);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const switchProfile = useCallback(
    (id: ProfileId) => {
      if (id === registry.profile) return;
      const old = `${registryScope(registry)}:`;
      setRegistry(registryForProfile(registry, id)); // first: if it cannot be saved, nothing is switched or dropped
      // Verification results stay (they are keyed by the old scope, so they never leak); the old profile's documents go.
      void cacheDeleteWhere((k) => k.startsWith(old) && !k.includes(':check:'));
    },
    [registry, setRegistry],
  );

  const value = useMemo<Ctx>(
    () => ({ registry, setRegistry, settingsProblem, dismissSettingsProblem, switchProfile, mode, setMode, source, params, gov, checks, activeRows, reload }),
    [registry, setRegistry, settingsProblem, dismissSettingsProblem, switchProfile, mode, setMode, source, params, gov, checks, activeRows, reload],
  );
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
