// Bundle sizes (esbuild --minify, browser, ESM, tree-shaken, dynamic imports split into chunks). Writes test/sizes.json.
//   node scripts/size.mjs
import { build } from 'esbuild';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kb = (n) => +(n / 1024).toFixed(1);
const rows = [];
const size = (label, b, extra = {}) => rows.push({ label, rawKB: kb(b.length), gzipKB: kb(gzipSync(b, { level: 9 }).length), brotliKB: kb(brotliCompressSync(b).length), ...extra });

async function bundle(contents, splitting = false) {
  return build({
    stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022',
    write: false, logLevel: 'silent', treeShaking: true, splitting, outdir: join(root, 'dist/size'), metafile: true,
  });
}
const total = (r) => Buffer.concat(r.outputFiles.map((f) => f.contents));

// 1. what `import { createDapi } from '@govhub/dapi'` costs, with lazy chunks split out
// (entry is client.ts rather than the barrel: esbuild does not apply package.json "sideEffects" to relative imports, so a barrel
// entry would drag every re-export in; Vite/Rollup consumers importing '@govhub/dapi' do honour "sideEffects": false)
const split = await bundle(`export { createDapi } from './src/client.ts'`, true);
const entry = split.outputFiles.find((f) => /stdin/.test(f.path)) ?? split.outputFiles[0];
const outKey = (f) => Object.keys(split.metafile.outputs).find((k) => basename(k) === basename(f.path));
const staticClosure = new Set();
(function walk(key) {
  if (staticClosure.has(key)) return;
  staticClosure.add(key);
  for (const i of split.metafile.outputs[key].imports) if (i.kind === 'import-statement') walk(i.path);
})(outKey(entry));
const initial = split.outputFiles.filter((f) => staticClosure.has(outKey(f)));
size('createDapi: initial load = entry + statically imported chunks (pool, failover, budget, grpc-web, protobuf, sha256, broadcast)', Buffer.concat(initial.map((f) => f.contents)));
for (const f of split.outputFiles) {
  if (initial.includes(f)) continue;
  const out = Object.entries(split.metafile.outputs).find(([k]) => basename(k) === basename(f.path))?.[1];
  const mods = Object.entries(out?.inputs ?? {}).sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput).slice(0, 4)
    .map(([k]) => basename(k).replace(/\.(ts|js)$/, '')).join(', ');
  size(`  lazy chunk (loaded on first use): ${mods}`, f.contents);
}
size('createDapi + every lazy chunk', total(split));

// 2. building blocks
size('DapiCore only (grpc-web + protobuf + 10 RPCs)', total(await bundle(`export { DapiCore } from './src/core.ts'`)).valueOf());
size('parsers (tx, block, header, merkleblock, CLSIG, ISDLOCK) + bloom + SML + CBOR', total(await bundle(`export * from './src/dash.ts'; export * from './src/bloom.ts'; export * from './src/sml.ts'`)));
size('full barrel: every export of @govhub/dapi, no BLS/X11', total(await bundle(`export * from './src/index.ts'`)));

// 3. separate entry points
size('@govhub/dapi/bls (noble bls12-381 + ChainLock rules)', total(await bundle(`export * from './src/bls.ts'`)));
size('@govhub/dapi/x11 (sphlib X11 compiled to WebAssembly, inline base64 + loader)', total(await bundle(`export * from './src/x11.ts'`)));
const wasmB64 = /X11_WASM_BASE64 = '([^']+)'/.exec(readFileSync(join(root, 'src/vendor/x11-wasm.ts'), 'utf8'))[1];
size('  ...of which the .wasm binary alone (what a separate asset would cost)', Buffer.from(wasmB64, 'base64'));
size('anchoring (headers, PoW/DGW, SML proof, ChainLock rules; lazy chunk content)', total(await bundle(`export * from './src/anchor.ts'`)));
size('@govhub/dapi/coreproof (dash-core-proof DIP 175 verifier compiled to WebAssembly, inline base64 + loader)', total(await bundle(`export * from './src/coreproof.ts'`)));
const proofB64 = /CORE_PROOF_WASM_BASE64 = '([^']+)'/.exec(readFileSync(join(root, 'src/vendor/core-proof-wasm.ts'), 'utf8'))[1];
size('  ...the core-proof .wasm alone (a separate asset would cost this)', Buffer.from(proofB64, 'base64'));
size('everything: barrel + bls + x11 + coreproof', total(await bundle(`export * from './src/index.ts'; export * from './src/bls.ts'; export * from './src/x11.ts'; export * from './src/coreproof.ts'`)));

console.table(rows);
writeFileSync(join(root, 'test/sizes.json'), JSON.stringify(rows, null, 2));
