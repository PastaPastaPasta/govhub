import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import type { GovhubApi } from '../src/browser-entry.js';

const root = fileURLToPath(new URL('..', import.meta.url));

export function buildBrowserBundle(): void {
  execFileSync(process.execPath, ['scripts/build-browser.mjs'], { cwd: root, stdio: 'inherit' });
}

export async function launch(): Promise<{ browser: Browser; page: Page; call: Call }> {
  // Headless only; the page is a static file:// bundle, no server needed.
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page error]', e));
  await page.goto(pathToFileURL(root + 'dist/index.html').href);
  const call: Call = (fn, ...args) =>
    page.evaluate(([f, a]) => (window as any).govhub[f as string](...(a as unknown[])), [fn, args] as const) as never;
  return { browser, page, call };
}

type Call = <K extends keyof GovhubApi>(fn: K, ...args: Parameters<GovhubApi[K]>) => Promise<Awaited<ReturnType<GovhubApi[K]>>>;
