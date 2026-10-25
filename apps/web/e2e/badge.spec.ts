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

  test('the badge page is reachable from My masternodes, and its copy does not overclaim', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/masternodes');
    await page.getByTestId('mn-badge-link').click();
    await expect(page.getByRole('heading', { name: 'MN owner badge' })).toBeVisible();
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
    await expect(s.getByText('H62hSf5TpKbUSMov85GMhPQahZDbqsTipeoBsYPgveUH')).toBeVisible();
    await s.getByLabel('Name (shown as “vouched by …”)').fill('evil');
    await s.getByLabel('Issuer identity id').fill('not-an-id');
    await s.getByLabel('Issuer URL (https, its own origin)').fill('http://evil.example');
    await s.getByRole('button', { name: 'Add issuer' }).click();
    await expect(s.getByRole('alert')).toContainText('identityId must be a base58 identity id');
    expect(errors).toEqual([]);
  });
});
