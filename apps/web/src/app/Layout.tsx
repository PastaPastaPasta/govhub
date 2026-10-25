import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { configParamUrl, PROFILES, registryDiff, registryRows, resolveConfigParam, saveErrorText, type Registry } from '../config/registry.ts';
import { useAuth } from '../auth/context.tsx';
import { SessionControl } from '../ui/SignIn.tsx';
import { ChainShield } from '../ui/trust/ChainShield.tsx';
import { useApp } from './context.tsx';

// The sign-in sheet (BIP39 wordlist, BIP32, HPKE, tx building) loads when it is first opened.
const AuthSheet = lazy(() => import('../auth/AuthSheet.tsx').then((m) => ({ default: m.AuthSheet })));

function LazyAuthSheet() {
  const { sheet } = useAuth();
  // Once loaded it stays mounted: unmounting the open <dialog> skipped close(), and focus fell to <body> instead of going back.
  const [loaded, setLoaded] = useState(false);
  if (sheet && !loaded) setLoaded(true);
  return sheet || loaded ? (
    <Suspense fallback={null}>
      <AuthSheet />
    </Suspense>
  ) : null;
}

/**
 * Whether govhub is shown inside another page's frame. GitHub Pages cannot send frame-ancestors / X-Frame-Options, so a page
 * could frame a `?config=` link and trick a click on "Use these settings"; such a link is then only offered in its own tab.
 */
export function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true; // a cross-origin parent can make even the comparison throw
  }
}

/**
 * `?config=` in the URL: show what it would change and let the user apply or dismiss it. Inline (base64url) settings are read at
 * once; a URL is fetched only after the user agrees, since the request alone tells that host who opened the link.
 */
function ConfigOffer() {
  const { registry, setRegistry } = useApp();
  const loc = useLocation();
  const nav = useNavigate();
  const param = new URLSearchParams(loc.search).get('config');
  const url = param ? configParamUrl(param) : null;
  const [framed] = useState(isFramed);
  const [offer, setOffer] = useState<{ param: string; registry: Registry; errors: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const load = (p: string) => {
    setLoading(true);
    resolveConfigParam(p)
      .then((o) => setOffer({ param: p, ...o }))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    setSaveError(null);
    if (param && !framed && !configParamUrl(param)) load(param);
  }, [param, framed]);
  if (!param) return null;
  const clear = () => {
    const sp = new URLSearchParams(loc.search);
    sp.delete('config');
    nav({ pathname: loc.pathname, search: sp.toString() }, { replace: true });
    setOffer(null);
  };
  if (framed) {
    return (
      <div className="banner banner-config" role="alert" data-testid="config-framed">
        <p>
          <b>This link carries endpoint settings, but govhub is shown inside another page here.</b> Settings are never changed from inside a frame.{' '}
          <a href={location.href} target="_blank" rel="noopener noreferrer">
            Open govhub in its own tab
          </a>{' '}
          to review them.
        </p>
      </div>
    );
  }
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
          <button type="button" className="btn" disabled={loading} onClick={() => load(param)}>
            {loading ? `Loading from ${url.host}…` : `Load settings from ${url.host}`}
          </button>
          <button type="button" className="btn btn-quiet" onClick={clear}>
            Ignore this link
          </button>
        </div>
      </div>
    );
  }
  const diff = current.errors.length ? [] : registryDiff(registry, current.registry);
  return (
    <div className="banner banner-config" role="alertdialog" aria-labelledby="cfg-title" data-testid="config-offer">
      <p id="cfg-title">
        <b>This link carries endpoint settings.</b>{' '}
        {current.errors.length
          ? `They can't be used: ${current.errors.join('; ')}.`
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
      {!current.errors.length && (
        // every other setting too, hosts included: what the user would be running on, not only what moves
        <details className="config-unchanged">
          <summary className="small">{diff.length ? 'Settings that stay the same' : 'The settings'}</summary>
          <dl className="config-summary">
            {registryRows(current.registry)
              .filter(([k]) => !diff.some((d) => d.label === k))
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
            <Link to="/masternodes" className={masternodes ? 'active' : undefined} aria-current={masternodes ? 'page' : undefined}>
              My masternodes
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
            govhub reads Dash Platform directly and checks proposals against the Dash chain in your browser. <Link to="/about/verification">How verification works</Link>. Every backend
            can be replaced in <Link to="/settings">Settings</Link>. Open source, MIT.
          </p>
        </div>
      </footer>
    </div>
  );
}
