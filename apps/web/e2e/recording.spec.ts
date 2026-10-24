// A short recording of the moment a vote lands, for the PR (SCREENSHOTS=1 npm run screenshots): screenshots/vote-celebration.webm.
// Its own file because video recording needs its own worker.
import { expect, test, type Page } from '@playwright/test';
import { gotoFixtures } from './helpers.ts';

test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to refresh apps/web/screenshots');

async function signInAlice(page: Page) {
  await page.getByTestId('session-button').click();
  await page.getByRole('button', { name: /^Alice$/ }).click();
  await expect(page.getByTestId('session-button')).not.toHaveText('Sign in');
}

test.use({ colorScheme: 'light', viewport: { width: 1100, height: 760 }, video: { mode: 'on', size: { width: 1100, height: 760 } } });
test('@screenshots vote celebration video', async ({ page }) => {
  await gotoFixtures(page, '/p/OrchardPay?votesim=auto');
  await signInAlice(page);
  const panel = page.getByTestId('mn-vote-panel');
  await expect(panel.getByTestId('vote-mn-row')).toHaveCount(3);
  await panel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await panel.getByRole('checkbox', { name: 'All masternodes' }).uncheck();
  await panel.getByTestId('vote-mn-row').first().getByRole('checkbox').check();
  await panel.getByTestId('vote-choice').getByRole('radio', { name: 'No' }).click();
  await page.waitForTimeout(500);
  await panel.getByTestId('vote-send').click();
  await panel.getByTestId('vote-tracks').scrollIntoViewIfNeeded();
  const win = panel.getByTestId('vote-success').first();
  await expect(win).toBeVisible({ timeout: 20_000 });
  await win.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await expect(win.getByTestId('tally-no')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2500);
  const video = page.video();
  await page.close();
  if (video) await video.saveAs('screenshots/vote-celebration.webm');
});
