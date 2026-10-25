// Opt-in live test (GOVHUB_LIVE=1 npx playwright test --grep "@live trust"): on Dev (mainnet Core data) and on Testnet, a proposal
// page runs every check by itself and its one badge settles on "Verified", or on "Partly verified" with the reason of the first
// check that is not proven. Never "Couldn't verify" or "Failed verification" for a real proposal. Records timings to
// trust-live-results.json; with SCREENSHOTS=1 also screenshots and a video of the badge settling.
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { cspViolations, watchPage } from './helpers.ts';

test.skip(!process.env.GOVHUB_LIVE, 'set GOVHUB_LIVE=1 to run against live Platform and DAPI');
if (process.env.SCREENSHOTS) test.use({ video: { mode: 'on', size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 } });

const DCG = '91808ffd72336fd89bcf5f0b3377b3c73a9b5873da8ac9419b59ba8c92e56640'; // DCG-Operations-Aug-Nov-26: passing, so the funding order runs too
const results: Record<string, unknown> = {};

async function settle(page: Page, govHash: string) {
  const t0 = Date.now();
  await page.goto(`/p/h/${govHash}?fixtures=0`);
  const badge = page.getByTestId('trust-badge');
  await expect(badge).toBeVisible({ timeout: 120_000 });
  const steps: Array<[number, string]> = [];
  let last = '';
  for (;;) {
    const name = (await badge.getAttribute('aria-label')) ?? '';
    if (name !== last) steps.push([Date.now() - t0, (last = name)]);
    if ((await badge.getAttribute('data-trust')) !== 'checking') break;
    if (Date.now() - t0 > 600_000) throw new Error(`still checking after 10 minutes: ${name}`);
    await page.waitForTimeout(500);
  }
  const level = (await badge.getAttribute('data-trust'))!;
  for (const [ms, s] of steps) console.log(`live: +${(ms / 1000).toFixed(1)} s ${s}`);
  await badge.click();
  const drawer = page.getByTestId('verify-drawer');
  await expect(drawer).toBeVisible();
  const states = Object.fromEntries(
    await Promise.all(['content', 'collateral', 'chain', 'votes', 'funding'].map(async (id) => [id, await drawer.locator(`[data-check="${id}"]`).getAttribute('data-state')] as const)),
  );
  const reason = level === 'verified' ? null : ((await drawer.getByTestId('drawer-verdict').locator('.drawer-verdict-line').textContent()) ?? '').trim();
  return { level, reason, states, drawer, ms: Date.now() - t0 };
}

/** Verified: all five proven. Partly verified: none failed or unfinished, and the headline is the first unproven check's reason. */
async function expectSettled(r: Awaited<ReturnType<typeof settle>>) {
  expect(['verified', 'partial']).toContain(r.level);
  if (r.level === 'verified') {
    expect(Object.values(r.states).every((s) => s === 'proven'), JSON.stringify(r.states)).toBe(true);
    return;
  }
  expect(Object.values(r.states)).not.toContain('failed');
  expect(Object.values(r.states)).not.toContain('pending');
  const first = Object.entries(r.states).find(([, s]) => s === 'reported')!;
  const line = ((await r.drawer.locator(`[data-check="${first[0]}"] .check-text`).textContent()) ?? '').trim();
  expect(r.reason).toBe(line);
  console.log(`live: partly verified because ${first[0]}: ${line}`);
}

test('@live trust badge on Dev settles on Verified or Partly verified with its reason', async ({ page }) => {
  test.setTimeout(900_000);
  const errors = await watchPage(page);
  const r = await settle(page, DCG);
  console.log(`live: Dev ${r.level} in ${r.ms} ms ${JSON.stringify(r.states)}${r.reason ? `: ${r.reason}` : ''}`);
  await expectSettled(r);
  results.dev = { proposal: 'DCG-Operations-Aug-Nov-26', level: r.level, reason: r.reason, states: r.states, settleMs: r.ms };
  if (process.env.SCREENSHOTS) await page.screenshot({ path: 'screenshots/after/live-dev-drawer-light-desktop.png' });
  // the header's chain status agrees
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('profile-label')).toHaveAttribute('data-trust', /verified|partial/, { timeout: 240_000 });
  if (process.env.SCREENSHOTS) await page.screenshot({ path: 'screenshots/after/live-dev-proposal-light-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
  const video = page.video();
  await page.close();
  if (video && process.env.SCREENSHOTS) await video.saveAs('screenshots/after/live-dev-verify.webm');
});

test('@live trust badge on Testnet settles on Verified or Partly verified with its reason', async ({ page }) => {
  test.setTimeout(900_000);
  const props = (await (await fetch('https://gov-bridge-testnet.dashhq.org/v1/proposals')).json()) as { proposals: Array<{ govHash: string; name?: string; collateralHeight?: number | null }> };
  const p = props.proposals.find((x) => x.collateralHeight)!;
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem('govhub.registry.v2')) localStorage.setItem('govhub.registry.v2', JSON.stringify({ version: 2, profile: 'testnet', overrides: {} }));
    } catch { /* about:blank has no storage */ }
  });
  const errors = await watchPage(page);
  const r = await settle(page, p.govHash);
  console.log(`live: Testnet ${r.level} in ${r.ms} ms ${JSON.stringify(r.states)}${r.reason ? `: ${r.reason}` : ''}`);
  await expectSettled(r);
  // testnet is only "Verified" through quorum-proven ChainLocks; on proof of work alone it must say so
  if (r.level === 'partial' && r.states.chain === 'reported') expect(r.reason).toMatch(/Testnet|proof of work|not verified/);
  results.testnet = { proposal: p.name ?? p.govHash, level: r.level, reason: r.reason, states: r.states, settleMs: r.ms };
  if (process.env.SCREENSHOTS) await page.screenshot({ path: 'screenshots/after/live-testnet-drawer-light-desktop.png' });
  expect(errors).toEqual([]);
  writeFileSync(new URL('./trust-live-results.json', import.meta.url), JSON.stringify({ ranAt: new Date().toISOString(), ...results }, null, 2) + '\n');
});
