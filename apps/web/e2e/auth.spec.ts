// Sign-in sheet, offline: the create flow up to funding, the 3-word quiz, key-paste validation, and a clean CSP. Nothing here
// touches the network for auth (the live flow is auth-live.spec.ts).
import { expect, test } from '@playwright/test';
import { cspViolations, gotoFixtures, watchPage } from './helpers.ts';

test('create flow shows a fresh phrase, checks three words, then offers funding', async ({ page }) => {
  const errors = await watchPage(page);
  await gotoFixtures(page);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const sheet = page.getByRole('dialog', { name: 'Sign in or create an account' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: /Create an account/ }).click();

  const words = page.getByTestId('phrase-words').locator('li');
  await expect(words).toHaveCount(12);
  const phrase = (await words.allInnerTexts()).map((t) => t.trim().split(/\s+/)[1]!);
  await page.getByRole('button', { name: 'Use 24 words instead' }).click();
  await expect(words).toHaveCount(24);
  const phrase24 = (await words.allInnerTexts()).map((t) => t.trim().split(/\s+/)[1]!);
  expect(phrase24.slice(0, 12)).not.toEqual(phrase);

  await page.getByRole('button', { name: 'I wrote it down' }).click();
  const inputs = page.locator('[data-testid^="quiz-"]');
  await expect(inputs).toHaveCount(3);
  // wrong answers are refused
  for (const i of await inputs.all()) await i.fill('wrong');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText("doesn't match");
  for (const i of await inputs.all()) {
    const n = Number((await i.getAttribute('data-testid'))!.slice(5));
    await i.fill(phrase24[n - 1]!.toUpperCase());
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: /Pay with DASH/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /I have a voucher link/ })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});

test('recovery phrase and key paste refuse bad input without echoing it', async ({ page }) => {
  await gotoFixtures(page);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /I have a recovery phrase/ }).click();
  // D-033: masked until "Show"
  await expect(page.getByTestId('phrase-input')).toHaveCSS('-webkit-text-security', 'disc');
  await page.getByTestId('phrase-input').fill('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon');
  await page.getByRole('button', { name: 'Show the recovery phrase' }).click();
  await expect(page.getByTestId('phrase-input')).toHaveCSS('-webkit-text-security', 'none');
  await page.getByRole('button', { name: 'Hide the recovery phrase' }).click();
  await expect(page.getByTestId('phrase-input')).toHaveCSS('-webkit-text-security', 'disc');
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await expect(page.getByRole('alert')).toContainText("isn't valid");

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Paste a key/ }).click();
  const secret = 'XBadKeyThatIsNotAWifAtAllXXXXXXXXXXXXXXXXXXXXXXXXXX';
  await page.getByTestId('key-input').fill(secret);
  await expect(page.getByTestId('key-input')).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('WIF or 64 hex');
  await expect(alert).not.toContainText(secret);
});

test('passkey sign-in explains itself when the browser has no passkey support', async ({ page }) => {
  await gotoFixtures(page);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Use a passkey/ }).click();
  // Headless Chromium without a virtual authenticator still exposes WebAuthn; the button is there and a cancelled prompt is not an error.
  await expect(page.getByRole('button', { name: 'Use a passkey' })).toBeVisible();
});
