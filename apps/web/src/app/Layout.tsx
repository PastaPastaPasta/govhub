import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useContestsShown } from '../contests/useContests.ts';
import { configParamUrl, DAMAGED_CONFIG, fetchConfig, PROFILES, readInlineConfig, registryDiff, registryRows, saveErrorText, type Registry } from '../config/registry.ts';
import { useAuth } from '../auth/context.tsx';
import { SessionControl } from '../ui/SignIn.tsx';
import { ChainShield } from '../ui/trust/ChainShield.tsx';
import { useApp } from './context.tsx';
import { PRIVACY_DOC_URL } from '../pages/AboutPage.tsx';

// The sign-in sheet (BIP39 wordlist, BIP32, HPKE, tx building) loads when it is first opened.
const AuthSheet = lazy(() => import('../auth/AuthSheet.tsx').then((m) => ({ default: m.AuthSheet })));

function LazyAuthSheet() {
  const { sheet } = useAuth();
  // Once loaded it stays mounted: unmounting the open <dialog> skipped close(), and focus fell to <body> instead of going back.
  const [loaded, setLoaded] = useState(false);
  if (sheet && !loaded) setLoaded(true);
  return loaded ? (
    <Suspense fallback={null}>
      <AuthSheet />
    </Suspense>
  ) : null;
}

/**
 * A click that lands on a button the moment it appears may have been aimed at something else (a page that opened govhub in a popup
 * can time a double click). The button arms only after the banner has been on screen for a moment, and disarms whenever the
 * window loses focus or visibility.
 */
function useArmed(ms = 750): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const rearm = () => {
      setArmed(false);
      clearTimeout(t);
      if (document.visibilityState === 'visible' && document.hasFocus()) t = setTimeout(() => setArmed(true), ms);
    };
    rearm();
    const events = ['focus', 'blur', 'visibilitychange'] as const;
    for (const e of events) (e === 'visibilitychange' ? document : window).addEventListener(e, rearm);
    return () => {
      clearTimeout(t);
      for (const e of events) (e === 'visibilitychange' ? document : window).removeEventListener(e, rearm);
    };
  }, [ms]);
  return armed;
}

type Offer = { param: string; registry: Registry; errors: string[] };

/**
 * `?config=` in the URL: show what it would change and let the user apply or dismiss it. Inline (base64url) settings are read at
 * once, without the network; a URL is fetched only after the user agrees, since the request alone tells that host who opened the
 * link. (Inside a frame the app does not render at all: app/frame.tsx.)
 */
function ConfigOffer() {
  const { registry, setRegistry } = useApp();
  const loc = useLocation();
  const nav = useNavigate();
  const param = new URLSearchParams(loc.search).get('config');
  const url = param ? configParamUrl(param) : null;
  const [offer, setOffer] = useState<Offer | null>(null);
  // the value being fetched: a response for any other value (the link changed meanwhile) is dropped
  const [loading, setLoading] = useState<string | null>(null);
  const latest = useRef<string | null>(null);
  latest.current = param;
  const [saveError, setSaveError] = useState<string | null>(null);
  const armed = useArmed();
  useEffect(() => {
    setSaveError(null);
    if (param && !configParamUrl(param)) setOffer({ param, ...readInlineConfig(param) });
  }, [param]);
  if (!param) return null;
  const load = (p: string, u: URL) => {
    setLoading(p);
    void fetchConfig(u).then((o) => {
      if (latest.current !== p) return;
      setOffer({ param: p, ...o });
      setLoading(null);
    });
  };
  const clear = () => {
    const sp = new URLSearchParams(loc.search);
    sp.delete('config');
    nav({ pathname: loc.pathname, search: sp.toString() }, { replace: true });
    setOffer(null);
  };
  const current = offer?.param === param ? offer : null;
  if (!current) {
    if (!url) return null; // inline settings: shown once read (no network)
    return (
      <div className="banner banner-config" role="alertdialog" aria-labelledby="cfg-title" data-testid="config-offer">
        <p id="cfg-title">
          <b>This link points to endpoint settings in a file at {url.host}.</b> govhub has not contacted that host. Loading the file shows the settings
          before anything changes; the request tells {url.host} that you opened this link.
        </p>
        <div className="banner-actions">
          <button type="button" className="btn" disabled={loading === param} onClick={() => load(param, url)}>
            {loading === param ? `Loading from ${url.host}…` : `Load settings from ${url.host}`}
          </button>
          <button type="button" className="btn btn-quiet" onClick={clear}>
            Ignore this link
          </button>
        </div>
      </div>
    );
  }
  const ok = current.errors.length === 0;
  const damaged = current.errors[0] === DAMAGED_CONFIG;
  const diff = ok ? registryDiff(registry, current.registry) : [];
  const changed = new Set(diff.map((d) => d.label));
  return (
    <div className="banner banner-config" role="alertdialog" aria-labelledby="cfg-title" data-testid="config-offer">
      <p id="cfg-title">
        {damaged ? (
          <b>{DAMAGED_CONFIG}</b>
        ) : (
          <>
            <b>This link carries endpoint settings.</b>{' '}
          </>
        )}
        {damaged
          ? null
          : !ok
            ? `They can't be used: ${current.errors.join('; ').replace(/\.+$/, '')}.`
            : diff.length
              ? `Using them changes ${diff.length === 1 ? 'one setting' : `${diff.length} settings`}; everything else stays as it is. Check every host: a bridge or DAPI node you do not trust can report false numbers.`
              : 'They are the settings you already use: nothing would change.'}
      </p>
      {diff.length > 0 && (
        <dl className="config-summary" data-testid="config-diff">
          {diff.map((d) => (
            <div key={d.label}>
              <dt>{d.label}</dt>
              <dd className="break">
                <span className="small muted">Now:</span> {d.now}
                <br />
                <span className="small muted">From the link:</span> <b>{d.offered}</b>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {ok && (
        // every other setting too, hosts included: what the user would be running on, not only what moves
        <details className="config-unchanged">
          <summary className="small">{diff.length ? 'Settings that stay the same' : 'The settings'}</summary>
          <dl className="config-summary">
            {registryRows(current.registry)
              .filter(([k]) => !changed.has(k))
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd className="break">{v}</dd>
                </div>
              ))}
          </dl>
        </details>
      )}
      {saveError && <p className="error" role="alert">{saveError}</p>}
      <div className="banner-actions">
        {diff.length > 0 && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!armed}
            onClick={() => {
              try {
                setRegistry(current.registry);
                clear();
              } catch (e) {
                setSaveError(saveErrorText(e));
              }
            }}
          >
            Use these settings
          </button>
        )}
        <button type="button" className="btn" onClick={clear}>
          {diff.length > 0 ? 'Keep my settings' : 'Close'}
        </button>
      </div>
    </div>
  );
}

/** Saved settings that failed validation: the app runs on the defaults, and says so instead of silently showing another profile. */
function SettingsProblem() {
  const { settingsProblem, dismissSettingsProblem, registry } = useApp();
  if (!settingsProblem) return null;
  const shown = settingsProblem.slice(0, 3).join('; ') + (settingsProblem.length > 3 ? `; and ${settingsProblem.length - 3} more` : '');
  return (
    <div className="banner banner-empty" role="alert" data-testid="settings-problem">
      <p>
        <b>Your saved settings could not be used:</b> {shown}. govhub shows the {PROFILES[registry.profile].label} profile's defaults instead; your saved settings
        stay in this browser until you save new ones.
      </p>
      <div className="banner-actions">
        <Link className="btn" to="/settings">
          Open Settings
        </Link>
        <button type="button" className="btn btn-quiet" onClick={dismissSettingsProblem}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function ModeBanner() {
  const { mode, setMode, source, gov, registry, switchProfile } = useApp();
  if (mode === 'fixtures') {
    return (
      <div className="banner banner-fixture" role="status">
        <div className="banner-text">
          <b>Demo data.</b> <span className="banner-more">A recorded mainnet snapshot from Oct 23, 2026, with sample voters.</span> Nothing here is live.
        </div>
        <button type="button" className="btn btn-s" onClick={() => setMode('live')} title="28 real mainnet proposals as Core saw them at block 2,560,391, with recorded DAPI answers, real recorded votes for three proposals and sample voters for the rest, plus two made-up proposals that fail verification">
          Switch to live data
        </button>
      </div>
    );
  }
  if (source.notice) {
    return (
      <div className="banner banner-empty" role="status" data-testid="backend-notice">
        <p>
          <b>{source.notice}.</b> The {PROFILES[registry.profile].label} profile has no governance contract yet, so nothing is read; govhub never shows another network's proposals in its place.
        </p>
        {registry.profile !== 'dev' && (
          <button type="button" className="btn" onClick={() => switchProfile('dev')}>
            Switch to Dev
          </button>
        )}
      </div>
    );
  }
  const empty = !gov.active.loading && !gov.active.error && (gov.active.data?.length ?? 0) === 0;
  if (!empty && !gov.active.error) return null;
  return (
    <div className="banner banner-empty" role="status">
      <p>
        {gov.active.error ? (
          <>
            <b>Platform could not be read.</b> {gov.active.error}
          </>
        ) : (
          <>
            <b>No active proposals on Platform yet.</b> The bridge publishes mainnet proposals into contract {source.registry.govContractId.slice(0, 8)}… as it catches up.
          </>
        )}
      </p>
      <button type="button" className="btn" onClick={() => setMode('fixtures')}>
        View the fixture snapshot
      </button>
    </div>
  );
}

export function Layout() {
  const loc = useLocation();
  const proposals = loc.pathname === '/' || loc.pathname.startsWith('/past') || loc.pathname.startsWith('/p/');
  const masternodes = loc.pathname.startsWith('/masternodes') || loc.pathname.startsWith('/votes');
  const create = loc.pathname.startsWith('/create');
  const names = loc.pathname.startsWith('/names');
  const namesShown = useContestsShown();
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="wordmark" aria-label="govhub home">
            <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="8" className="wordmark-tile" />
              <rect x="7" y="18" width="4" height="7" rx="1" fill="#fff" />
              <rect x="14" y="12" width="4" height="13" rx="1" fill="#fff" />
              <rect x="21" y="7" width="4" height="18" rx="1" fill="#fff" />
            </svg>
            <span>govhub</span>
          </NavLink>
          <nav aria-label="Main" className="mainnav">
            <Link to="/" className={proposals ? 'active' : undefined} aria-current={proposals ? 'page' : undefined}>
              Proposals
            </Link>
            {namesShown && (
              <Link to="/names" className={names ? 'active' : undefined} aria-current={names ? 'page' : undefined} data-testid="nav-names">
                Usernames
              </Link>
            )}
            <Link to="/masternodes" className={masternodes ? 'active' : undefined} aria-current={masternodes ? 'page' : undefined}>
              <span className="nav-more">My masternodes</span>
              <span className="nav-short">Masternodes</span>
            </Link>
            <Link to="/create" className={create ? 'active' : undefined} aria-current={create ? 'page' : undefined} data-testid="nav-create">
              New<span className="nav-more"> proposal</span>
            </Link>
          </nav>
          <div className="topbar-end">
            <ChainShield />
            <SessionControl />
          </div>
        </div>
      </header>
      <LazyAuthSheet />
      <ConfigOffer />
      <SettingsProblem />
      <ModeBanner />
      <main id="main" className="main">
        <Outlet />
      </main>
      <footer className="footer">
        <div className="footer-inner">
          <p className="small muted">
            Checked in your browser against Dash Platform and the Dash chain. <Link to="/about">About</Link> ·{' '}
            <a href={PRIVACY_DOC_URL} target="_blank" rel="noopener noreferrer">
              Privacy
            </a>{' '}
            · <Link to="/settings">Settings</Link> · Open source (MIT)
          </p>
        </div>
      </footer>
    </div>
  );
}
