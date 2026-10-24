// MN badge pages without the network: the badge page and the Settings trust list render, explain the leaks, and keep the CSP.
import { expect, test } from '@playwright/test';
import { cspViolations, gotoFixtures, watchPage } from './helpers.ts';

test.describe('MN badge (fixtures)', () => {
  test('badge page explains what leaks and asks for live data', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/badge');
    await expect(page.getByRole('heading', { name: 'MN owner badge' })).toBeVisible();
    await page.getByText('What the badge reveals, and to whom').first().click();
    await expect(page.getByText('What the issuer learns:')).toBeVisible();
    await expect(page.getByText(/Badges need live data/)).toBeVisible();
    expect(errors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('settings show the default trust list and validate new issuers', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/settings');
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
