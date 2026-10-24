import { defineConfig } from 'vitest/config';

// Offline unit tests only. The live Playwright test is `npm run test:live` (test/live/run.mjs).
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 } });
