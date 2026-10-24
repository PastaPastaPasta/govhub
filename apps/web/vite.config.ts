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
  "worker-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https:",
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
  plugins: [react(), cspPlugin()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // evo-sdk is one ~12 MB ESM chunk with the WASM inlined; it is lazy-loaded after first paint.
    chunkSizeWarningLimit: 14000,
  },
  optimizeDeps: { exclude: ['@dashevo/evo-sdk'] },
  preview: { port: 4317, strictPort: true },
  server: { port: 5317 },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
