// Screenshots of the key pages for review (SCREENSHOTS=1 npm run screenshots), fixture mode ("Demo data"),
// light and dark, desktop and mobile. Written to apps/web/screenshots/after/ (the old design is in screenshots/before/).
import { expect, test, type Page } from '@playwright/test';
import { TESTNET_GOV_CONTRACT_ID } from '../src/config/registry.ts';
import { gotoFixtures, openDrawer, openGroup } from './helpers.ts';

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

const DIR = 'screenshots/after';
async function shoot(page: Page, name: string, fullPage = true) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage, animations: 'disabled' });
}
async function openMns(page: Page) {
  const mns = page.getByTestId('mn-vote-panel').getByTestId('vote-mns');
  if ((await mns.getAttribute('open')) === null) await mns.locator('summary').click();
}

for (const scheme of ['light', 'dark'] as const) {
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    test.describe(`${scheme} ${vp}`, () => {
      test.use({ colorScheme: scheme, viewport: size, deviceScaleFactor: vp === 'mobile' ? 2 : 1 });

      test(`@screenshots active list`, async ({ page }) => {
        await gotoFixtures(page);
        await expect(page.locator('article.prow').first()).toBeVisible();
        await shoot(page, `active-${scheme}-${vp}`, vp === 'mobile' ? false : true);
      });

      test(`@screenshots proposal and its drawer`, async ({ page }) => {
        await gotoFixtures(page, '/p/OrchardPay');
        await expect(page.getByTestId('trust-badge')).toHaveAttribute('data-trust', 'demo');
        await shoot(page, `proposal-${scheme}-${vp}`, vp === 'desktop');
        const drawer = await openDrawer(page);
        await expect(drawer.getByTestId('votes-check').locator('[data-votes]')).toHaveAttribute('data-votes', 'keys-reported', { timeout: 30_000 });
        await shoot(page, `drawer-${scheme}-${vp}`, false);
      });

      test(`@screenshots sign-in`, async ({ page }) => {
        await gotoFixtures(page);
        await page.getByTestId('session-button').click();
        await expect(page.getByRole('dialog', { name: 'Sign in or create an account' })).toBeVisible();
        await shoot(page, `signin-${scheme}-${vp}`, false);
      });

      test(`@screenshots about verification`, async ({ page }) => {
        await gotoFixtures(page, '/about/verification');
        await shoot(page, `about-${scheme}-${vp}`, vp === 'desktop');
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
        await openMns(page);
        await panel.scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        await panel.screenshot({ path: `${DIR}/vote-panel-${scheme}-${vp}.png`, animations: 'disabled' });
        // signed: the tracker, while the relay holds the votes
        await panel.getByTestId('vote-send').click();
        await expect(panel.getByTestId('vote-tracker').first()).toHaveAttribute('data-status', 'held');
        await panel.getByTestId('vote-tracks').screenshot({ path: `${DIR}/vote-tracker-${scheme}-${vp}.png`, animations: 'disabled' });
        // on the network and counted: the success card
        for (let i = 0; i < 2; i++) await page.evaluate(() => (window as unknown as { __voteSim: { advance(): void } }).__voteSim.advance());
        const win = panel.getByTestId('vote-success').first();
        await expect(win.getByTestId('tally-no')).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(1500); // let the check draw and the tally tick before the still
        await win.getByTestId('vote-yourself').locator('summary').click();
        await win.getByTestId('vote-verify').click();
        await expect(win.getByTestId('vote-proof')).toBeVisible();
        await panel.screenshot({ path: `${DIR}/vote-success-${scheme}-${vp}.png` });
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
    await openMns(page);
    await panel.getByRole('checkbox', { name: 'All masternodes' }).uncheck();
    await panel.getByTestId('vote-mn-row').first().getByRole('checkbox').check();
    await panel.getByTestId('vote-choice').getByRole('radio', { name: 'No' }).click();
    await panel.getByTestId('vote-send').click();
    await expect(panel.getByTestId('vote-retry')).toBeVisible();
    await panel.getByTestId('vote-tracks').screenshot({ path: `${DIR}/vote-relay-down-light-desktop.png`, animations: 'disabled' });
  });
  test('@screenshots held for the one-hour rule', async ({ page }) => {
    await gotoFixtures(page, '/p/OrchardPay?votesim=hour');
    await signInAlice(page);
    const panel = page.getByTestId('mn-vote-panel');
    await openMns(page);
    await panel.getByRole('checkbox', { name: 'All masternodes' }).uncheck();
    await panel.getByTestId('vote-mn-row').first().getByRole('checkbox').check();
    await panel.getByTestId('vote-choice').getByRole('radio', { name: 'Abstain' }).click();
    await panel.getByTestId('vote-send').click();
    await expect(panel.getByTestId('vote-tracker').first()).toHaveAttribute('data-status', 'held');
    await panel.screenshot({ path: `${DIR}/vote-hour-rule-light-desktop.png`, animations: 'disabled' });
  });
  test('@screenshots recount of recorded mainnet votes, in the drawer', async ({ page }) => {
    await gotoFixtures(page, '/p/dash-growth-q4-2026');
    const drawer = await openDrawer(page);
    await expect(drawer.getByTestId('votes-check').locator('[data-votes]')).toHaveAttribute('data-votes', 'keys-reported', { timeout: 30_000 });
    await drawer.getByText('Check the votes yourself').click();
    await drawer.locator('[data-check="collateral"] .check-more > summary').click();
    await shoot(page, 'drawer-votes-light-desktop', false);
  });
  test('@screenshots settings groups opened', async ({ page }) => {
    await gotoFixtures(page, '/settings');
    await openGroup(page, 'Advanced: choose your own servers');
    await shoot(page, 'settings-servers-light-desktop');
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
    await d.screenshot({ path: `${DIR}/discussion-light-desktop.png`, animations: 'disabled' });
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
    await panel.screenshot({ path: `${DIR}/claim-light-desktop.png`, animations: 'disabled' });
  });
  test('@screenshots proposals that failed verification, revealed', async ({ page }) => {
    await gotoFixtures(page);
    await page.locator('.sentinel').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('toggle-failed')).toHaveText('Show 2 proposals that failed verification');
    await page.getByTestId('toggle-failed').click();
    const invalid = page.locator('article.prow.prow-invalid');
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

