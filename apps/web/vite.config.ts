/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

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

/**
 * evo-sdk's published bundle (`dist/evo-sdk.module.js`) inlines wasm-sdk's WASM as base64 of gzip: a 12 MB JS string that the
 * CDN cannot compress further, is parsed as JS, base64-decoded and gunzipped before it compiles. Its unbundled entry
 * (`dist/sdk.js`) imports `@dashevo/wasm-sdk/compressed`; pointing that at wasm-sdk's own `raw` entry makes the WASM a separate
 * `.wasm` asset (its `new URL('wasm_sdk_bg.wasm', import.meta.url)`), served as application/wasm, compressed by the CDN and
 * compiled while it streams. Same exports, same `init()`.
 */
export const EVO_SDK_ALIASES = [
  { find: /^@dashevo\/evo-sdk$/, replacement: fileURLToPath(new URL('sdk.js', import.meta.resolve('@dashevo/evo-sdk'))) },
  { find: /^@dashevo\/wasm-sdk\/compressed$/, replacement: '@dashevo/wasm-sdk/raw' },
];

export default defineConfig({
  // GOVHUB_BASE is the URL prefix when served from a sub-path (e.g. GitHub Pages at /govhub/).
  base: process.env.GOVHUB_BASE ?? '/',
  plugins: [react(), cspPlugin()],
  resolve: { alias: EVO_SDK_ALIASES },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // evo-sdk's JS is ~1.6 MB (its ~26 MB WASM is a separate asset); it is lazy-loaded after first paint.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      onwarn(w, warn) {
        // @scure/base has a harmless misplaced /* @__PURE__ */ comment.
        if (w.code === 'INVALID_ANNOTATION' && w.id?.includes('@scure/base')) return;
        warn(w);
      },
    },
  },
  // not pre-bundled: esbuild would drop wasm-sdk's `new URL(..., import.meta.url)` WASM reference
  optimizeDeps: { exclude: ['@dashevo/evo-sdk', '@dashevo/wasm-sdk'] },
  preview: { port: 4317, strictPort: true },
  server: { port: 5317 },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
