// Bundles src/browser-entry.ts into dist/page.js + dist/index.html (served via file://).
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src/browser-entry.ts')],
  outfile: join(dist, 'page.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  logLevel: 'warning',
});
writeFileSync(
  join(dist, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>govhub blindrsa spike</title><script src="page.js"></script>\n',
);
const js = readFileSync(join(dist, 'page.js'));
console.log(`dist/page.js: ${js.length} B min, ${gzipSync(js).length} B gzip`);
