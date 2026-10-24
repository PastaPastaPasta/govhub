// Bundle-size comparison (esbuild --minify, browser). node scripts/size.mjs [path-to-extracted-evo-sdk-5.0.0-rc.8/package]
import { build } from 'esbuild';
import { nodeModulesPolyfillPlugin } from 'esbuild-plugins-node-modules-polyfill';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kb = (n) => +(n / 1024).toFixed(1);
const rows = [];
const measure = (label, bytes, note = '') => {
  rows.push({ label, rawKB: kb(bytes.length), gzipKB: kb(gzipSync(bytes, { level: 9 }).length), brotliKB: kb(brotliCompressSync(bytes).length), note });
};

async function bundle(label, contents, note, extra = {}) {
  try {
    const r = await build({
      stdin: { contents, resolveDir: root, loader: 'js' }, bundle: true, minify: true, format: 'esm', platform: 'browser',
      target: 'es2022', write: false, logLevel: 'silent', treeShaking: true, ...extra,
    });
    measure(label, r.outputFiles[0].contents, note);
  } catch (e) { rows.push({ label, error: String(e.errors?.[0]?.text || e.message).slice(0, 160), note }); }
}

await bundle('govhub client: everything except BLS (src/index.js)', `export * from './src/index.js'`, 'hand-rolled grpc-web + pb + parsers + SML + bloom + race');
await bundle('  ...of which: grpc-web+pb+DapiCore only', `export { DapiCore } from './src/core.js'`, 'grpc-web framing + minimal protobuf + the 10 Core RPCs');
await bundle('ChainLock BLS verify module alone (src/chainlock.js)', `export * from './src/chainlock.js'`, 'noble bls12-381 (pairing + hash-to-curve) + sha256');
await bundle('govhub client + BLS', `export * from './src/index.js'; export * from './src/chainlock.js'`, 'full set');

// Baselines: what the "official" JS stack costs in a browser bundle
await bundle('@dashevo/dapi-grpc/browser.js (grpc-web generated, Core+Platform)', `export * from '@dashevo/dapi-grpc/browser.js'`, 'protobufjs + google-protobuf + improbable grpc-web', { define: { global: 'globalThis' }, plugins: [nodeModulesPolyfillPlugin({ globals: { Buffer: true, process: true } })] });
await bundle('@dashevo/dashcore-lib (browser)', `import d from '@dashevo/dashcore-lib'; export default d;`, 'tx/block parsing + BloomFilter; excludes @dashevo/bls wasm', { define: { global: 'globalThis' }, plugins: [nodeModulesPolyfillPlugin({ globals: { Buffer: true, process: true } })] });
await bundle('@dashevo/dapi-client (browser)', `import C from '@dashevo/dapi-client'; export default C;`, 'needs wasm-dpp, dash-spv, node polyfills', { define: { global: 'globalThis' }, mainFields: ['browser', 'module', 'main'], plugins: [nodeModulesPolyfillPlugin({ globals: { Buffer: true, process: true } })], loader: { '.wasm': 'binary' } });

const bls = join(root, 'node_modules/@dashevo/bls');
if (existsSync(bls)) {
  measure('@dashevo/bls blsjs.js (emscripten glue)', readFileSync(join(bls, 'blsjs.js')), 'what dashcore-lib uses for ChainLock verify');
  measure('@dashevo/bls blsjstmp.wasm', readFileSync(join(bls, 'blsjstmp.wasm')), 'loaded in addition to the glue');
}
const evo = process.argv[2] || '/tmp/claude-501/govhub-pk/evo/package';
if (existsSync(join(evo, 'dist/evo-sdk.module.js'))) measure('@dashevo/evo-sdk 5.0.0-rc.8 dist/evo-sdk.module.js', readFileSync(join(evo, 'dist/evo-sdk.module.js')), 'single-file ESM incl. wasm; NO Core API (see README)');

console.table(rows);
writeFileSync(join(root, 'test/sizes.json'), JSON.stringify(rows, null, 2));
