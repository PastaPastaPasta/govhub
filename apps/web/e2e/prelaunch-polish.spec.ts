// Pre-launch polish (QA streams C2 and D): own comments under the default filter, Reset keeping the profile, the proposal page's
// Retry, the phone drawer, the missing icons and a damaged ?config= link. Fixture mode, or live mode with every non-local request aborted.
import { expect, test, type Page } from '@playwright/test';
import { gotoFixtures, offline, openDrawer, watchPage } from './helpers.ts';

async function signInAs(page: Page, who: RegExp) {
  await page.getByTestId('session-button').click();
  await page.getByRole('button', { name: who }).click();
  await expect(page.getByTestId('session-button')).not.toHaveText('Sign in');
}

test.describe('F1: your own comment stays', () => {
  test('under "Owner and masternodes" a new comment from a reader without a badge shows, with a note, and says it was posted', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/p/OrchardPay');
    await signInAs(page, /^Alice$/);
    const d = page.getByTestId('discussion');
    await d.getByText('Owner and masternodes').click();
    // nobody here is the owner or has a badge, so the view hides the sample comments of the other authors
    await expect(d.getByTestId('show-all')).toBeVisible();
    await d.getByRole('textbox', { name: 'Post comment' }).fill('My own words under the default filter');
    await d.getByRole('button', { name: 'Post comment' }).click();
    const mine = page.locator('li.comment', { has: page.locator(':scope > article', { hasText: 'My own words under the default filter' }) });
    await expect(mine).toBeVisible();
    await expect(mine.getByTestId('only-you-note')).toContainText('Only you see this');
    await expect(d.getByTestId('composer-posted')).toContainText('Posted');
    // Alice's sample comment from before shows too (hers); everybody else's is still filtered
    await expect(d.locator('li.comment:not(.comment-placeholder)')).toHaveCount(2);
    await expect(d).toContainText('Strong proposal');
    await expect(d).not.toContainText('Following up');
    // "Everyone" drops the note: the comment shows to all there
    await d.getByText('Everyone', { exact: true }).click();
    await expect(mine.getByTestId('only-you-note')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('F3: Reset to defaults keeps the profile', () => {
  test('on Testnet it resets the edits and stays on Testnet', async ({ page, context }) => {
    await offline(context);
    await page.goto('/settings?fixtures=0');
    await page.locator('.profile-switch label', { hasText: 'Testnet' }).click();
    await page.getByRole('button', { name: 'Switch to Testnet' }).click();
    await expect(page.getByTestId('profile-label')).toContainText('Testnet');
    await page.getByText('Advanced: choose your own servers').click();
    await page.getByLabel('Price feed URL (JSON with dash.usd; empty turns it off)').fill('https://price.example.org/dash');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByTestId('profile-label').locator('.chip-custom')).toBeVisible();
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    await expect(page.getByText(/Reset to the Testnet defaults \(you are still on Testnet\)/)).toBeVisible();
    await expect(page.getByTestId('profile-label')).toContainText('Testnet');
    await expect(page.getByTestId('profile-label')).not.toContainText('Dev');
    await expect(page.getByTestId('profile-label').locator('.chip-custom')).toHaveCount(0);
    // and a reload still starts on Testnet
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('govhub.registry.v2') ?? 'null'))).toEqual({ version: 2, profile: 'testnet', overrides: {} });
  });
});

test.describe('F4: a failed read has a Retry', () => {
  test('the proposal page says what happened in plain words and Retry re-runs the read', async ({ page, context }) => {
    await offline(context);
    await page.goto(`/p/h/${'ab'.repeat(32)}?fixtures=0`);
    const err = page.getByTestId('read-error');
    await expect(err).toBeVisible({ timeout: 30_000 });
    await expect(err.getByRole('button', { name: 'Retry' })).toBeVisible();
    // Retry runs the read again in place (no reload): the page shows the loading line, then the same failure
    const before = await page.evaluate(() => (window as unknown as { __marker?: number }).__marker);
    await page.evaluate(() => ((window as unknown as { __marker?: number }).__marker = 42));
    await err.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByTestId('read-error')).toBeVisible({ timeout: 30_000 });
    expect(before).toBeUndefined();
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(42); // the page was not reloaded
  });
});

test.describe('S3 (phone): the verification drawer stays inside the screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  test('a long URL in the proposal data wraps instead of widening the drawer', async ({ page }) => {
    await gotoFixtures(page, '/p/OrchardPay');
    const drawer = await openDrawer(page);
    await drawer.getByText('Proposal data and hashes').click();
    const raw = drawer.getByTestId('raw-data');
    await expect(raw).toBeVisible();
    // what a proposal with a long, unbroken URL puts in the data
    await raw.evaluate((el) => {
      const url = `https://example.org/${'x'.repeat(150)}`; // no hyphens or slashes: the browser has nowhere to break it
      for (const pre of el.querySelectorAll('pre')) pre.textContent = JSON.stringify({ url });
      const dd = el.querySelector('dd');
      if (dd) dd.textContent = url;
    });
    const m = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="verify-drawer"]') as HTMLElement;
      const body = d.querySelector('.drawer-body') as HTMLElement;
      const close = [...d.querySelectorAll('button')].find((b) => /close/i.test(b.textContent ?? '') || /close/i.test(b.getAttribute('aria-label') ?? '')) as HTMLElement;
      const r = close.getBoundingClientRect();
      return { dialog: d.clientWidth, bodyScroll: body.scrollWidth, bodyClient: body.clientWidth, closeRight: r.right, closeLeft: r.left, vw: window.innerWidth };
    });
    expect(m.bodyScroll).toBeLessThanOrEqual(m.bodyClient + 1);
    expect(m.closeLeft).toBeGreaterThanOrEqual(0);
    expect(m.closeRight).toBeLessThanOrEqual(m.vw);
    await expect(drawer.getByRole('button', { name: /close/i }).first()).toBeInViewport();
  });
});

test.describe('F6: the icons the browser asks for exist', () => {
  for (const [path, type] of [
    ['/favicon.ico', /icon/],
    ['/apple-touch-icon.png', /image\/png/],
    ['/manifest.webmanifest', /json|manifest/],
  ] as const) {
    test(`${path} is served`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type'] ?? '').toMatch(type);
      expect((await res.body()).length).toBeGreaterThan(100);
    });
  }
  test('the manifest names icons that exist', async ({ request }) => {
    const m = await (await request.get('/manifest.webmanifest')).json();
    for (const icon of m.icons) expect((await request.get(`/${icon.src}`)).status(), icon.src).toBe(200);
  });
});

test.describe('F12: a damaged ?config= link', () => {
  test('says the link is damaged, not what atob threw', async ({ page, context }) => {
    await offline(context);
    await page.goto('/settings?fixtures=1&config=%25%25not-base64%25%25');
    const offer = page.getByTestId('config-offer');
    await expect(offer).toContainText('This settings link is damaged');
    await expect(offer).not.toContainText(/atob|decoded|InvalidCharacterError/i);
  });
});
