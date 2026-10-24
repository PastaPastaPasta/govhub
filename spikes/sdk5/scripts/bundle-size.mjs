// Bundle-size comparison of evo-sdk 4.1.1 vs 5.0.0-rc.8, as a browser app would ship them.
//
//   npm run bundle-size
//
// Builds a tiny entry that lazy-imports the SDK (like apps/web will) with vite/rollup, then reports
// raw / gzip / brotli sizes of every emitted chunk, plus the on-disk package files.
import { build } from 'vite';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const kb = (n) => `${(n / 1024).toFixed(0)} KiB`;
const mb = (n) => `${(n / 1048576).toFixed(2)} MiB`;
const results = {};

for (const [label, pkg] of [['4.1.1', 'evo4'], ['5.0.0-rc.8', 'evo5']]) {
  const work = mkdtempSync(join(tmpdir(), `bundle-${pkg}-`));
  const entry = join(work, 'main.js');
  writeFileSync(entry, `export const load = () => import('${pkg}');\nwindow.__load = load;\n`);
  const outDir = join(work, 'dist');
  await build({
    root: work, logLevel: 'error', configFile: false,
    resolve: { preserveSymlinks: false },
    build: { outDir, emptyOutDir: true, minify: 'esbuild', target: 'es2022', lib: false, rollupOptions: { input: entry, output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' } } },
    // resolve the aliased packages from the spike's node_modules
    server: { fs: { allow: [root, work] } },
    plugins: [{ name: 'alias-local', enforce: 'pre', async resolveId(id) { if (id === pkg) return this.resolve(join(root, 'node_modules', pkg, 'dist/evo-sdk.module.js')); } }],
  });
  const files = [];
  const walk = (d) => readdirSync(d).forEach((f) => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); });
  walk(outDir);
  const chunks = files.map((p) => {
    const buf = readFileSync(p);
    return { file: p.slice(outDir.length + 1), raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length, brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length };
  }).sort((a, b) => b.raw - a.raw);
  const total = chunks.reduce((a, c) => ({ raw: a.raw + c.raw, gzip: a.gzip + c.gzip, brotli: a.brotli + c.brotli }), { raw: 0, gzip: 0, brotli: 0 });
  const pkgDir = join(root, 'node_modules', pkg);
  const pkgFile = (rel) => { try { return statSync(join(pkgDir, rel)).size; } catch { return undefined; } };
  results[label] = { chunks, total, evoSdkModuleJs: pkgFile('dist/evo-sdk.module.js') };
  console.log(`\n== evo-sdk ${label}`);
  for (const c of chunks) console.log(`  ${c.file.padEnd(34)} raw ${mb(c.raw)}  gzip ${mb(c.gzip)}  br ${mb(c.brotli)}`);
  console.log(`  TOTAL (lazy SDK chunk + stub)     raw ${mb(total.raw)}  gzip ${mb(total.gzip)}  br ${mb(total.brotli)}`);
  rmSync(work, { recursive: true, force: true });
}

// raw .wasm inside the wasm-sdk packages (the module inlines it as base64, so shipped size > wasm size)
for (const [label, dir] of [['4.1.1', join(root, 'node_modules/@dashevo/wasm-sdk/dist')], ['5.0.0-rc.8', join(root, 'node_modules/evo5/node_modules/@dashevo/wasm-sdk/dist')]]) {
  const raw = join(dir, 'raw');
  const wasm = readdirSync(raw, { recursive: true }).filter((f) => String(f).endsWith('.wasm')).map((f) => ({ f: String(f), size: statSync(join(raw, String(f))).size }));
  results[label].wasmFiles = wasm;
  console.log(`\nwasm-sdk ${label} .wasm files: ${wasm.map((w) => `${w.f} ${mb(w.size)}`).join(', ') || '(none in dist/raw)'}`);
}

mkdirSync(join(root, 'results'), { recursive: true });
writeFileSync(join(root, 'results/bundle-size.json'), JSON.stringify(results, null, 2) + '\n');
console.log('\nsaved results/bundle-size.json');
