import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import '@fontsource-variable/archivo/wdth.css';
import './styles.css';
import { AppProvider, useApp } from './app/context.tsx';
import { ForumProvider } from './app/forum.tsx';
import { AuthProvider } from './auth/context.tsx';
import { BadgePage } from './badge/BadgePage.tsx';
import { BadgeProvider } from './badge/context.tsx';
import { FramedNotice, isFramed } from './app/frame.tsx';
import { Layout } from './app/Layout.tsx';
import { preloadSdk } from './data/platform.ts';
import { AboutPage } from './pages/AboutPage.tsx';
import { ActivePage } from './pages/ActivePage.tsx';
import { PastPage } from './pages/PastPage.tsx';
import { ProposalByHash, ProposalByName } from './pages/ProposalPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { TrustPage } from './pages/TrustPage.tsx';
import { MasternodesPage } from './pages/MasternodesPage.tsx';
import { MyVotesPage } from './pages/MyVotesPage.tsx';
import { KeyringProvider } from './voting/KeyringContext.tsx';
import { lazy, Suspense, useEffect } from 'react';

// The wizard brings key derivation and transaction building (@govhub/auth): loaded when it is opened.
const NewProposalPage = lazy(() => import('./pages/NewProposalPage.tsx').then((m) => ({ default: m.NewProposalPage })));

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

function NotFoundPage() {
  return (
    <section className="page-narrow">
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to active proposals</Link>
      </p>
    </section>
  );
}

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
            <SdkWarmup />
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<ActivePage />} />
                <Route path="past" element={<PastPage />} />
                <Route path="p/h/:hash" element={<ProposalByHash />} />
                <Route path="p/:name" element={<ProposalByName />} />
                <Route path="p/:identity/:name" element={<ProposalByName />} />
                <Route
                  path="create"
                  element={
                    <Suspense fallback={<p className="page-narrow muted">Loading…</p>}>
                      <NewProposalPage />
                    </Suspense>
                  }
                />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="masternodes" element={<MasternodesPage />} />
                <Route path="votes" element={<MyVotesPage />} />
                <Route path="badge" element={<BadgePage />} />
                <Route path="about/verification" element={<AboutPage />} />
                <Route path="about/trust" element={<TrustPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
            </BadgeProvider>
            </KeyringProvider>
          </AuthProvider>
        </ForumProvider>
      </AppProvider>
    </BrowserRouter>
  </StrictMode>
  ),
);
