import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { customFields, PROFILES, resolveConfigParam, type Registry } from '../config/registry.ts';
import { useAuth } from '../auth/context.tsx';
import { SessionControl } from '../ui/SignIn.tsx';
import { ChainShield } from '../ui/trust/ChainShield.tsx';
import { useApp } from './context.tsx';

// The sign-in sheet (BIP39 wordlist, BIP32, HPKE, tx building) loads when it is first opened.
const AuthSheet = lazy(() => import('../auth/AuthSheet.tsx').then((m) => ({ default: m.AuthSheet })));

function LazyAuthSheet() {
  const { sheet } = useAuth();
  return sheet ? (
    <Suspense fallback={null}>
      <AuthSheet />
    </Suspense>
  ) : null;
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
    ['Profile', `${PROFILES[r.profile].title}${customFields(r).size ? ' (with custom overrides)' : ''}`],
    ['Networks', `Core ${r.coreNetwork}, Platform ${r.platformNetwork}`],
    ['Governance contract', r.govContractId],
    ['DAPI nodes', r.dapi.source === 'manual' ? r.dapi.nodes.join(', ') : `from ${r.dapi.quorumUrl}`],
    ['Platform', `${r.platform.trusted ? 'trusted quorum keys' : 'untrusted mode'}${r.platform.addresses.length ? `, nodes ${r.platform.addresses.join(', ')}` : ', SDK default nodes'}`],
    ['Bridges', r.bridges.map((b) => `${b.name} (${b.httpBase}${b.enabled ? '' : ', off'})`).join(', ') || 'none'],
    ['Relays', r.relays.map((x) => x.url).join(', ') || 'none'],
    ['Price feed', r.priceFeed?.url ?? 'none'],
    ['Accounts service', r.accounts?.url ?? 'none'],
    ['Faucet', r.faucet?.url ?? 'none'],
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
