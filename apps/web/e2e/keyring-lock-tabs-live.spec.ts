// Opt-in live TESTNET run of D-015 across tabs (QA stream B, T2c), headless Chromium, live data (?fixtures=0), one browser context:
//   sign in with the recovery phrase in tab A (the saved keyring opens) -> Lock now -> a NEW tab B is signed in but its keyring stays
//   locked -> reloading A with B open: locked -> A switches profile (Settings: Dev, then Testnet), locked on each -> the phrase
//   unlocks A only (B stays locked) -> a new tab C opens unlocked -> A's idle lock (its clock moved 20 min on) locks C too -> a new
//   tab D stays locked.
// GOVHUB_LIVE_AUTH=1 npx playwright test e2e/keyring-lock-tabs-live.spec.ts. The phrase is the e2e identity's
// (~/.local/share/govhub-phase2/e2e-phrase.json), typed into password fields and never printed; no screenshots; traces are off for
// live runs (playwright.config.ts). Spends nothing (reads the saved keyring, signs nothing).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { profileRegistry } from '../src/config/registry.ts';

test.skip(!process.env.GOVHUB_LIVE_AUTH, 'set GOVHUB_LIVE_AUTH=1 to run the live testnet keyring lock across tabs');
test.setTimeout(15 * 60_000);

const PHRASE = JSON.parse(readFileSync(join(homedir(), '.local/share/govhub-phase2/e2e-phrase.json'), 'utf8')).phrase as string;
const REGISTRY = profileRegistry('testnet');

const button = (page: Page) => page.getByTestId('session-button');
async function openTab(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`pageerror: ${e.message.replace(/[1-9A-HJ-NP-Za-km-z]{50,}/g, '[b58]').slice(0, 300)}`));
  await page.goto('/masternodes?fixtures=0');
  return page;
}
async function signedIn(page: Page) {
  await expect(button(page)).not.toHaveText(/^(Sign in|Signing in…)$/, { timeout: 150_000 });
}
async function signInWithPhrase(page: Page) {
  await expect(button(page)).toHaveText('Sign in', { timeout: 30_000 });
  await button(page).click();
  const sheet = page.locator('dialog[open]');
  await sheet.getByRole('button', { name: /I have a recovery phrase/ }).click();
  await sheet.getByTestId('phrase-input').fill(PHRASE);
  await sheet.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await signedIn(page);
}
async function unlocked(page: Page) {
  await expect(page.getByTestId('keyring-status')).toContainText('Unlocked', { timeout: 180_000 });
  await expect(page.getByTestId('key-group').first()).toBeVisible();
}
/** Signed in, the keyring locked, and it stays locked (no late open from the seed). */
async function staysLocked(page: Page) {
  await signedIn(page);
  await expect(page.getByTestId('unlock-phrase')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(8_000); // the bug opened it a few seconds after the hand-over (a keyring fetch)
  await expect(page.getByTestId('unlock-phrase')).toBeVisible();
  await expect(page.getByTestId('keyring-status')).toHaveCount(0);
  await expect(page.getByTestId('key-group')).toHaveCount(0);
}
const nav = (page: Page, path: string) =>
  page.evaluate((p) => {
    history.pushState({}, '', p);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
async function pickProfile(page: Page, label: string) {
  await page.locator('.profile-switch label').filter({ hasText: new RegExp(`^${label}`) }).click();
  await page.getByTestId('profile-confirm').getByRole('button', { name: /^Switch to/ }).click();
}

test('@live-auth D-015: Lock now and the idle lock cover every tab of the session (new tab, reload, profile round trip)', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript((r) => localStorage.setItem('govhub.registry.v2', JSON.stringify(r)), REGISTRY);

  // ---- A: phrase sign-in, the saved keyring opens; Lock now ----
  const a = await openTab(context);
  await signInWithPhrase(a);
  await unlocked(a);
  await a.getByTestId('keyring-lock').click();
  await expect(a.getByTestId('unlock-phrase')).toBeVisible();
  await expect(a.getByTestId('key-group')).toHaveCount(0);

  // ---- B, a new tab after the lock: signed in (shared sign-in), keyring locked ----
  console.log('new tab after Lock now');
  const b = await openTab(context);
  await staysLocked(b);

  // ---- reload A while B is open: B hands the session back, locked ----
  console.log('reload A with B open');
  await a.reload();
  await staysLocked(a);

  // ---- A switches profile and back (a switch signs the tab out; Dev shares Testnet's Platform, so B hands it the session): locked
  console.log('profile round trip in A');
  await nav(a, '/settings');
  await pickProfile(a, 'Dev');
  await nav(a, '/masternodes');
  await staysLocked(a);
  await nav(a, '/settings');
  await pickProfile(a, 'Testnet');
  await nav(a, '/masternodes');
  await staysLocked(a);
  await staysLocked(b);

  // ---- the phrase unlocks A; B (open at the lock) stays locked; a tab opened now may open it ----
  console.log('phrase unlock in A');
  await a.getByTestId('unlock-phrase').fill(PHRASE);
  await a.getByRole('button', { name: 'Unlock with the phrase' }).click();
  await unlocked(a);
  await expect(b.getByTestId('unlock-phrase')).toBeVisible();
  await expect(b.getByTestId('key-group')).toHaveCount(0);
  const c = await openTab(context);
  await signedIn(c);
  await unlocked(c);

  // ---- A's idle lock (only A's clock moves on; C is the tab in use): every tab locks, and a new tab stays locked ----
  console.log('idle lock in A');
  await a.evaluate(() => {
    const now = Date.now.bind(Date);
    Date.now = () => now() + 20 * 60_000;
  });
  await expect(a.getByTestId('unlock-phrase')).toBeVisible({ timeout: 60_000 }); // its 15 s check
  await expect(c.getByTestId('unlock-phrase')).toBeVisible({ timeout: 10_000 });
  await expect(c.getByTestId('key-group')).toHaveCount(0);
  const d = await openTab(context);
  await staysLocked(d);
  await context.close();
});
