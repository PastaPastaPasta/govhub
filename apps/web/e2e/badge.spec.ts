// MN badge pages without the network: the badge page and the Settings trust list render, explain the leaks, and keep the CSP.
import { expect, test } from '@playwright/test';
import { cspViolations, gotoFixtures, openGroup, watchPage } from './helpers.ts';

test.describe('MN badge (fixtures)', () => {
  test('badge page explains what leaks and asks for live data', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/badge');
    await expect(page.getByRole('heading', { name: 'MN owner badge' })).toBeVisible();
    await page.getByText('What the badge reveals, and to whom').first().click();
    await expect(page.getByText('In every mode', { exact: true })).toBeVisible();
    await expect(page.getByText(/Badges need live data/)).toBeVisible();
    expect(errors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('"Get an MN badge" leads to the unified flow on My masternodes; the keyring card has the badge row; the badge page copy does not overclaim', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/masternodes');
    await page.getByTestId('session-button').click();
    await page.getByRole('button', { name: /^Alice$/ }).click();
    await expect(page.getByTestId('key-group')).toHaveCount(2);
    // the account menu's badge link lands on this page's badge row
    await page.getByTestId('session-button').click();
    await page.getByTestId('menu-badge').click();
    await expect(page).toHaveURL(/\/masternodes(\?[^#]*)?#mn-badge$/);
    const row = page.getByTestId('mnb-row');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('mnb-summary')).toHaveText('not available here');
    await expect(row).toContainText('MN badges need live data');
    await expect(row.getByRole('switch')).toBeDisabled();
    // the standalone badge page stays, and points back to the unified flow
    await gotoFixtures(page, '/badge');
    await expect(page.getByRole('heading', { name: 'MN owner badge' })).toBeVisible();
    await expect(page.getByTestId('badge-main-path').getByRole('link', { name: 'add your masternodes' })).toHaveAttribute('href', /\/masternodes#mn-badge$/);
    const main = page.locator('#main');
    await expect(main).not.toContainText('never learns which identity');
    await expect(main).not.toContainText('cannot tell by timing');
    await expect(main.getByRole('link', { name: 'logging policy' }).first()).toHaveAttribute('href', /services\/issuer\/README\.md#what-is-stored-and-logged/);
    expect(errors).toEqual([]);
  });

  test('settings show the default trust list and validate new issuers', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/settings');
    await openGroup(page, 'Masternode badges');
    const s = page.locator('#badge-trust');
    await expect(s.getByText('govhub', { exact: true })).toBeVisible();
    await expect(s.getByText('9MJV17bn7C9xu1n3nopcZzScTnac3TNUjR17HmpKY4Cr')).toBeVisible();
    await s.getByLabel('Name (shown as “vouched by …”)').fill('evil');
    await s.getByLabel('Issuer identity id').fill('not-an-id');
    await s.getByLabel('Issuer URL (https, its own origin)').fill('http://evil.example');
    await s.getByRole('button', { name: 'Add issuer' }).click();
    await expect(s.getByRole('alert')).toContainText('identityId must be a base58 identity id');
    expect(errors).toEqual([]);
  });
});
