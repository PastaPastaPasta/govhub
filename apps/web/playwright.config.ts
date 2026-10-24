// Headless Chromium only. Playwright builds the app, starts `vite preview` (the CSP is only in
// the built index.html) and stops it when the run ends; nothing is left running.
import { defineConfig, devices } from '@playwright/test';

// GOVHUB_E2E_PORT lets parallel checkouts (agent worktrees) run their suites side by side.
const PORT = Number(process.env.GOVHUB_E2E_PORT ?? 4317);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    // Live runs type real phrases and keys: no traces there (a failed run would keep them in test-results/).
    trace: process.env.GOVHUB_LIVE || process.env.GOVHUB_LIVE_AUTH ? 'off' : 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], headless: true } }],
  webServer: {
    command: `npx vite build --logLevel warn && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
