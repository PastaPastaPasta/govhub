import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Link } from '../ui/Link.tsx';
import { configParamUrl, DAMAGED_CONFIG, fetchConfig, PROFILES, readInlineConfig, registryDiff, registryRows, saveErrorText, type Registry } from '../config/registry.ts';
import { profileSearch } from '../config/network.ts';
import { useAuth } from '../auth/context.tsx';
import { SessionControl } from '../ui/SignIn.tsx';
import { useApp } from './context.tsx';
import { PRIVACY_DOC_URL } from '../pages/AboutPage.tsx';
import { WALLET_SESSION_ENDED_TEXT } from '../session/keyDisabled.ts';

// The sign-in sheet (BIP39 wordlist, BIP32, HPKE, tx building) loads when it is first opened.
const AuthSheet = lazy(() => import('../auth/AuthSheet.tsx').then((m) => ({ default: m.AuthSheet })));

function LazyAuthSheet() {
  const { sheet, openSheet } = useAuth();
  const loc = useLocation();
  const navigate = useNavigate();
  const signIn = new URLSearchParams(loc.search).get('signin') === '1';
  useEffect(() => {
    if (!signIn) return;
    openSheet('choose');
    const search = new URLSearchParams(loc.search);
    search.delete('signin');
    navigate({ pathname: loc.pathname, search: search.toString(), hash: loc.hash }, { replace: true });
  }, [signIn, loc.pathname, loc.search, loc.hash, navigate, openSheet]);
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
  const clear = (profile: Registry['profile'] = registry.profile) => {
    const sp = new URLSearchParams(loc.search);
    sp.delete('config');
    nav({ pathname: loc.pathname, search: profileSearch(sp.toString(), profile) }, { replace: true });
    setOffer(null);
  };
  const current = offer?.param === param ? offer : null;
  if (!current) {
    if (!url) return null; // inline settings: shown once read (no network)
    return (
      <div className="banner dh-notice banner-config dh-notice--info" role="alertdialog" aria-labelledby="cfg-title" data-testid="config-offer">
        <p id="cfg-title">
          <b>This link points to endpoint settings in a file at {url.host}.</b> Governance has not contacted that host. Loading the file shows the settings
          before anything changes; the request tells {url.host} that you opened this link.
        </p>
        <div className="banner-actions">
          <button type="button" className="btn dh-btn" disabled={loading === param} onClick={() => load(param, url)}>
            {loading === param ? `Loading from ${url.host}…` : `Load settings from ${url.host}`}
          </button>
          <button type="button" className="btn dh-btn btn-quiet dh-btn--quiet" onClick={() => clear()}>
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
    <div className="banner dh-notice banner-config dh-notice--info" role="alertdialog" aria-labelledby="cfg-title" data-testid="config-offer">
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
              ? `Using them changes ${diff.length === 1 ? 'one setting' : `${diff.length} settings`}; everything else stays as it is. Check every host: a data service or DAPI node you do not trust can report false numbers.`
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
        <details className="config-unchanged dh-disclosure">
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
            className="btn dh-btn"
            disabled={!armed}
            onClick={() => {
              try {
                setRegistry(current.registry);
                clear(current.registry.profile);
              } catch (e) {
                setSaveError(saveErrorText(e));
              }
            }}
          >
            Use these settings
          </button>
        )}
        <button type="button" className="btn dh-btn" onClick={() => clear()}>
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
    <div className="banner dh-notice banner-empty dh-notice--warn" role="alert" data-testid="settings-problem">
      <p>
        <b>Your saved settings could not be used:</b> {shown}. Governance shows the {PROFILES[registry.profile].label} profile's defaults instead; your saved settings
        stay in this browser until you save new ones.
      </p>
      <div className="banner-actions">
        <Link className="btn dh-btn" to="/settings">
          Open settings
        </Link>
        <button type="button" className="btn dh-btn btn-quiet dh-btn--quiet" onClick={dismissSettingsProblem}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** A wallet (App Connect) session ended because the wallet revoked its key: the one place that says so, with a way back in. */
export function WalletSessionEnded() {
  const { walletEnded, reconnectWallet, dismissWalletEnded } = useAuth();
  if (!walletEnded) return null;
  return (
    <div className="banner dh-notice banner-empty dh-notice--warn" role="alert" data-testid="wallet-session-ended">
      <p>
        <b>{WALLET_SESSION_ENDED_TEXT}</b>
      </p>
      <div className="banner-actions">
        <button type="button" className="btn dh-btn btn-primary dh-btn--primary" onClick={reconnectWallet} data-testid="wallet-reconnect">
          Reconnect
        </button>
        <button type="button" className="btn dh-btn btn-quiet dh-btn--quiet" onClick={dismissWalletEnded}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function ModeBanner() {
  const { mode, setMode, source, gov, registry, switchProfile, reload } = useApp();
  if (mode === 'fixtures') {
    return (
      <div className="banner dh-notice banner-fixture dh-notice--info" role="status">
        <div className="banner-text">
          <b>Demo data.</b> <span className="banner-more">A recorded mainnet snapshot from Oct 23, 2026, with sample voters.</span> Nothing here is live.
        </div>
        <button type="button" className="btn dh-btn btn-s dh-btn--sm" onClick={() => setMode('live')} title="28 real mainnet proposals as Core saw them at block 2,560,391, with recorded DAPI answers, real recorded votes for three proposals and sample voters for the rest, plus two made-up proposals that fail verification">
          Switch to live data
        </button>
      </div>
    );
  }
  if (source.notice) {
    return (
      <div className="banner dh-notice banner-empty dh-notice--warn" role="status" data-testid="backend-notice">
        <p>
          <b>{source.notice}.</b> The {PROFILES[registry.profile].label} profile has no governance contract yet, so nothing is read; Governance never shows another network's proposals in its place.
        </p>
        {registry.profile !== 'dev' && (
          <button type="button" className="btn dh-btn" onClick={() => switchProfile('dev')}>
            Use mainnet proposals on Testnet Platform
          </button>
        )}
      </div>
    );
  }
  const empty = !gov.active.loading && !gov.active.error && (gov.active.data?.length ?? 0) === 0;
  if (!empty && !gov.active.error) return null;
  return (
    <div className="banner dh-notice banner-empty dh-notice--warn" role="status">
      <p>
        {gov.active.error ? (
          <>
            <b>Proposals could not be loaded right now.</b> <span className="muted small">{gov.active.error}</span>
          </>
        ) : (
          <>
            <b>No active proposals yet.</b> New proposals appear here a few minutes after they go live.
          </>
        )}
      </p>
      <div className="form-actions">
        {gov.active.error && (
          <button type="button" className="btn dh-btn" onClick={reload} data-testid="active-retry">
            Try again
          </button>
        )}
        <button type="button" className="btn dh-btn btn-quiet dh-btn--quiet" onClick={() => setMode('fixtures')}>
          View demo data instead
        </button>
      </div>
    </div>
  );
}

export function Layout() {
  const loc = useLocation();
  const { registry } = useApp();
  const navigate = useNavigate();
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const change = (event: Event) => {
      const e = event as CustomEvent<{ href: string }>;
      e.preventDefault();
      const url = new URL(e.detail.href);
      url.searchParams.delete('profile');
      navigate(`${url.pathname}${url.search}${url.hash}`);
    };
    bar.current?.addEventListener('dashhq-network', change);
    return () => bar.current?.removeEventListener('dashhq-network', change);
  }, [navigate]);
  const requestedNetwork = new URLSearchParams(loc.search).get('network');
  const unsupportedNetwork = requestedNetwork && !['mainnet', 'testnet', 'main', 'test'].includes(requestedNetwork);
  const coreLabel = registry.coreNetwork === 'mainnet' ? 'Mainnet' : 'Testnet';
  const platformLabel = registry.platformNetwork === 'mainnet' ? 'Mainnet' : 'Testnet';
  // the router commits a navigation in a transition, after the next page renders: the clicked section is current at once
  const [clicked, setClicked] = useState<string | null>(null);
  useEffect(() => setClicked(null), [loc.key, loc.pathname]);
  useEffect(() => {
    const reset = () => setClicked(null);
    window.addEventListener('popstate', reset);
    return () => window.removeEventListener('popstate', reset);
  }, []);
  const at = clicked ?? loc.pathname;
  const clickTo = (path: string) => (e: MouseEvent) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) setClicked(path); };
  const proposals = at === '/' || at.startsWith('/past') || at.startsWith('/treasury') || at.startsWith('/p/');
  // a masternode's own votes page (/masternodes/<proTx>) is public, usually someone else's: not "My masternodes"
  const masternodes = at === '/masternodes' || at.startsWith('/votes');
  const polls = at.startsWith('/polls');
  const node = /^\/masternodes\/([0-9a-f]{64})$/i.exec(loc.pathname)?.[1] ?? new URLSearchParams(loc.search).get('mn');
  const proposalsHref = node && /^[0-9a-f]{64}$/i.test(node) ? `/?mn=${node.toLowerCase()}` : '/';
  const names = at.startsWith('/names');
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <dashhq-bar ref={bar} product="gov" phone-nav="tabs" network={registry.platformNetwork} networks="mainnet testnet" product-href={'/' + profileSearch('', registry.profile)} network-settings={'/settings' + profileSearch('', registry.profile) + '#network'} sticky="">
        <img slot="logo" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width="22" height="22" />
        <nav slot="nav" aria-label="Governance">
          <Link to={proposalsHref} onClick={clickTo('/')} aria-current={proposals ? 'page' : undefined}><svg className="dh-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M6 3h9l3 3v15H6z" /><path d="M9 9h6M9 13h6M9 17h4" /></svg>Proposals</Link>
          <Link to="/polls" onClick={clickTo('/polls')} aria-current={polls ? 'page' : undefined}><svg className="dh-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 20V4M4 20h17M9 17v-6M14 17V6M19 17v-9" /></svg>Polls</Link>
          <Link to="/names" onClick={clickTo('/names')} aria-current={names ? 'page' : undefined} data-testid="nav-names"><svg className="dh-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20 12v-2a8 8 0 1 0-3 8M16 10v4a2 2 0 0 0 4 0v-2" /><circle cx="12" cy="10" r="4" /></svg>Name contests</Link>
          <Link to="/masternodes" onClick={clickTo('/masternodes')} aria-current={masternodes ? 'page' : undefined}><svg className="dh-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="4" y="3" width="16" height="7" rx="1" /><rect x="4" y="14" width="16" height="7" rx="1" /><path d="M7 6.5h2M7 17.5h2M12 10v4" /></svg>My masternodes</Link>
        </nav>
        <div slot="actions"><SessionControl /></div>
      </dashhq-bar>
      <div className="dh-container">
      {unsupportedNetwork && <aside className="network-context dh-notice dh-notice--info" role="alert">This Governance build supports Mainnet and Testnet. The requested network <bdi>{requestedNetwork}</bdi> is unavailable; showing Mainnet.</aside>}
      {registry.coreNetwork !== registry.platformNetwork && <aside className="network-context dh-notice dh-notice--info" role="status">
        <b>{coreLabel} proposals · {platformLabel} Platform.</b> This {registry.profile === 'dev' ? 'development' : 'custom'} profile reads {coreLabel} governance through {platformLabel} Platform. Name contests use {platformLabel}.
        <Link to="/settings#network">Network settings</Link>
      </aside>}
      <LazyAuthSheet />
      <WalletSessionEnded />
      <ConfigOffer />
      <SettingsProblem />
      {!polls && <ModeBanner />}
      </div>
      <main id="main" className="main dh-container dh-page">
        <Outlet />
      </main>
      <dashhq-footer product="gov" source="https://github.com/PastaPastaPasta/govhub">
        <Link to="/about">About</Link><a href={PRIVACY_DOC_URL}>Privacy ↗</a><Link to="/settings">Settings</Link>
      </dashhq-footer>
    </div>
  );
}
