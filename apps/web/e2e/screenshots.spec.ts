// Screenshots of the key pages for review (SCREENSHOTS=1 npm run screenshots), fixture mode,
// light and dark, desktop and mobile. Written to apps/web/screenshots/.
import { expect, test, type Page } from '@playwright/test';
import { TESTNET_GOV_CONTRACT_ID } from '../src/config/registry.ts';
import { gotoFixtures } from './helpers.ts';

test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to refresh apps/web/screenshots');

const VIEWPORTS = {
  desktop: { width: 1360, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

async function signInAlice(page: Page) {
  await page.getByTestId('session-button').click();
  await page.getByRole('button', { name: /^Alice$/ }).click();
  await expect(page.getByTestId('session-button')).not.toHaveText('Sign in');
}

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

      test(`@screenshots keyring page`, async ({ page }) => {
        await gotoFixtures(page, '/masternodes?votesim=manual');
        await signInAlice(page);
        await expect(page.getByTestId('key-group')).toHaveCount(2);
        await expect(page.getByTestId('mn-row')).toHaveCount(3);
        await shoot(page, `keyring-${scheme}-${vp}`);
      });

      test(`@screenshots vote panel`, async ({ page }) => {
        await gotoFixtures(page, '/p/OrchardPay?votesim=manual');
        await signInAlice(page);
        const panel = page.getByTestId('mn-vote-panel');
        await expect(panel.getByTestId('vote-mn-row')).toHaveCount(3);
        await panel.getByTestId('vote-choice').getByRole('radio', { name: 'No' }).click();
        await panel.scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        await panel.screenshot({ path: `screenshots/vote-panel-${scheme}-${vp}.png`, animations: 'disabled' });
        // signed: the tracker, while the relay holds the votes
        await panel.getByTestId('vote-send').click();
        await expect(panel.getByTestId('vote-tracker').first()).toHaveAttribute('data-status', 'held');
        await panel.getByTestId('vote-tracks').screenshot({ path: `screenshots/vote-tracker-${scheme}-${vp}.png`, animations: 'disabled' });
        // on the network and counted: the success card
        for (let i = 0; i < 2; i++) await page.evaluate(() => (window as unknown as { __voteSim: { advance(): void } }).__voteSim.advance());
        const win = panel.getByTestId('vote-success').first();
        await expect(win.getByTestId('tally-no')).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(1500); // let the check draw and the tally tick before the still
        await win.getByTestId('vote-verify').click();
        await expect(win.getByTestId('vote-proof')).toBeVisible();
        await panel.screenshot({ path: `screenshots/vote-success-${scheme}-${vp}.png` });
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
  test('@screenshots relay unreachable, with Retry now', async ({ page }) => {
    await gotoFixtures(page, '/p/OrchardPay?votesim=down');
    await signInAlice(page);
    const panel = page.getByTestId('mn-vote-panel');
    await panel.getByRole('checkbox', { name: 'All masternodes' }).uncheck();
    await panel.getByTestId('vote-mn-row').first().getByRole('checkbox').check();
    await panel.getByTestId('vote-choice').getByRole('radio', { name: 'No' }).click();
    await panel.getByTestId('vote-send').click();
    await expect(panel.getByTestId('vote-retry')).toBeVisible();
    await panel.getByTestId('vote-tracks').screenshot({ path: 'screenshots/vote-relay-down-light-desktop.png', animations: 'disabled' });
  });
  test('@screenshots held for the one-hour rule', async ({ page }) => {
    await gotoFixtures(page, '/p/OrchardPay?votesim=hour');
    await signInAlice(page);
    const panel = page.getByTestId('mn-vote-panel');
    await panel.getByRole('checkbox', { name: 'All masternodes' }).uncheck();
    await panel.getByTestId('vote-mn-row').first().getByRole('checkbox').check();
    await panel.getByTestId('vote-choice').getByRole('radio', { name: 'Abstain' }).click();
    await panel.getByTestId('vote-send').click();
    await expect(panel.getByTestId('vote-tracker').first()).toHaveAttribute('data-status', 'held');
    await panel.screenshot({ path: 'screenshots/vote-hour-rule-light-desktop.png', animations: 'disabled' });
  });
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
  test('@screenshots proposals that failed verification, revealed', async ({ page }) => {
    await gotoFixtures(page);
    await page.locator('.sentinel').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('toggle-failed')).toHaveText('Show 2 proposals that failed verification');
    await page.getByTestId('toggle-failed').click();
    const invalid = page.locator('article.card.card-invalid');
    await expect(invalid).toHaveCount(2);
    await invalid.first().scrollIntoViewIfNeeded();
    await shoot(page, 'failed-shown-light-desktop', false);
  });
  test('@screenshots failed-verification banner on a hidden proposal', async ({ page }) => {
    await gotoFixtures(page, '/p/govhub-fixture-tampered');
    await expect(page.getByTestId('invalid-banner')).toBeVisible();
    await shoot(page, 'invalid-banner-light-desktop', false);
  });
  test('@screenshots Testnet profile while its backend is being set up', async ({ page, context }) => {
    test.skip(!!TESTNET_GOV_CONTRACT_ID, 'the testnet backend is set up');
    await context.route(/^https?:\/\/(?!localhost[:/])/, (r) => r.abort());
    await page.goto('/settings?fixtures=0');
    await page.locator('.profile-switch label', { hasText: 'Testnet' }).click();
    await page.goto('/');
    await expect(page.getByTestId('backend-notice')).toBeVisible();
    await shoot(page, 'testnet-setup-light-desktop', false);
  });
  test('@screenshots duplicate-name chooser', async ({ page }) => {
    await gotoFixtures(page, '/p/Dash-Mass-Organic-Content-Attraction');
    await expect(page.locator('.chooser a')).toHaveCount(2);
    await shoot(page, 'chooser-light-desktop', false);
  });
});

