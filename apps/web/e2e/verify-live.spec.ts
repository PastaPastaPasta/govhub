// Opt-in live test (GOVHUB_LIVE=1 npx playwright test e2e/verify-live.spec.ts): on the Dev profile (mainnet Core data), a proposal
// whose collateral is ~45,000 blocks deep must come out with its chain facts VERIFIED in this browser: collateral height,
// confirmations, ChainLock, funding threshold and completed payments. Records cold and warm timings to verify-live-results.json.
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { cspViolations, openDrawer, watchPage } from './helpers.ts';

test.skip(!process.env.GOVHUB_LIVE, 'set GOVHUB_LIVE=1 to run against live Platform and mainnet DAPI');

const DCG = '91808ffd72336fd89bcf5f0b3377b3c73a9b5873da8ac9419b59ba8c92e56640'; // DCG-Operations-Aug-Nov-26: collateral at 2,515,836, paid in superblocks
const GROWTH = 'd784b13a4fa55e8e1e5f6a0271db412fda5f4407221349fd1a6d1498dfad6a96'; // dash-growth-q4-2026: collateral at 2,531,660

/** Opens a proposal and waits for the collateral check and the chain facts; returns how long each took (ms from navigation). */
async function openAndVerify(page: Page, govHash: string) {
  const t0 = Date.now();
  await page.goto(`/p/h/${govHash}?fixtures=0`);
  const drawer = await openDrawer(page);
  // progress lines, for the log: what the worker is doing while we wait
  const seen = new Set<string>();
  const poll = setInterval(() => {
    void drawer.locator('.check-pending .check-text').allTextContents().then((ts) => {
      for (const t of ts) if (!seen.has(t)) { seen.add(t); console.log(`live: +${((Date.now() - t0) / 1000).toFixed(1)} s ${t.trim()}`); }
    }, () => {});
  }, 500);
  const collateral = drawer.getByTestId('collateral-check');
  await expect(collateral.locator('[data-verdict]')).toBeAttached({ timeout: 240_000 });
  const tCollateral = Date.now() - t0;
  const chain = drawer.getByTestId('chain-check');
  await expect(chain.locator('[data-chain]')).toBeAttached({ timeout: 240_000 });
  const tChain = Date.now() - t0;
  clearInterval(poll);
  const state = await chain.locator('[data-chain]').getAttribute('data-chain');
  console.log(`live: ${govHash.slice(0, 8)} collateral: ${((await collateral.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 900)}`);
  console.log(`live: ${govHash.slice(0, 8)} chain (${state}): ${((await chain.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 1200)}`);
  return { tCollateral, tChain, state, collateral, chain, drawer };
}

test('@live a deep collateral: height, confirmations, ChainLock, threshold and completed payments are verified', async ({ page }) => {
  test.setTimeout(600_000);
  const errors = await watchPage(page);

  // ---- cold: empty IndexedDB, ~45,000 headers to download, every older masternode registration to prove
  const cold = await openAndVerify(page, DCG);
  await expect(page.getByRole('heading', { level: 1, name: 'DCG-Operations-Aug-Nov-26' })).toBeVisible();
  await expect(cold.collateral.locator('[data-verdict]')).toHaveAttribute('data-verdict', 'ok');
  for (const id of ['block', 'height', 'confirmations', 'chainlock']) {
    const step = cold.collateral.locator(`[data-step="${id}"]`);
    await expect(step, id).toHaveAttribute('data-status', 'ok');
    await expect(step, id).toHaveAttribute('data-basis', 'verified');
  }
  await expect(cold.collateral.locator('[data-step="crosscheck"]')).toHaveCount(0); // the second-node step is gone once anchored
  await expect(cold.collateral).not.toContainText('maxHeaderSpan');
  expect(cold.state).toBe('verified');
  for (const id of ['chain', 'chainlock', 'mnlist', 'threshold', 'schedule', 'budget', 'payments']) {
    const step = cold.chain.locator(`[data-step="${id}"]`);
    await expect(step, id).toHaveAttribute('data-status', 'ok');
    await expect(step, id).toHaveAttribute('data-basis', 'verified');
  }
  await expect(cold.chain.locator('[data-step="threshold"]')).toContainText(/^\s*.*\d+ net yes votes/);
  await expect(cold.chain.locator('[data-step="payments"]')).toContainText(/superblocks? [\d,]+/); // at least one payment found
  // the aggregate takes the collateral and the chain as proven
  for (const id of ['content', 'collateral', 'chain']) await expect(cold.drawer.locator(`[data-check="${id}"]`), id).toHaveAttribute('data-state', 'proven');
  const coldMs = JSON.parse((await cold.chain.locator('[data-chain]').getAttribute('data-ms')) ?? '{}');
  const coldHeaders = JSON.parse((await cold.chain.locator('[data-chain]').getAttribute('data-headers')) ?? '{}');
  if (process.env.SCREENSHOTS) await page.screenshot({ path: 'screenshots/live-verified-proposal-light-desktop.png', fullPage: true });

  // ---- warm: another proposal in the same browser: the header run and the registrations come from IndexedDB
  await page.goto('about:blank');
  const warm = await openAndVerify(page, GROWTH);
  expect(warm.state).toBe('verified');
  for (const id of ['height', 'confirmations', 'chainlock']) await expect(warm.collateral.locator(`[data-step="${id}"]`)).toHaveAttribute('data-basis', 'verified');
  await expect(warm.chain.locator('[data-step="threshold"]')).toHaveAttribute('data-basis', 'verified');
  const warmMs = JSON.parse((await warm.chain.locator('[data-chain]').getAttribute('data-ms')) ?? '{}');
  const warmHeaders = JSON.parse((await warm.chain.locator('[data-chain]').getAttribute('data-headers')) ?? '{}');

  const results = {
    ranAt: new Date().toISOString(),
    cold: { proposal: 'DCG-Operations-Aug-Nov-26', collateralCheckMs: cold.tCollateral, chainFactsMs: cold.tChain, anchor: coldMs, headers: coldHeaders },
    warm: { proposal: 'dash-growth-q4-2026', collateralCheckMs: warm.tCollateral, chainFactsMs: warm.tChain, anchor: warmMs, headers: warmHeaders },
  };
  console.log(`live: timings ${JSON.stringify(results)}`);
  writeFileSync(new URL('./verify-live-results.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
  expect(warmHeaders.cached).toBeGreaterThan(40_000);
  expect(errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});

test('@live vote recount and funding order rest on the proven list and registrations', async ({ page }) => {
  test.setTimeout(900_000);
  const errors = await watchPage(page);
  await page.goto(`/p/h/${DCG}?fixtures=0`);
  const drawer = await openDrawer(page);
  // the recount and the funding order run on their own (DCG is passing, so its funding status needs the order)
  let t0 = Date.now();
  const votes = drawer.getByTestId('votes-check');
  await expect(votes.locator('[data-votes]')).toBeAttached({ timeout: 400_000 });
  const tVotes = Date.now() - t0;
  console.log(`live: votes (${tVotes} ms): ${((await votes.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 900)}`);
  await expect(votes).toContainText('masternode list proven by block');

  t0 = Date.now();
  const ranking = drawer.getByTestId('ranking-check');
  await expect(ranking.locator('[data-ranking]')).toBeAttached({ timeout: 800_000 });
  const tRanking = Date.now() - t0;
  const level = await ranking.locator('[data-ranking]').getAttribute('data-ranking');
  console.log(`live: funding order ${level} (${tRanking} ms): ${((await ranking.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 1500)}`);
  const funded = drawer.locator('[data-check="funding"]');
  console.log(`live: funding: ${((await funded.textContent()) ?? '').replace(/\s+/g, ' ')}`);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: 'screenshots/live-funding-order-light-desktop.png' });
  await expect(votes.locator('[data-votes]')).toHaveAttribute('data-votes', /verified|different-height/);
  expect(level).toBe('verified');
  await expect(funded).toHaveAttribute('data-state', 'proven');
  expect(errors).toEqual([]);
});

// Testnet: proof of work protects nothing there, so chain facts are only verified when they rest on ChainLocks proven from the pinned
// quorum checkpoint (DIP 175 proofs from the testnet bridge or the public quorum list server). Records cold and warm timings.
test('@live testnet: chain facts rest on quorum-proven ChainLocks and are verified, funding order included', async ({ page }) => {
  test.setTimeout(900_000);
  const props = (await (await fetch('https://gov-bridge-testnet.dashhq.org/v1/proposals')).json()) as { proposals: Array<{ govHash: string; collateralHeight?: number | null }> };
  const [first, second] = props.proposals.filter((p) => p.collateralHeight);
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem('govhub.registry.v2')) localStorage.setItem('govhub.registry.v2', JSON.stringify({ version: 2, profile: 'testnet', overrides: {} }));
    } catch { /* about:blank has no storage */ }
  });
  const errors = await watchPage(page);

  const check = async (r: Awaited<ReturnType<typeof openAndVerify>>) => {
    expect(r.state).toBe('verified');
    await expect(r.chain).not.toContainText('not secure');
    await expect(r.collateral).not.toContainText('not secure');
    for (const id of ['height', 'confirmations', 'chainlock']) {
      await expect(r.collateral.locator(`[data-step="${id}"]`), id).toHaveAttribute('data-status', 'ok');
      await expect(r.collateral.locator(`[data-step="${id}"]`), id).toHaveAttribute('data-basis', 'verified');
    }
    for (const id of ['trust', 'chain', 'chainlock', 'mnlist', 'threshold', 'schedule', 'budget']) {
      await expect(r.chain.locator(`[data-step="${id}"]`), id).toHaveAttribute('data-status', 'ok');
      await expect(r.chain.locator(`[data-step="${id}"]`), id).toHaveAttribute('data-basis', 'verified');
    }
    await expect(r.chain.locator('[data-step="trust"]')).toContainText('the ChainLock quorums of the pinned checkpoint at block 1,560,000, plus BLS');
    return {
      drawerFunding: r.drawer.locator('[data-check="funding"]'),
      collateralCheckMs: r.tCollateral, chainFactsMs: r.tChain,
      anchor: JSON.parse((await r.chain.locator('[data-chain]').getAttribute('data-ms')) ?? '{}'),
      headers: JSON.parse((await r.chain.locator('[data-chain]').getAttribute('data-headers')) ?? '{}'),
      trust: ((await r.chain.locator('[data-step="trust"]').textContent()) ?? '').replace(/\s+/g, ' '),
    };
  };

  // ---- cold: empty IndexedDB, a proof from the pinned checkpoint (~30 KB, ~40 ChainLock quorum handoffs)
  const cold = await check(await openAndVerify(page, first!.govHash));
  await expect(page.getByTestId('profile-label')).toContainText('Testnet');
  if (process.env.SCREENSHOTS) await page.screenshot({ path: 'screenshots/live-testnet-quorum-proof-light-desktop.png', fullPage: true });

  // ---- warm: another proposal in the same browser; the next proof starts from the state this browser proved
  await page.goto('about:blank');
  const warm = await check(await openAndVerify(page, (second ?? first)!.govHash));

  // ---- funding order: every listed proposal recounted against the proven list
  // the funding order runs on its own only for a passing proposal; the badge (trust-live.spec.ts) covers the rest
  const t0 = Date.now();
  const funding = warm.drawerFunding;
  await expect(funding).not.toHaveAttribute('data-state', 'pending', { timeout: 800_000 });
  const tRanking = Date.now() - t0;
  console.log(`live: testnet funding: ${((await funding.textContent()) ?? '').replace(/\s+/g, ' ')}`);
  await expect(funding).not.toContainText('not secure');

  const { drawerFunding: _c, ...coldOut } = cold;
  const { drawerFunding: _w, ...warmOut } = warm;
  const results = { ranAt: new Date().toISOString(), network: 'testnet', cold: coldOut, warm: warmOut, fundingOrderMs: tRanking };
  console.log(`live: testnet timings ${JSON.stringify(results)}`);
  writeFileSync(new URL('./verify-live-testnet-results.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
  expect(errors).toEqual([]);
});
