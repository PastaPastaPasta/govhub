// End-to-end in fixture mode: the mainnet snapshot, recorded mainnet DAPI responses replayed
// through the real grpc-web client inside the verification worker, synthetic signed votes.
import { expect, test } from '@playwright/test';
import { cspViolations, gotoFixtures, watchPage } from './helpers.ts';

test.describe('fixture mode', () => {
  test('list -> proposal -> collateral verified -> votes verified', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page);

    // Budget header (DashCentral parity).
    await expect(page.getByRole('heading', { name: /Superblock 2,575,480 pays in/ })).toBeVisible();
    await expect(page.getByText('Voting closes in')).toBeVisible();
    await expect(page.getByText('Passing threshold')).toBeVisible();
    await expect(page.locator('.budget-facts')).toContainText('332');

    // Cards sorted by rank; the best-ranked one is DCG operations (net yes 687).
    const cards = page.locator('article.card');
    await expect(cards.first()).toContainText('DCG-Operations-Aug-Nov-26');
    await expect(cards.first()).toContainText('Passing +355');
    await expect(cards.first()).toContainText('per month');
    const failing = page.locator('article.card', { hasText: 'GEG-PPP-30M-Film-On-Chain' });

    // Infinite scroll: 12 first, the rest after scrolling.
    await expect(cards).toHaveCount(12);
    await page.locator('.sentinel').scrollIntoViewIfNeeded();
    await expect(cards).toHaveCount(28);
    await expect(failing).toContainText(/Needs 585 more yes/);

    // Open a proposal.
    await page.getByRole('link', { name: 'OrchardPay', exact: true }).click();
    await expect(page).toHaveURL(/\/p\/OrchardPay$/);
    await expect(page.getByRole('heading', { level: 1, name: 'OrchardPay' })).toBeVisible();
    await expect(page.locator('.info-table')).toContainText('197 yes, 22 no, 9 abstain');

    // Collateral check in the worker over the recorded DAPI answer.
    const collateral = page.getByTestId('collateral-check');
    await expect(collateral.locator('[data-verdict]')).toHaveAttribute('data-verdict', 'ok');
    await expect(collateral).toContainText('Content matches the on-chain collateral');
    for (const step of ['hash', 'fields', 'tx', 'collateral', 'confirmations', 'chainlock']) {
      await expect(collateral.locator(`[data-step="${step}"]`)).toHaveAttribute('data-status', 'ok');
    }
    await expect(collateral).toContainText('recorded.dapi.invalid');
    // The recorded replay carries node claims only: confirmations and ChainLock are "reported", not "verified".
    for (const step of ['confirmations', 'chainlock']) await expect(collateral.locator(`[data-step="${step}"]`)).toHaveAttribute('data-basis', 'reported');
    await expect(collateral.locator('[data-step="chainlock"]')).toContainText('node-reported');
    await expect(collateral.locator('[data-step="block"]')).toHaveCount(0);
    await expect(collateral.locator('[data-step="hash"]')).toHaveAttribute('data-basis', 'verified');
    const status = page.locator('.info-row', { hasText: 'Collateral status' });
    await expect(status).toContainText('ChainLocked as a node reports');
    await expect(status.locator('[data-prov="reported"]')).toBeVisible();
    // Content values now carry the verified mark.
    await expect(page.locator('.info-table [data-prov="verified"]').first()).toBeVisible();

    // Vote verification against the fixture bridge.
    await page.getByRole('button', { name: 'Verify votes' }).click();
    const votes = page.getByTestId('votes-check');
    await expect(votes.locator('[data-votes]')).toHaveAttribute('data-votes', 'keys-reported', { timeout: 30_000 });
    await expect(votes).toContainText('Recount matches the Platform tally: 229 of 229 signatures check out');
    await expect(votes).toContainText('fixture bridge (synthetic voters)');
    await expect(votes.locator('table.compare td.bad')).toHaveCount(0);

    expect(errors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('recount of recorded mainnet votes reproduces the tally and voteSetHash', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/p/dash-growth-q4-2026');
    await expect(page.getByRole('heading', { level: 1, name: 'dash-growth-q4-2026' })).toBeVisible();
    // Evonodes weigh 4: 298 yes masternodes are 673 weighted votes.
    await expect(page.locator('.info-table')).toContainText('673 yes, 475 no, 5 abstain');
    await expect(page.locator('.info-table')).toContainText('298 yes, 160 no, 2 abstain');
    await expect(page.getByTestId('collateral-check').locator('[data-verdict]')).toHaveAttribute('data-verdict', 'ok');

    await page.getByRole('button', { name: 'Verify votes' }).click();
    const votes = page.getByTestId('votes-check');
    await expect(votes.locator('[data-votes]')).toHaveAttribute('data-votes', 'keys-reported', { timeout: 30_000 });
    // 460 real signed votes by real masternodes: every signature recovers to the masternode's voting key.
    await expect(votes).toContainText('Recount matches the Platform tally: 460 of 460 signatures check out');
    await expect(votes).toContainText('recorded mainnet votes and masternodes');
    await expect(votes).toContainText('(as of block 2,560,441)');
    // Field by field, including the voteSetHash (34a829f3... in the bridge fixture), nothing differs.
    const table = votes.locator('table.compare');
    await expect(table.locator('tr', { hasText: 'Yes (weighted)' })).toContainText('673');
    await expect(table.locator('tr', { hasText: 'Yes (MNs)' })).toContainText('298');
    await expect(table.locator('tr', { hasText: 'voteSetHash' })).toContainText('34a829');
    await expect(table.locator('td.bad')).toHaveCount(0);
    await expect(table.locator('tr', { hasText: 'voteSetHash' }).locator('.visually-hidden').last()).toHaveText('matches');
    // A bridge match on bridge-supplied keys is not "verified": the recounted tally keeps its Platform-proof label.
    await expect(page.locator('.info-row', { hasText: 'Votes, weighted' }).locator('[data-prov]')).toHaveAttribute('data-prov', 'fixture');
    expect(errors).toEqual([]);
  });

  test('provenance popover explains the source', async ({ page }) => {
    await gotoFixtures(page);
    await page.locator('.budget-line .prov').click();
    const pop = page.locator('.prov-pop:popover-open');
    await expect(pop).toContainText('Fixture snapshot');
    await expect(pop).toContainText('mainnet snapshot');
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
  });

  test('duplicate names get a chooser; /p/h/<hash> is canonical', async ({ page }) => {
    await gotoFixtures(page, '/p/Dash-Mass-Organic-Content-Attraction');
    await expect(page.getByRole('heading', { name: '2 proposals are named Dash-Mass-Organic-Content-Attraction' })).toBeVisible();
    const links = page.locator('.chooser a');
    await expect(links).toHaveCount(2);
    await links.first().click();
    await expect(page).toHaveURL(/\/p\/h\/[0-9a-f]{64}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Dash-Mass-Organic-Content-Attraction' })).toBeVisible();
    await expect(page.getByTestId('collateral-check').locator('[data-verdict]')).toHaveAttribute('data-verdict', 'ok');
  });

  test('cards of duplicate names link to the hash route', async ({ page }) => {
    await gotoFixtures(page);
    await page.locator('.sentinel').scrollIntoViewIfNeeded();
    const dupLinks = page.locator('article.card h3 a', { hasText: 'Dash-Mass-Organic-Content-Attraction' });
    await expect(dupLinks).toHaveCount(2);
    for (const href of await dupLinks.evaluateAll((as) => as.map((a) => a.getAttribute('href')))) expect(href).toMatch(/^\/p\/h\/[0-9a-f]{64}$/);
  });

  test('past proposals: empty state at the snapshot time', async ({ page }) => {
    await gotoFixtures(page, '/past');
    await expect(page.getByRole('heading', { name: 'Past proposals' })).toBeVisible();
    await expect(page.getByText('No past proposals published yet.')).toBeVisible();
  });

  test('unknown proposal hash shows not found', async ({ page }) => {
    await gotoFixtures(page, `/p/h/${'ab'.repeat(32)}`);
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  });
});

test.describe('settings', () => {
  test('export, import, validation, reset', async ({ page }) => {
    await gotoFixtures(page, '/settings');
    await page.getByRole('button', { name: 'Show JSON' }).click();
    const ta = page.getByLabel('Settings JSON (paste and import, or copy)');
    const json = JSON.parse(await ta.inputValue());
    expect(json.coreNetwork).toBe('mainnet');
    expect(json.platformNetwork).toBe('testnet');

    json.bridges = [{ name: 'test bridge', httpBase: 'https://bridge.example.org', govContractId: json.govContractId, bridgeIdentityId: '', enabled: true }];
    await ta.fill(JSON.stringify(json));
    await page.getByRole('button', { name: 'Import this JSON' }).click();
    await expect(page.getByText('Imported and saved.')).toBeVisible();
    await expect(page.getByLabel('URL', { exact: true })).toHaveValue('https://bridge.example.org');

    // Persisted across reloads.
    await page.reload();
    await expect(page.getByLabel('URL', { exact: true })).toHaveValue('https://bridge.example.org');

    // Insecure bridge URL is refused.
    await page.getByLabel('URL', { exact: true }).fill('http://bridge.example.org');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('alert')).toContainText('must be an https URL');

    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    await expect(page.getByText('No bridge configured.')).toBeVisible();
  });

  test('?config= share link asks before applying', async ({ page }) => {
    await gotoFixtures(page, '/settings');
    const cfg = { version: 1, coreNetwork: 'mainnet', platformNetwork: 'testnet', dapi: { source: 'manual', quorumUrl: 'https://quorums.mainnet.networks.dash.org/masternodes', nodes: ['1.2.3.4:443'] }, platform: { trusted: true, addresses: [] }, govContractId: '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ', bridges: [], relays: [], priceFeed: null };
    const b64 = Buffer.from(JSON.stringify(cfg)).toString('base64url');
    await page.goto(`/settings?config=${b64}`);
    const offer = page.getByRole('alertdialog');
    await expect(offer).toContainText('1.2.3.4:443');
    await expect(offer).toContainText('3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ');
    await offer.getByRole('button', { name: 'Use these settings' }).click();
    await expect(offer).toHaveCount(0);
    await expect(page.getByLabel('Nodes (host:port, one per line)')).toHaveValue('1.2.3.4:443');
    await expect(page).not.toHaveURL(/config=/);
  });

  test('theme switch sets data-theme and persists', async ({ page }) => {
    await gotoFixtures(page);
    await page.getByText('Dark', { exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test('built page ships the strict CSP', async ({ page }) => {
  await page.goto('/?fixtures=1');
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).toContain("connect-src 'self' https:");
  expect(csp).not.toContain('unsafe-inline');
});
