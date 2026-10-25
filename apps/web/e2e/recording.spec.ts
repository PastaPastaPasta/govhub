// A short walkthrough for the PR (SCREENSHOTS=1 npm run screenshots): the landing view, a proposal, its "How do we know?" drawer,
// signing in and voting with the demo keyring until the vote lands. screenshots/after/walkthrough.webm. Its own file because video
// recording needs its own worker.
import { expect, test, type Page } from '@playwright/test';
import { gotoFixtures } from './helpers.ts';

test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to refresh apps/web/screenshots');

const pause = (page: Page, ms = 900) => page.waitForTimeout(ms);

test.use({ colorScheme: 'light', viewport: { width: 1180, height: 760 }, video: { mode: 'on', size: { width: 1180, height: 760 } } });
test('@screenshots walkthrough video', async ({ page }) => {
  test.setTimeout(120_000);
  await gotoFixtures(page, '/?votesim=auto');
  await pause(page, 1600);
  await page.mouse.wheel(0, 500);
  await pause(page, 1200);
  await page.getByRole('link', { name: 'Dash-Italia-Management-2026', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dash-Italia-Management-2026' })).toBeVisible();
  await pause(page, 1500);
  // the one trust badge, and everything behind it
  await page.getByTestId('trust-badge').click();
  const drawer = page.getByTestId('verify-drawer');
  await expect(drawer).toBeVisible();
  await pause(page, 1500);
  await drawer.locator('[data-check="collateral"] .check-more > summary').click();
  await pause(page, 1500);
  await drawer.getByText('Check the votes yourself').click();
  await drawer.getByTestId('votes-check').scrollIntoViewIfNeeded();
  await pause(page, 1800);
  await page.keyboard.press('Escape');
  await pause(page, 600);
  // sign in, vote, watch it land
  await page.getByTestId('session-button').click();
  await pause(page, 1200);
  await page.getByRole('button', { name: /^Alice$/ }).click();
  const panel = page.getByTestId('mn-vote-panel');
  await expect(panel.getByTestId('vote-mn-row')).toHaveCount(3);
  await panel.scrollIntoViewIfNeeded();
  await pause(page, 1000);
  await panel.getByTestId('vote-choice').getByRole('radio', { name: 'No' }).click();
  await pause(page, 800);
  await panel.getByTestId('vote-mns').locator('summary').click();
  await pause(page, 1000);
  await panel.getByRole('checkbox', { name: 'All masternodes' }).uncheck();
  await panel.getByTestId('vote-mn-row').first().getByRole('checkbox').check();
  await pause(page, 600);
  await panel.getByTestId('vote-send').click();
  await panel.getByTestId('vote-tracks').scrollIntoViewIfNeeded();
  const win = panel.getByTestId('vote-success').first();
  await expect(win).toBeVisible({ timeout: 20_000 });
  await win.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await expect(win.getByTestId('tally-no')).toBeVisible({ timeout: 20_000 });
  await pause(page, 2500);
  const video = page.video();
  await page.close();
  if (video) await video.saveAs('screenshots/after/walkthrough.webm');
});
