// Opt-in live test (GOVHUB_LIVE=1 npm run e2e:live): real evo-sdk Platform reads with proofs from
// the testnet gov contract, and a real mainnet DAPI collateral lookup from the browser worker.
import { expect, test } from '@playwright/test';
import { cspViolations, watchPage } from './helpers.ts';

test.skip(!process.env.GOVHUB_LIVE, 'set GOVHUB_LIVE=1 to run against live Platform and DAPI');
test.setTimeout(180_000);

test('@live reads the gov contract with proofs and verifies a collateral over mainnet DAPI', async ({ page }) => {
  const errors = await watchPage(page);
  await page.goto('/?fixtures=0');

  // The SDK chunk loads lazily; either proposals or the "nothing published yet" banner appear.
  const cards = page.locator('article.card');
  const empty = page.getByText('No active proposals on Platform yet.');
  await expect(cards.first().or(empty)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Platform could not be read.')).toHaveCount(0);

  const n = await cards.count();
  console.log(`live: ${n} active proposals on Platform`);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: 'screenshots/live-active-light-desktop.png', fullPage: true });
  if (n > 0) {
    // Values read from Platform carry the proof mark.
    await expect(cards.first().locator('[data-prov="proof"], [data-prov="reported"]').first()).toBeVisible();
    await cards.first().locator('h3 a').click();
    const collateral = page.getByTestId('collateral-check');
    // Real proposals verify; phase-0 spike documents (testnet collateral) fail the lookup. Either way the check ran.
    await expect(collateral.locator('[data-verdict]')).toBeVisible({ timeout: 90_000 });
    const verdict = await collateral.locator('[data-verdict]').getAttribute('data-verdict');
    console.log(`live: ${await page.locator('h1').innerText()} collateral verdict ${verdict}: ${(await collateral.innerText()).replace(/\s+/g, ' ').slice(0, 400)}`);
    await expect(collateral.locator('[data-step="hash"]')).toBeVisible();
    if (process.env.SCREENSHOTS) await page.screenshot({ path: 'screenshots/live-proposal-light-desktop.png', fullPage: true });
  }

  expect(errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});
