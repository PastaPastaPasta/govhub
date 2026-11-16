// Search, filter and sort on the Active list (fixture mode): the state lives in the URL, so a view can be shared and Back undoes it.
import { expect, test, type Page } from '@playwright/test';
import { gotoFixtures, watchPage } from './helpers.ts';

const cards = (page: Page) => page.locator('.plist').first().locator('article.prow');
const titles = (page: Page) => cards(page).locator('.prow-title a').allTextContents();

test.describe('active list: search, filter, sort', () => {
  test('search narrows the list, is in the URL, and Back steps out of it', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page);
    await expect(cards(page)).toHaveCount(12);
    const search = page.getByRole('searchbox', { name: 'Search active proposals' });
    await search.fill('orchard');
    await expect(page).toHaveURL(/[?&]q=orchard/);
    expect(await titles(page)).toEqual(['OrchardPay']);
    await expect(page.getByTestId('list-count')).toContainText(/^1 of 21 proposals/);

    // separators and case don't matter
    await search.fill('dcg operations');
    await expect(cards(page).first()).toContainText('DCG-Operations-Aug-Nov-26');

    // a filter pushes a history entry; Back returns to the search alone
    await page.getByTestId('chips-status').getByText('Not passing').click();
    await expect(page).toHaveURL(/status=failing/);
    await expect(page.getByTestId('list-no-matches')).toBeVisible();
    await expect(page.getByTestId('list-no-matches')).toContainText('No proposals match “dcg operations”');
    await page.goBack();
    await expect(page).not.toHaveURL(/status=/);
    await expect(cards(page).first()).toContainText('DCG-Operations-Aug-Nov-26');

    // Escape clears the search
    await search.focus();
    await page.keyboard.press('Escape');
    await expect(search).toHaveValue('');
    await expect(page).not.toHaveURL(/q=/);
    expect(errors).toEqual([]);
  });

  test('status chips: counts add up, the keyboard moves between them, a shared link opens the same view', async ({ page }) => {
    await gotoFixtures(page);
    const chips = page.getByTestId('chips-status');
    const count = async (name: RegExp) => Number((await chips.locator('label', { hasText: name }).locator('.count').textContent()) ?? NaN);
    await expect(chips.locator('label', { hasText: /^All/ }).locator('.count')).toHaveText('21');
    const passing = await count(/^Passing/);
    const failing = await count(/^Not passing/);
    expect(passing + failing).toBe(21);

    await chips.getByRole('radio', { name: /^All/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(chips.getByRole('radio', { name: /^Passing/ })).toBeChecked();
    await expect(page).toHaveURL(/status=passing/);
    await page.locator('.sentinel').scrollIntoViewIfNeeded();
    await expect(cards(page)).toHaveCount(passing);
    for (const t of await cards(page).allTextContents()) expect(t).toMatch(/Passing by/);
    // finished proposals are neither: their section goes while a status filter is on
    await expect(page.getByTestId('lameduck-section')).toHaveCount(0);

    await gotoFixtures(page, '/?status=failing');
    await expect(chips.getByRole('radio', { name: /^Not passing/ })).toBeChecked();
    await page.locator('.sentinel').scrollIntoViewIfNeeded();
    await expect(cards(page)).toHaveCount(failing);
    await expect(cards(page).filter({ hasText: 'GEG-PPP-30M-Film-On-Chain' })).toHaveCount(1);
  });

  test('sort: largest amount first, and the note under the tabs says so', async ({ page }) => {
    await gotoFixtures(page);
    await page.getByTestId('list-sort').selectOption({ label: 'Largest amount' });
    await expect(page).toHaveURL(/sort=amount/);
    await expect(page.getByText('Largest payment requested first.')).toBeVisible();
    const amounts = (await cards(page).locator('.prow-ask .num').allTextContents()).map((t) => Number(t.replace(/[^0-9.]/g, '')));
    expect(amounts.length).toBeGreaterThan(2);
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    await page.goBack();
    await expect(page.getByText('Best-supported first: the order the treasury pays them in.')).toBeVisible();
    await expect(cards(page).first()).toContainText('DCG-Operations-Aug-Nov-26');
  });

  test('"Not voted yet" appears only for a signed-in masternode owner', async ({ page }) => {
    await gotoFixtures(page);
    await expect(page.getByTestId('chips-status')).toBeVisible();
    await expect(page.getByTestId('filter-unvoted')).toHaveCount(0);
    await page.getByTestId('session-button').click();
    await page.getByRole('button', { name: /^Alice$/ }).click();
    await expect(page.getByTestId('session-button')).not.toHaveText('Sign in');
    const unvoted = page.getByRole('checkbox', { name: 'Not voted yet' });
    await expect(unvoted).toBeAttached({ timeout: 15_000 });
    await page.locator('label.list-chip', { hasText: 'Not voted yet' }).click();
    await expect(unvoted).toBeChecked();
    await expect(page).toHaveURL(/unvoted=1/);
    await expect(page.getByTestId('list-count')).toBeVisible();
    await expect(cards(page).first()).toBeVisible();
  });

  test('phone width: the controls fit without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await gotoFixtures(page);
    await expect(page.getByRole('searchbox', { name: 'Search active proposals' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const box = await page.getByRole('searchbox', { name: 'Search active proposals' }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
