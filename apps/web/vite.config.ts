/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Strict CSP, injected into the built index.html only (the dev server needs inline scripts for
 * React refresh). DAPI evonodes, bridges and quorum services are user-configurable hosts, so
 * `connect-src` allows any https origin; everything else is same-origin. `wasm-unsafe-eval` is
 * what evo-sdk's WASM needs; no `unsafe-eval`, no inline scripts or styles.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  // blob: is evo-sdk's off-main-thread WASM decompress+compile worker (it falls back to the main
  // thread, janking for seconds). Only scripts already allowed by script-src can create one.
  "worker-src 'self' blob:",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  // https: because DAPI nodes, bridges and feeds are user-configurable; localhost for a local bridge.
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'govhub-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

export default defineConfig({
  // GOVHUB_BASE is the URL prefix when served from a sub-path (e.g. GitHub Pages at /govhub/).
  base: process.env.GOVHUB_BASE ?? '/',
  plugins: [react(), cspPlugin()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // evo-sdk is one ~12 MB ESM chunk with the WASM inlined; it is lazy-loaded after first paint.
    chunkSizeWarningLimit: 14000,
    rollupOptions: {
      onwarn(w, warn) {
        // @scure/base has a harmless misplaced /* @__PURE__ */ comment.
        if (w.code === 'INVALID_ANNOTATION' && w.id?.includes('@scure/base')) return;
        warn(w);
      },
    },
  },
  optimizeDeps: { exclude: ['@dashevo/evo-sdk'] },
  preview: { port: 4317, strictPort: true },
  server: { port: 5317 },
  test: {
    // component tests (*.test.tsx) pick a DOM per file: `// @vitest-environment happy-dom`
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
});
