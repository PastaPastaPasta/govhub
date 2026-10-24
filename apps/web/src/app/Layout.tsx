import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { resolveConfigParam, type Registry } from '../config/registry.ts';
import { formatInt } from '../lib/format.ts';
import { ProvLegend } from '../ui/Provenance.tsx';
import { SessionControl } from '../ui/SignIn.tsx';
import { useApp, type Theme } from './context.tsx';

const THEMES: Array<{ id: Theme; label: string }> = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

function ThemeSwitch() {
  const { theme, setTheme } = useApp();
  return (
    <fieldset className="theme-switch">
      <legend className="visually-hidden">Theme</legend>
      {THEMES.map((t) => (
        <label key={t.id} className={theme === t.id ? 'on' : ''}>
          <input type="radio" name="theme" value={t.id} checked={theme === t.id} onChange={() => setTheme(t.id)} />
          {t.label}
        </label>
      ))}
    </fieldset>
  );
}

/** `?config=` in the URL: show what it would change and let the user apply or dismiss it. */
function ConfigOffer() {
  const { setRegistry } = useApp();
  const loc = useLocation();
  const nav = useNavigate();
  const [offer, setOffer] = useState<{ registry: Registry; errors: string[] } | null>(null);
  const param = new URLSearchParams(loc.search).get('config');
  useEffect(() => {
    if (param) resolveConfigParam(param).then(setOffer);
  }, [param]);
  if (!param || !offer) return null;
  const clear = () => {
    const sp = new URLSearchParams(loc.search);
    sp.delete('config');
    nav({ pathname: loc.pathname, search: sp.toString() }, { replace: true });
    setOffer(null);
  };
  return (
    <div className="banner banner-config" role="alertdialog" aria-labelledby="cfg-title">
      <p id="cfg-title">
        <b>This link carries endpoint settings.</b>{' '}
        {offer.errors.length ? `They can't be used: ${offer.errors.join('; ')}.` : 'Check every host before using them: a bridge or DAPI node you do not trust can report false numbers.'}
      </p>
      {!offer.errors.length && <ConfigSummary r={offer.registry} />}
      <div className="banner-actions">
        {!offer.errors.length && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setRegistry(offer.registry);
              clear();
            }}
          >
            Use these settings
          </button>
        )}
        <button type="button" className="btn" onClick={clear}>
          Keep my settings
        </button>
      </div>
    </div>
  );
}

function ConfigSummary({ r }: { r: Registry }) {
  const rows: Array<[string, string]> = [
    ['Networks', `Core ${r.coreNetwork}, Platform ${r.platformNetwork}`],
    ['Governance contract', r.govContractId],
    ['DAPI nodes', r.dapi.source === 'manual' ? r.dapi.nodes.join(', ') : `from ${r.dapi.quorumUrl}`],
    ['Platform', `${r.platform.trusted ? 'trusted quorum keys' : 'untrusted mode'}${r.platform.addresses.length ? `, nodes ${r.platform.addresses.join(', ')}` : ', SDK default nodes'}`],
    ['Bridges', r.bridges.map((b) => `${b.name} (${b.httpBase}${b.enabled ? '' : ', off'})`).join(', ') || 'none'],
    ['Relays', r.relays.map((x) => x.url).join(', ') || 'none'],
    ['Price feed', r.priceFeed?.url ?? 'none'],
    ['Forum contracts', `forum ${r.forum.contractId}, mod ${r.forum.modContractId}`],
    ['Default block list', `${r.forum.moderationName} (${r.forum.moderationIdentityId})`],
    ['Claim portals', r.forum.claimPortals.join(', ') || 'none'],
  ];
  return (
    <dl className="config-summary">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className="break">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ModeBanner() {
  const { mode, setMode, source, gov } = useApp();
  if (mode === 'fixtures') {
    return (
      <div className="banner banner-fixture" role="status">
        <p>
          <b>Fixture snapshot.</b> 28 real mainnet proposals as Core saw them at block 2,560,391 on Oct 23, 2026, with recorded DAPI answers, real recorded votes for three proposals and synthetic voters for the rest. Nothing here is live.
        </p>
        <button type="button" className="btn" onClick={() => setMode('live')}>
          Switch to live data
        </button>
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
  const { registry, mode, gov } = useApp();
  const count = gov.active.data?.length;
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="wordmark" aria-label="govhub home">
            <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="6" className="wordmark-tile" />
              <rect x="7" y="18" width="4" height="7" fill="#fff" />
              <rect x="14" y="12" width="4" height="13" fill="#fff" />
              <rect x="21" y="7" width="4" height="18" fill="#fff" />
            </svg>
            govhub
          </NavLink>
          <nav aria-label="Main">
            <NavLink to="/" end>
              Active{count !== undefined && <span className="count">{formatInt(count)}</span>}
            </NavLink>
            <NavLink to="/past">Past</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <p className="netinfo" title="Core data and Platform documents can come from different networks during phase 1">
            Core {registry.coreNetwork}, Platform {registry.platformNetwork}
            {mode === 'fixtures' && <span className="chip chip-fixture">fixtures</span>}
          </p>
          <ThemeSwitch />
          <SessionControl />
        </div>
      </header>
      <ConfigOffer />
      <ModeBanner />
      <main id="main" className="main">
        <Outlet />
      </main>
      <footer className="footer">
        <div className="footer-inner">
          <section aria-labelledby="legend-title">
            <h2 id="legend-title">Where the numbers come from</h2>
            <ProvLegend />
          </section>
          <p className="muted small">
            govhub reads Dash Platform directly and checks what it can against the Core chain in your browser. Every backend is replaceable in Settings. Open source, MIT.
          </p>
        </div>
      </footer>
    </div>
  );
}
