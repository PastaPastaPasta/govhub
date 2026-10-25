// End-to-end in fixture mode: the mainnet snapshot, recorded mainnet DAPI responses replayed
// through the real grpc-web client inside the verification worker, synthetic signed votes.
import { expect, test } from '@playwright/test';
import { cspViolations, gotoFixtures, openDrawer, openGroup, watchPage } from './helpers.ts';

test.describe('fixture mode', () => {
  test('list -> proposal -> collateral verified -> votes verified', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page);

    // Budget summary (DashCentral parity, in plain words).
    await expect(page.getByRole('heading', { name: /Next payout in 27 days/ })).toBeVisible();
    await expect(page.getByText('Masternodes can vote for another')).toBeVisible();
    await expect(page.locator('.budget-facts')).toContainText('To pass');
    await expect(page.locator('.budget-facts')).toContainText('332');

    // Cards sorted by rank; the best-ranked one is DCG operations (net yes 687).
    const cards = page.locator('article.prow');
    await expect(cards.first()).toContainText('DCG-Operations-Aug-Nov-26');
    await expect(cards.first()).toContainText('Passing by 355');
    await expect(cards.first()).toContainText('per month');
    const failing = page.locator('article.prow', { hasText: 'GEG-PPP-30M-Film-On-Chain' });

    // Infinite scroll: 12 first, the rest after scrolling.
    await expect(cards).toHaveCount(12);
    await page.locator('.sentinel').scrollIntoViewIfNeeded();
    await expect(cards).toHaveCount(28);
    await expect(failing).toContainText(/Needs 585 more yes/);

    // Open a proposal.
    await page.getByRole('link', { name: 'OrchardPay', exact: true }).click();
    await expect(page).toHaveURL(/\/p\/OrchardPay$/);
    await expect(page.getByRole('heading', { level: 1, name: 'OrchardPay' })).toBeVisible();
    await expect(page.getByTestId('p-votes')).toContainText('197 yes22 no9 abstain');
    await expect(page.getByTestId('p-voters')).toHaveText('228 masternodes voted; evonodes count 4 times');

    // Fixture data is "Demo data", never "Verified", whatever the checks find.
    const badge = page.getByTestId('trust-badge');
    await expect(badge).toHaveAttribute('data-trust', 'demo');
    // No provenance marks on the page itself any more.
    await expect(page.locator('[data-prov]')).toHaveCount(0);

    // Every check runs on its own; the detail is in the drawer.
    const drawer = await openDrawer(page);
    const collateral = drawer.getByTestId('collateral-check');
    await expect(collateral.locator('[data-verdict]')).toHaveAttribute('data-verdict', 'ok');
    await expect(collateral).toContainText('Content matches the on-chain collateral');
    for (const step of ['hash', 'fields', 'tx', 'collateral', 'confirmations', 'chainlock']) {
      await expect(collateral.locator(`[data-step="${step}"]`)).toHaveAttribute('data-status', 'ok');
    }
    await expect(collateral).toContainText('recorded.dapi.invalid');
    // The recorded replay carries node claims only: confirmations and ChainLock are "reported", not "verified".
    for (const step of ['confirmations', 'chainlock']) await expect(collateral.locator(`[data-step="${step}"]`)).toHaveAttribute('data-basis', 'reported');
    await expect(collateral.locator('[data-step="chainlock"]')).toContainText('a node reports');
    // ...so the collateral check is only "reported" in the aggregate, even though its verdict is ok.
    await expect(drawer.locator('[data-check="content"]')).toHaveAttribute('data-state', 'proven');
    await expect(drawer.locator('[data-check="collateral"]')).toHaveAttribute('data-state', 'reported');
    // Recorded data has no header chain: the chain facts say so instead of claiming anything.
    await expect(drawer.getByTestId('chain-check').locator('[data-chain]')).toHaveAttribute('data-chain', 'unavailable');
    await expect(drawer.locator('[data-check="chain"]')).toHaveAttribute('data-state', 'reported');
    await expect(collateral.locator('[data-step="block"]')).toHaveCount(0);
    await expect(collateral.locator('[data-step="hash"]')).toHaveAttribute('data-basis', 'verified');

    // The vote recount runs on its own, against the fixture bridge.
    const votes = drawer.getByTestId('votes-check');
    await expect(votes.locator('[data-votes]')).toHaveAttribute('data-votes', 'keys-reported', { timeout: 30_000 });
    await expect(votes).toContainText('Recount matches the Platform tally: 229 of 229 signatures check out');
    await expect(votes).toContainText('fixture bridge (synthetic voters)');
    await expect(votes.locator('table.compare td.bad')).toHaveCount(0);
    // Keys as the fixture bridge reports them: not proven.
    await expect(drawer.locator('[data-check="votes"]')).toHaveAttribute('data-state', 'reported');
    await expect(drawer.getByTestId('drawer-verdict')).toHaveAttribute('data-trust', 'demo');
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    expect(errors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('recount of recorded mainnet votes reproduces the tally and voteSetHash', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/p/dash-growth-q4-2026');
    await expect(page.getByRole('heading', { level: 1, name: 'dash-growth-q4-2026' })).toBeVisible();
    // Evonodes weigh 4: 298 yes masternodes are 673 weighted votes.
    await expect(page.getByTestId('p-votes')).toContainText('673 yes');
    await expect(page.getByTestId('p-votes')).toContainText('475 no');
    await expect(page.getByTestId('p-voters')).toHaveAttribute('title', /^298 yes, 160 no, 2 abstain; counted at block /);
    const drawer = await openDrawer(page);
    await expect(drawer.getByTestId('collateral-check').locator('[data-verdict]')).toHaveAttribute('data-verdict', 'ok');

    const votes = drawer.getByTestId('votes-check');
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
    // A bridge match on bridge-supplied keys is not "verified".
    await expect(drawer.locator('[data-check="votes"]')).toHaveAttribute('data-state', 'reported');
    await expect(drawer.locator('[data-check="votes"]')).toContainText("the voters' keys are as the bridge lists them");
    expect(errors).toEqual([]);
  });

  test('the badge opens "How do we know?"; Escape closes it and focus returns to the badge', async ({ page }) => {
    await gotoFixtures(page, '/p/OrchardPay');
    const badge = page.getByTestId('trust-badge');
    await expect(badge).toHaveAccessibleName(/^Demo data: .*How do we know\?$/);
    const drawer = await openDrawer(page);
    await expect(drawer.getByRole('heading', { name: 'How do we know?' })).toBeVisible();
    await expect(drawer.getByTestId('checks').locator('[data-check]')).toHaveCount(5);
    await expect(drawer).toContainText("votes the bridge didn't serve can't be detected");
    await drawer.getByText('Proposal data and hashes').click();
    await expect(drawer.getByTestId('raw-data')).toContainText('"name": "OrchardPay"');
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(badge).toBeFocused();
  });

  test('offline signing is there without a keyring; the drawer can rank every active proposal on request', async ({ page }) => {
    await gotoFixtures(page, '/p/OrchardPay');
    await expect(page.getByText('Sign offline instead (Dash Core, hardware wallet)')).toBeVisible();
    const drawer = await openDrawer(page);
    // fixture data: the votes are not proven, so the funding order did not run on its own
    await drawer.locator('[data-check="funding"] .check-more > summary').click();
    await expect(drawer.getByTestId('rank-now')).toBeVisible();
  });

  test('About verification explains every state', async ({ page }) => {
    await gotoFixtures(page, '/about/verification');
    await expect(page.getByRole('heading', { level: 1, name: 'How govhub checks what it shows' })).toBeVisible();
    for (const s of ['Verified', 'Checking…', 'Partly verified', "Couldn't verify", 'Failed verification', 'Demo data']) await expect(page.locator('.about-states')).toContainText(s);
  });

  test('duplicate names get a chooser; /p/h/<hash> is canonical', async ({ page }) => {
    await gotoFixtures(page, '/p/Dash-Mass-Organic-Content-Attraction');
    await expect(page.getByRole('heading', { name: '2 proposals are named Dash-Mass-Organic-Content-Attraction' })).toBeVisible();
    const links = page.locator('.chooser a');
    await expect(links).toHaveCount(2);
    await links.first().click();
    await expect(page).toHaveURL(/\/p\/h\/[0-9a-f]{64}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Dash-Mass-Organic-Content-Attraction' })).toBeVisible();
    const drawer = await openDrawer(page);
    await expect(drawer.getByTestId('collateral-check').locator('[data-verdict]')).toHaveAttribute('data-verdict', 'ok');
  });

  test('cards of duplicate names link to the hash route', async ({ page }) => {
    await gotoFixtures(page);
    await page.locator('.sentinel').scrollIntoViewIfNeeded();
    const dupLinks = page.locator('article.prow h3 a', { hasText: 'Dash-Mass-Organic-Content-Attraction' });
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
    await openGroup(page, 'Export, import and share');
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
    await expect(page.getByLabel('URL', { exact: true })).toHaveValue('https://gov-bridge.dashhq.org');
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
    await page.getByTestId('menu-button').click();
    await page.locator('#account-menu').getByText('Dark', { exact: true }).click();
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
