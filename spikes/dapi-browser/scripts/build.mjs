// Bundle the test page (page/flows.js + src/) into dist/ for the Playwright harness.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildPage() {
  mkdirSync(join(root, 'dist'), { recursive: true });
  await build({
    entryPoints: [join(root, 'page/flows.js')],
    outfile: join(root, 'dist/flows.js'),
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: false, sourcemap: false, logLevel: 'warning',
  });
  copyFileSync(join(root, 'page/index.html'), join(root, 'dist/index.html'));
  return join(root, 'dist');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) { await buildPage(); console.log('built dist/'); }
