import { defineConfig } from 'vitest/config';

export default defineConfig({
  // live-core.test.ts shells out to dash-cli hundreds of times when DASH_CLI is set.
  test: { testTimeout: 120_000, include: ['test/**/*.test.ts'] },
});
