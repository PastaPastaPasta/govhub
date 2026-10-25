// Opt-in live TESTNET run of the sign-in shared between tabs (session/tabShare.ts), headless Chromium, live data (?fixtures=0):
//   sign in with a pasted key in tab A -> a tab opened after it is signed in -> reloading A keeps it signed in (B hands the session
//   back) and does not sign B out -> a new browser context (a browser restart: nothing is on disk) is signed out -> signing out in
//   B signs A out.
// GOVHUB_LIVE_AUTH=1 npx playwright test e2e/tab-session-live.spec.ts. The key is the EvoVote QA identity's HIGH key
// (~/.local/share/evovote-v2-qa-20261018/alice.high.wif), typed into a password field and never printed; traces are off for live
// runs (playwright.config.ts). Spends nothing.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { profileRegistry } from '../src/config/registry.ts';

test.skip(!process.env.GOVHUB_LIVE_AUTH, 'set GOVHUB_LIVE_AUTH=1 to run the live testnet tab-sharing flow');
test.setTimeout(5 * 60_000);

const WIF_FILE = join(homedir(), '.local/share/evovote-v2-qa-20261018/alice.high.wif');
const REGISTRY = profileRegistry('testnet');

/** A browser context (one "browser": its tabs share the session) preset to the testnet registry. */
async function testnetContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addInitScript((r) => localStorage.setItem('govhub.registry.v2', JSON.stringify(r)), REGISTRY);
  return context;
}
async function testnetPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/?fixtures=0');
  return page;
}
const button = (page: Page) => page.getByTestId('session-button');
/** The signed-in identity, read from the account menu. */
async function identity(page: Page, timeout = 120_000): Promise<string> {
  await expect(button(page)).not.toHaveText(/^(Sign in|Signing in…)$/, { timeout });
  await button(page).click();
  const id = (await page.getByTestId('session-identity').innerText()).trim();
  await page.keyboard.press('Escape');
  return id;
}
async function signedOut(page: Page, timeout = 15_000) {
  await expect(button(page)).toHaveText('Sign in', { timeout });
}

test('@live-auth one sign-in for the open tabs of a browser, gone with the browser', async ({ browser }) => {
  const wif = readFileSync(WIF_FILE, 'utf8').trim();
  const context = await testnetContext(browser);

  // ---- A: key sign-in ----
  const a = await testnetPage(context);
  await signedOut(a);
  await button(a).click();
  const sheet = a.locator('dialog[open]');
  await sheet.getByRole('button', { name: /Paste a key/ }).click();
  await sheet.getByTestId('key-input').fill(wif);
  await sheet.getByRole('button', { name: 'Sign in', exact: true }).click();
  const id = await identity(a);
  expect(id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);

  // ---- B, opened after the sign-in: signed in as the same identity ----
  const b = await testnetPage(context);
  expect(await identity(b)).toBe(id);

  // ---- reloading A (pagehide wipes A's copy only): B stays signed in and hands the session back ----
  await a.reload();
  expect(await identity(a)).toBe(id);
  expect(await identity(b)).toBe(id);

  // ---- a new browser context (a restart): signed out, nothing to restore ----
  const restarted = await testnetContext(browser);
  const c = await testnetPage(restarted);
  await c.waitForTimeout(3000);
  await signedOut(c, 1);
  await restarted.close();

  // ---- sign-out in B signs out A ----
  await button(b).click();
  await b.getByRole('button', { name: 'Sign out' }).click();
  await signedOut(b);
  await signedOut(a);
  await context.close();
});
