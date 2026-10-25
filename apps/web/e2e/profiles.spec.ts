// Network profiles (one-action switch, header label, v1 migration, "being set up") and the failed-verification hide rules.
// No live backend: fixture mode, or live mode with every non-local request aborted.
import { expect, test } from '@playwright/test';
import { TESTNET_GOV_CONTRACT_ID } from '../src/config/registry.ts';
import { cspViolations, gotoFixtures, offline, openDrawer, openGroup, watchPage } from './helpers.ts';


test.describe('failed verification is hidden (fixtures)', () => {
  test('lists, budget header and active count leave out the two invalid proposals; the toggle reveals them', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page);
    const cards = page.locator('article.prow');
    await page.locator('.sentinel').scrollIntoViewIfNeeded();
    // The tampered one fails at once (no network); the one naming another proposal's collateral fails once the worker has the tx.
    const toggle = page.getByTestId('toggle-failed');
    await expect(toggle).toHaveText('Show 2 proposals that failed verification');
    await expect(cards).toHaveCount(28);
    await expect(page.locator('article.prow[data-check="pending"]')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('.budget-facts')).toContainText('of 28 proposals');
    await expect(page.getByRole('link', { name: /^Active/ }).locator('.count')).toHaveText('28');
    await expect(page.locator('article.prow', { hasText: 'govhub-fixture' })).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveText('Hide 2 proposals that failed verification');
    await expect(cards).toHaveCount(30);
    const tampered = page.locator('article.prow.prow-invalid', { hasText: 'govhub-fixture-tampered' });
    await expect(tampered.getByTestId('invalid-reason')).toContainText('Displayed fields: differ from the hashed data: url');
    const wrong = page.locator('article.prow.prow-invalid', { hasText: 'govhub-fixture-wrong-collateral' });
    await expect(wrong.getByTestId('invalid-reason')).toContainText('OP_RETURN and outputs: no-matching-op-return');
    // Revealing them changes nothing in the counts.
    await expect(page.locator('.budget-facts')).toContainText('of 28 proposals');

    await toggle.click();
    await expect(cards).toHaveCount(28);
    expect(errors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('a hidden proposal opened directly is shown under a failed-verification banner', async ({ page }) => {
    await gotoFixtures(page, '/p/govhub-fixture-tampered');
    await expect(page.getByRole('heading', { level: 1, name: 'govhub-fixture-tampered' })).toBeVisible();
    await expect(page.getByTestId('invalid-banner')).toContainText('This proposal failed verification: Displayed fields: differ from the hashed data: url');
    // The published (tampered) URL is not linked.
    await expect(page.locator('a.ext')).toHaveCount(0);

    await gotoFixtures(page, '/p/govhub-fixture-wrong-collateral');
    await expect(page.getByTestId('invalid-banner')).toBeVisible();
    const drawer = await openDrawer(page);
    await expect(drawer.getByTestId('collateral-check').locator('[data-verdict]')).toHaveAttribute('data-verdict', 'fail');
    await expect(drawer.locator('[data-check="collateral"]')).toHaveAttribute('data-state', 'failed');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('invalid-banner')).toContainText('This proposal failed verification: OP_RETURN and outputs: no-matching-op-return');
  });

  test('a real proposal shows no banner', async ({ page }) => {
    await gotoFixtures(page, '/p/OrchardPay');
    const drawer = await openDrawer(page);
    await expect(drawer.getByTestId('collateral-check').locator('[data-verdict]')).toHaveAttribute('data-verdict', 'demo');
    await expect(page.getByTestId('invalid-banner')).toHaveCount(0);
  });
});

test.describe('network profiles', () => {
  test('switching profile is one action; the header always names the active profile', async ({ page, context }) => {
    await offline(context);
    const errors = await watchPage(page);
    await page.goto('/settings?fixtures=0');
    const label = page.getByTestId('profile-label');
    await expect(label).toContainText('Dev: mainnet data on testnet Platform');
    const mainnet = page.getByRole('radio', { name: /Mainnet/ });
    await expect(mainnet).toBeDisabled();
    await expect(page.locator('.profile-switch')).toContainText('not yet deployed');

    await page.locator('.profile-switch label', { hasText: 'Testnet' }).click();
    await expect(page.getByRole('radio', { name: 'Testnet' })).toBeChecked();
    // picking is not switching: the switch waits for the confirmation (D-058)
    await expect(label).toContainText('Dev: mainnet data on testnet Platform');
    await page.getByRole('button', { name: 'Switch to Testnet' }).click();
    await expect(label).toContainText('Testnet');
    await expect(label).not.toContainText('Dev');
    await expect(page.getByTestId('profile-description')).toContainText('Core testnet, Platform testnet');
    // Saved as the profile with no overrides (rebuilt from the profile on load).
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('govhub.registry.v2') ?? 'null'));
    expect(saved).toEqual({ version: 2, profile: 'testnet', overrides: {} });
    await openGroup(page, 'Export, import and share');
    await page.getByRole('button', { name: 'Show JSON' }).click();
    const json = JSON.parse(await page.getByLabel('Settings JSON (paste and import, or copy)').inputValue());
    expect(json).toMatchObject({ version: 2, profile: 'testnet', coreNetwork: 'testnet', platformNetwork: 'testnet', govContractId: TESTNET_GOV_CONTRACT_ID });
    expect(json.bridges.map((b: { httpBase: string }) => b.httpBase)).toEqual(['https://gov-bridge-testnet.dashhq.org']);
    expect(json.dapi.quorumUrl).toBe('https://quorums.testnet.networks.dash.org/masternodes');

    if (!TESTNET_GOV_CONTRACT_ID) {
      // No testnet contract yet: nothing is read and nothing from another network is shown.
      await page.goto('/');
      await expect(page.getByTestId('backend-notice')).toContainText('Testnet backend is being set up');
      await expect(page.locator('article.prow')).toHaveCount(0);
      await page.getByTestId('backend-notice').getByRole('button', { name: 'Switch to Dev' }).click();
      await expect(label).toContainText('Dev: mainnet data on testnet Platform');
      await expect(page.getByTestId('backend-notice')).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });

  test('an override is marked custom; "Use the profile\'s settings" removes it', async ({ page, context }) => {
    await offline(context);
    await page.goto('/settings?fixtures=1');
    await page.getByText('Advanced: choose your own servers').click();
    await page.getByLabel('Price feed URL (JSON with dash.usd; empty turns it off)').fill('https://price.example.org/dash');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByTestId('profile-label').locator('.chip-custom')).toBeVisible();
    await expect(page.locator('fieldset', { hasText: 'Relays and price feed' }).locator('.chip-custom')).toBeVisible();
    await page.getByRole('button', { name: "Use the profile's settings" }).click();
    await expect(page.getByTestId('profile-label').locator('.chip-custom')).toHaveCount(0);
  });

  test('version 1 settings that switched Core to testnet migrate to the Testnet profile', async ({ page, context }) => {
    await offline(context);
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(
        'govhub.registry.v1',
        JSON.stringify({
          version: 1,
          coreNetwork: 'testnet',
          platformNetwork: 'testnet',
          dapi: { source: 'quorum', quorumUrl: 'https://quorums.testnet.networks.dash.org/masternodes', nodes: [] },
          platform: { trusted: true, addresses: [] },
          govContractId: '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ',
          bridges: [{ name: 'gov-bridge.dashhq.org', httpBase: 'https://gov-bridge.dashhq.org', govContractId: '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ', bridgeIdentityId: '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv', enabled: true }],
          relays: [],
          priceFeed: null,
        }),
      );
    });
    await page.goto('/?fixtures=0');
    await expect(page.getByTestId('profile-label')).toContainText('Testnet');
    const keys = await page.evaluate(() => ({ v1: localStorage.getItem('govhub.registry.v1'), v2: JSON.parse(localStorage.getItem('govhub.registry.v2') ?? 'null') }));
    expect(keys.v1).toBeNull();
    expect(keys.v2).toMatchObject({ version: 2, profile: 'testnet' });
    expect(keys.v2.overrides.govContractId).toBeUndefined();
    // Never the Dev contract's mainnet proposals under testnet rules.
    expect(JSON.stringify(keys.v2)).not.toContain('gov-bridge.dashhq.org');
  });
});
