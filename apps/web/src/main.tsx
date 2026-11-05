import { StrictMode } from 'react';
import { useTitle } from './app/title.ts';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Link } from './ui/Link.tsx';
import './styles.css';
import { AppProvider, useApp } from './app/context.tsx';
import { ForumProvider } from './app/forum.tsx';
import { AuthProvider } from './auth/context.tsx';
import { BadgePage } from './badge/BadgePage.tsx';
import { BadgeProvider } from './badge/context.tsx';
import { FramedNotice, isFramed } from './app/frame.tsx';
import { Layout } from './app/Layout.tsx';
import { preloadSdk } from './data/platform.ts';
import { preloadOwnerPages } from './lib/ownerPages.ts';
import { AboutPage } from './pages/AboutPage.tsx';
import { VerificationPage } from './pages/VerificationPage.tsx';
import { ActivePage } from './pages/ActivePage.tsx';
import { ContestVotesProvider } from './contests/ContestVotes.tsx';
import { GuestKeysProvider } from './contests/GuestKeys.tsx';
import { PastPage } from './pages/PastPage.tsx';
import { TreasuryPage } from './pages/TreasuryPage.tsx';
import { ProposalByHash, ProposalByName } from './pages/ProposalPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { TrustPage } from './pages/TrustPage.tsx';
import { MasternodesPage } from './pages/MasternodesPage.tsx';
import { MasternodePage } from './pages/MasternodePage.tsx';
import { MyVotesPage } from './pages/MyVotesPage.tsx';
import { KeyringProvider } from './voting/KeyringContext.tsx';
import { lazy, Suspense, useEffect } from 'react';

// The wizard brings key derivation and transaction building (@govhub/auth): loaded when it is opened.
const NewProposalPage = lazy(() => import('./pages/NewProposalPage.tsx').then((m) => ({ default: m.NewProposalPage })));
// Username contests: loaded when /names is opened.
const ContestsPage = lazy(() => import('./pages/ContestsPage.tsx').then((m) => ({ default: m.ContestsPage })));
const ContestPage = lazy(() => import('./pages/ContestPage.tsx').then((m) => ({ default: m.ContestPage })));

/** Starts downloading evo-sdk (big WASM chunk) once the first paint is done, in live mode only. */
function SdkWarmup() {
  const { mode, registry } = useApp();
  useEffect(() => {
    if (mode !== 'live') return;
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 200));
    idle(() => preloadSdk(registry));
  }, [mode, registry]);
  return null;
}

/** While a page's code loads: what is opening, not a bare "Loading…". */
function Opening({ what }: { what: string }) {
  return (
    <p className="page-narrow muted" aria-busy="true">
      <span className="spinner" aria-hidden="true" /> Opening {what}…
    </p>
  );
}

function NotFoundPage() {
  useTitle('Page not found');
  return (
    <section className="page-narrow">
      <h1 className="dh-page-header__title">Page not found</h1>
      <p>
        <Link to="/">Back to active proposals</Link>
      </p>
    </section>
  );
}

if (!isFramed()) preloadOwnerPages();

createRoot(document.getElementById('root')!).render(
  // inside another page's frame: no app at all (no data, no storage, nothing to click), only a way out
  isFramed() ? (
    <FramedNotice />
  ) : (
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <AppProvider>
        <ForumProvider>
          <AuthProvider>
            <KeyringProvider>
            <BadgeProvider>
            <ContestVotesProvider>
            <GuestKeysProvider>
            <SdkWarmup />
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<ActivePage />} />
                <Route path="past" element={<PastPage />} />
                <Route path="treasury" element={<TreasuryPage />} />
                <Route path="p/h/:hash" element={<ProposalByHash />} />
                <Route path="p/:name" element={<ProposalByName />} />
                <Route path="p/:identity/:name" element={<ProposalByName />} />
                <Route
                  path="create"
                  element={
                    <Suspense fallback={<Opening what="the proposal form" />}>
                      <NewProposalPage />
                    </Suspense>
                  }
                />
                <Route path="names">
                  <Route index element={<Suspense fallback={<Opening what="name contests" />}><ContestsPage /></Suspense>} />
                  <Route path=":label" element={<Suspense fallback={<Opening what="the name contest" />}><ContestPage /></Suspense>} />
                </Route>
                <Route path="settings" element={<SettingsPage />} />
                <Route path="masternodes" element={<MasternodesPage />} />
                <Route path="masternodes/:proTx" element={<MasternodePage />} />
                <Route path="votes" element={<MyVotesPage />} />
                <Route path="badge" element={<BadgePage />} />
                <Route path="about" element={<AboutPage />} />
                <Route path="about/verification" element={<VerificationPage />} />
                <Route path="about/trust" element={<TrustPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
            </GuestKeysProvider>
            </ContestVotesProvider>
            </BadgeProvider>
            </KeyringProvider>
          </AuthProvider>
        </ForumProvider>
      </AppProvider>
    </BrowserRouter>
  </StrictMode>
  ),
);
