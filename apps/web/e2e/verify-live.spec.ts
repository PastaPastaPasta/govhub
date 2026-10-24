// Opt-in live test (GOVHUB_LIVE=1 npx playwright test e2e/verify-live.spec.ts): on the Dev profile (mainnet Core data), a proposal
// whose collateral is ~45,000 blocks deep must come out with its chain facts VERIFIED in this browser: collateral height,
// confirmations, ChainLock, funding threshold and completed payments. Records cold and warm timings to verify-live-results.json.
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { cspViolations, watchPage } from './helpers.ts';

test.skip(!process.env.GOVHUB_LIVE, 'set GOVHUB_LIVE=1 to run against live Platform and mainnet DAPI');

const DCG = '91808ffd72336fd89bcf5f0b3377b3c73a9b5873da8ac9419b59ba8c92e56640'; // DCG-Operations-Aug-Nov-26: collateral at 2,515,836, paid in superblocks
const GROWTH = 'd784b13a4fa55e8e1e5f6a0271db412fda5f4407221349fd1a6d1498dfad6a96'; // dash-growth-q4-2026: collateral at 2,531,660

/** Opens a proposal and waits for the collateral check and the chain facts; returns how long each took (ms from navigation). */
async function openAndVerify(page: Page, govHash: string) {
  const t0 = Date.now();
  await page.goto(`/p/h/${govHash}?fixtures=0`);
  // progress lines, for the log: what the worker is doing while we wait
  const seen = new Set<string>();
  const poll = setInterval(() => {
    void page.locator('.verdict-pending').allInnerTexts().then((ts) => {
      for (const t of ts) if (!seen.has(t)) { seen.add(t); console.log(`live: +${((Date.now() - t0) / 1000).toFixed(1)} s ${t.trim()}`); }
    }, () => {});
  }, 500);
  const collateral = page.getByTestId('collateral-check');
  await expect(collateral.locator('[data-verdict]')).toBeVisible({ timeout: 240_000 });
  const tCollateral = Date.now() - t0;
  const chain = page.getByTestId('chain-check');
  await expect(chain.locator('[data-chain]')).toBeVisible({ timeout: 240_000 });
  const tChain = Date.now() - t0;
  clearInterval(poll);
  const state = await chain.locator('[data-chain]').getAttribute('data-chain');
  console.log(`live: ${govHash.slice(0, 8)} collateral: ${(await collateral.innerText()).replace(/\s+/g, ' ').slice(0, 900)}`);
  console.log(`live: ${govHash.slice(0, 8)} chain (${state}): ${(await chain.innerText()).replace(/\s+/g, ' ').slice(0, 1200)}`);
  return { tCollateral, tChain, state, collateral, chain };
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
  // the details table carries the same marks
  const row = (label: string) => page.locator('.info-row', { has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) });
  for (const label of ['Collateral', 'Collateral status', 'Voting deadline', 'Payments made']) await expect(row(label).locator('[data-prov="verified"]'), label).toBeVisible();
  await expect(row('Payments remaining').locator('[data-prov="reported"]')).toBeVisible(); // the future stays an estimate
  await expect(row('Voting deadline')).toContainText('(estimated)');
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
