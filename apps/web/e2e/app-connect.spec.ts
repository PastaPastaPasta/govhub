// Sign in with a Dash wallet (App Connect), behind its flag. Off (the default on every profile): the sheet shows the disabled "Coming
// soon" button and the App Connect chunk is never fetched. On (the hidden ?appconnect=1 opt-in): fixture mode answers the request with
// a simulated wallet, through the real verifier; live mode with no network shows the error state.
import { expect, test, type Page } from '@playwright/test';
import { gotoFixtures, offline, watchPage } from './helpers.ts';

const openSheet = async (page: Page) => {
  await page.getByTestId('session-button').click();
  await expect(page.getByRole('dialog', { name: 'Sign in or create an account' })).toBeVisible();
};

const SHOTS = !!process.env.SCREENSHOTS;
const shoot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `screenshots/app-connect/${name}.png`, animations: 'disabled' });
};

for (const [vp, size] of [
  ['desktop', { width: 1360, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
] as const) {
  test.describe(vp, () => {
    test.use({ viewport: size, deviceScaleFactor: vp === 'mobile' ? 2 : 1 });

    test('flag off: "Coming soon", no App Connect code fetched, no page errors', async ({ page, context }) => {
      await offline(context);
      const errors = await watchPage(page);
      const fetched: string[] = [];
      page.on('request', (r) => fetched.push(r.url()));
      await page.goto('/');
      await openSheet(page);
      const b = page.getByTestId('wallet-signin');
      await expect(b).toBeDisabled();
      await expect(b).toContainText('Coming soon');
      await shoot(page, `flag-off-${vp}`);
      await page.waitForTimeout(500);
      expect(fetched.filter((u) => /WalletSignIn|appconnect|walletDemo/i.test(u))).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('flag on (fixtures): QR and link, a refused answer, then "Continue as" signs in', async ({ page }) => {
      const errors = await watchPage(page);
      await gotoFixtures(page, '/?appconnect=1');
      await openSheet(page);
      await page.getByTestId('wallet-signin').click();
      await expect(page.getByRole('dialog', { name: 'Sign in with a Dash wallet' })).toBeVisible();
      await expect(page.getByTestId('wallet-waiting')).toBeVisible();
      await expect(page.getByRole('img', { name: 'Sign-in request for your Dash wallet' })).toBeVisible();
      const href = await page.getByTestId('wallet-open').getAttribute('href');
      expect(href).toMatch(/^dashpay:\/\/connect\?v=2&n=m&r=[A-Za-z0-9_-]+$/);
      await shoot(page, `qr-waiting-${vp}`);

      await page.getByRole('button', { name: 'Send a bad answer' }).click();
      await expect(page.getByTestId('wallet-note')).toContainText('was refused: it holds a key govhub did not ask for');
      await shoot(page, `refused-${vp}`);

      await page.getByRole('button', { name: 'Approve as Alice' }).click();
      await expect(page.getByTestId('wallet-confirm')).toBeVisible();
      await expect(page.getByTestId('wallet-confirm')).toContainText('Continue as');
      await expect(page.getByTestId('wallet-confirm')).toContainText('0.1');
      await shoot(page, `confirm-${vp}`);
      await page.getByTestId('wallet-continue').click();
      await expect(page.getByRole('dialog', { name: 'Sign in with a Dash wallet' })).toBeHidden();
      await expect(page.getByTestId('session-button')).not.toHaveText('Sign in');
      expect(errors).toEqual([]);
    });

    test('flag on: "Not me" drops the answer and keeps waiting', async ({ page }) => {
      await gotoFixtures(page, '/?appconnect=1');
      await openSheet(page);
      await page.getByTestId('wallet-signin').click();
      await page.getByRole('button', { name: 'Approve as Alice' }).click();
      await page.getByTestId('wallet-not-me').click();
      await expect(page.getByTestId('wallet-waiting')).toBeVisible();
      await expect(page.getByTestId('session-button')).toHaveText('Sign in');
    });

    test('flag on (live, no network): the error state offers a retry', async ({ page, context }) => {
      await offline(context);
      await page.goto('/?appconnect=1');
      await openSheet(page);
      await page.getByTestId('wallet-signin').click();
      await expect(page.getByTestId('wallet-failed')).toBeVisible({ timeout: 45_000 });
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
      await shoot(page, `error-${vp}`);
    });
  });
}
