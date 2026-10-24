// Screenshots of the key pages for review (SCREENSHOTS=1 npm run screenshots), fixture mode,
// light and dark, desktop and mobile. Written to apps/web/screenshots/.
import { expect, test, type Page } from '@playwright/test';
import { gotoFixtures } from './helpers.ts';

test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to refresh apps/web/screenshots');

const VIEWPORTS = {
  desktop: { width: 1360, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

async function shoot(page: Page, name: string, fullPage = true) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `screenshots/${name}.png`, fullPage, animations: 'disabled' });
}

for (const scheme of ['light', 'dark'] as const) {
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    test.describe(`${scheme} ${vp}`, () => {
      test.use({ colorScheme: scheme, viewport: size, deviceScaleFactor: vp === 'mobile' ? 2 : 1 });

      test(`@screenshots active list`, async ({ page }) => {
        await gotoFixtures(page);
        await expect(page.locator('article.card').first()).toBeVisible();
        await shoot(page, `active-${scheme}-${vp}`, vp === 'mobile' ? false : true);
      });

      test(`@screenshots proposal verified`, async ({ page }) => {
        await gotoFixtures(page, '/p/OrchardPay');
        await expect(page.getByTestId('collateral-check').locator('[data-verdict]')).toHaveAttribute('data-verdict', 'ok');
        await page.getByRole('button', { name: 'Verify votes' }).click();
        await expect(page.getByTestId('votes-check').locator('[data-votes]')).toHaveAttribute('data-votes', 'keys-reported', { timeout: 30_000 });
        await shoot(page, `proposal-${scheme}-${vp}`);
      });

      test(`@screenshots settings`, async ({ page }) => {
        await gotoFixtures(page, '/settings');
        await shoot(page, `settings-${scheme}-${vp}`, vp === 'desktop');
      });
    });
  }
}

test.describe('extra', () => {
  test.use({ colorScheme: 'light', viewport: VIEWPORTS.desktop });
  test('@screenshots provenance popover', async ({ page }) => {
    await gotoFixtures(page, '/p/OrchardPay');
    await expect(page.getByTestId('collateral-check').locator('[data-verdict]')).toHaveAttribute('data-verdict', 'ok');
    await page.locator('.info-table [data-prov="verified"]').first().click();
    await expect(page.locator('.prov-pop:popover-open')).toBeVisible();
    await shoot(page, 'popover-light-desktop', false);
  });
  test('@screenshots recount of recorded mainnet votes', async ({ page }) => {
    await gotoFixtures(page, '/p/dash-growth-q4-2026');
    await expect(page.getByTestId('collateral-check').locator('[data-verdict]')).toHaveAttribute('data-verdict', 'ok');
    await page.getByRole('button', { name: 'Verify votes' }).click();
    await expect(page.getByTestId('votes-check').locator('[data-votes]')).toHaveAttribute('data-votes', 'keys-reported', { timeout: 30_000 });
    await shoot(page, 'votes-recorded-light-desktop');
  });
  test('@screenshots discussion with hidden comments shown, signed in, reply open', async ({ page }) => {
    await gotoFixtures(page, '/p/OrchardPay');
    await page.getByTestId('session-button').click();
    await page.getByRole('button', { name: /^Alice$/ }).click();
    const d = page.getByTestId('discussion');
    await d.getByTestId('toggle-hidden').click();
    await d.locator('li.comment > article', { hasText: 'who audits' }).getByRole('button', { name: 'Reply' }).click();
    await d.scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    await d.screenshot({ path: 'screenshots/discussion-light-desktop.png', animations: 'disabled' });
  });
  test('@screenshots owner post and owner label (attestation)', async ({ page }) => {
    await gotoFixtures(page, '/p/dash-growth-q4-2026');
    await expect(page.getByTestId('owner-post').getByRole('heading')).toBeVisible();
    await shoot(page, 'owner-post-light-desktop');
  });
  test('@screenshots claim panel', async ({ page }) => {
    await gotoFixtures(page, '/p/OrchardPay');
    await page.getByTestId('session-button').click();
    await page.getByRole('button', { name: /^Alice$/ }).click();
    const panel = page.getByTestId('claim-panel');
    await panel.locator('summary').click();
    await panel.screenshot({ path: 'screenshots/claim-light-desktop.png', animations: 'disabled' });
  });
  test('@screenshots duplicate-name chooser', async ({ page }) => {
    await gotoFixtures(page, '/p/Dash-Mass-Organic-Content-Attraction');
    await expect(page.locator('.chooser a')).toHaveCount(2);
    await shoot(page, 'chooser-light-desktop', false);
  });
});
