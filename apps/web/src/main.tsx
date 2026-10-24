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
import { Layout } from './app/Layout.tsx';
import { preloadSdk } from './data/platform.ts';
import { ActivePage } from './pages/ActivePage.tsx';
import { PastPage } from './pages/PastPage.tsx';
import { ProposalByHash, ProposalByName } from './pages/ProposalPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { MasternodesPage } from './pages/MasternodesPage.tsx';
import { MyVotesPage } from './pages/MyVotesPage.tsx';
import { KeyringProvider } from './voting/KeyringContext.tsx';
import { useEffect } from 'react';

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
    <section className="list-section">
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to active proposals</Link>
      </p>
    </section>
  );
}

createRoot(document.getElementById('root')!).render(
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
                <Route path="settings" element={<SettingsPage />} />
                <Route path="masternodes" element={<MasternodesPage />} />
                <Route path="votes" element={<MyVotesPage />} />
                <Route path="badge" element={<BadgePage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
            </BadgeProvider>
            </KeyringProvider>
          </AuthProvider>
        </ForumProvider>
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
);
