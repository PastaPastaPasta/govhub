// Opt-in live tests (GOVHUB_LIVE=1 npm run e2e:live): real evo-sdk Platform reads with proofs from
// the testnet gov contract, a real mainnet DAPI collateral lookup (block proof, ChainLock when the block is recent
// enough) from the browser worker, and the masternode-list agreement of several mainnet DAPI nodes confirming the
// voting keys of recorded mainnet votes.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { cspViolations, openDrawer, watchPage } from './helpers.ts';

test.skip(!process.env.GOVHUB_LIVE, 'set GOVHUB_LIVE=1 to run against live Platform and DAPI');
test.setTimeout(180_000);

test('@live reads the gov contract with proofs and verifies a collateral over mainnet DAPI', async ({ page }) => {
  const errors = await watchPage(page);
  await page.goto('/?fixtures=0');

  // The SDK chunk loads lazily; either proposals or the "nothing published yet" banner appear.
  const cards = page.locator('article.prow');
  const empty = page.getByText('No active proposals on Platform yet.');
  await expect(cards.first().or(empty)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Platform could not be read.')).toHaveCount(0);

  const n = await cards.count();
  console.log(`live: ${n} active proposals on Platform`);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: 'screenshots/live-active-light-desktop.png', fullPage: true });
  // Real proposals (content check passes) must verify against mainnet over DAPI; phase-0 spike
  // documents on testnet carry a "do not match" chip and are skipped.
  const real = cards.filter({ hasNot: page.locator('.chip-bad, .tag-fail') });
  if ((await real.count()) > 0) {
    await real.first().locator('h2 a').click();
    const drawer = await openDrawer(page);
    const collateral = drawer.getByTestId('collateral-check');
    await expect(collateral.locator('[data-verdict]')).toBeAttached({ timeout: 90_000 });
    console.log(`live: ${await page.locator('h1').innerText()}: ${((await collateral.textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 500)}`);
    await expect(collateral.locator('[data-verdict]')).toHaveAttribute('data-verdict', 'ok');
    await expect(collateral.locator('[data-step="tx"]')).not.toContainText('recorded.dapi.invalid');
    // The block proof (whole block fetched, merkle root recomputed, coinbase height, X11 hash) must have worked against real mainnet
    // nodes. It counts as "verified" only when a BLS-valid ChainLock anchors the block (collaterals older than ~3.5 days cannot be).
    await expect(collateral.locator('[data-step="block"]')).toHaveAttribute('data-status', 'ok');
    // The ChainLock is BLS-verified when the nodes allow it, else a labelled node claim; either way the collateral line says which.
    const chainlock = collateral.locator('[data-step="chainlock"]');
    const basis = await chainlock.getAttribute('data-basis');
    console.log(`live: ChainLock basis=${basis}: ${(await chainlock.textContent())?.replace(/\s+/g, ' ')}`);
    await expect(chainlock).toContainText(basis === 'verified' ? 'BLS-verified' : 'node');
    if (process.env.SCREENSHOTS) await page.screenshot({ path: 'screenshots/live-proposal-light-desktop.png', fullPage: true });
  }

  expect(errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});

// ---- the Dev profile hides what fails verification ---------------------------------------------------------------------
// Phase-0 spike documents in the Dev contract: two whose gov hash does not recompute, and a synthetic claim test whose collateral
// is not on mainnet. None may count or show by default.
const SPIKES = ['govhub-spike-r2-1', 'govhub-spike-1'];

test('@live Dev profile: spike proposals are hidden, counts and remaining payments are sane', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = await watchPage(page);
  await page.goto('/?fixtures=0');
  await expect(page.getByTestId('profile-label')).toContainText('Dev: mainnet data on testnet Platform');
  const cards = page.locator('article.prow');
  await expect(cards.first()).toBeVisible({ timeout: 120_000 });
  // Reveal the whole list, then wait for the background collateral checks to settle.
  for (let i = 0; i < 5; i++) await page.locator('.sentinel').scrollIntoViewIfNeeded();
  await expect(page.locator('article.prow[data-check="pending"]')).toHaveCount(0, { timeout: 240_000 });
  for (let i = 0; i < 5; i++) await page.locator('.sentinel').scrollIntoViewIfNeeded();
  for (const name of SPIKES) await expect(page.locator('article.prow', { hasText: name })).toHaveCount(0);

  const shown = await cards.count();
  const navCount = Number(await page.getByRole('link', { name: /^Active/ }).locator('.count').innerText());
  expect(navCount).toBe(shown);
  await expect(page.locator('.budget-facts')).toContainText(`of ${shown} proposals`);
  const pays = await page.locator('article.prow .prow-ask').allInnerTexts();
  const totals = pays.flatMap((t) => [...t.matchAll(/(\d+) of (\d+) payments left/g)].map((m) => ({ left: Number(m[1]), total: Number(m[2]) })));
  console.log(`live: ${shown} shown; payments ${JSON.stringify(totals)}`);
  expect(totals.length).toBeGreaterThan(0);
  for (const t of totals) {
    expect(t.total).toBeLessThanOrEqual(40);
    expect(t.left).toBeLessThanOrEqual(t.total);
  }
  if (process.env.SCREENSHOTS) await page.screenshot({ path: 'screenshots/live-active-light-desktop.png', fullPage: true });

  const toggle = page.getByTestId('toggle-failed');
  const label = await toggle.innerText();
  console.log(`live: ${label}`);
  expect(Number(/Show (\d+)/.exec(label)?.[1])).toBeGreaterThanOrEqual(SPIKES.length);
  await toggle.click();
  for (const name of SPIKES) await expect(page.locator('article.prow.prow-invalid', { hasText: name }).getByTestId('invalid-reason')).toContainText('Governance hash');
  await expect(page.locator('.budget-facts')).toContainText(`of ${shown} proposals`);
  if (process.env.SCREENSHOTS) await page.locator('.list-section').screenshot({ path: 'screenshots/live-failed-shown-light-desktop.png' });

  await page.getByRole('link', { name: 'Past', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Past proposals' })).toBeVisible();
  const pastToggle = page.getByTestId('toggle-failed');
  await expect(pastToggle).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('table.past tr', { hasText: 'govhub-claim-test' })).toHaveCount(0);
  await pastToggle.click();
  const claimTest = page.locator('table.past tr.row-invalid', { hasText: 'govhub-claim-test' });
  await expect(claimTest).toBeVisible();
  console.log(`live: govhub-claim-test: ${(await claimTest.innerText()).replace(/\s+/g, ' ')}`);
  expect(errors).toEqual([]);
});

// ---- voting keys against the live DAPI masternode list ----------------------------------------------------------------
// The bridge is a stand-in serving the RECORDED mainnet votes and masternode entries (services/bridge/test/fixtures); Platform
// and the DAPI nodes are live. The recount is compared with whatever tally Platform holds for the proposal.
interface Recording {
  mnList: { height: number; listHash: string; entries: Array<{ proTxHash: string; collateralTxid: string; collateralIndex: number; type: string; votingAddress: string; isValid: boolean }> };
  proposals: Array<{ govHash: string; tally: { voteSetHash: string }; votes: Array<{ hash: string; rawHex: string }> }>;
}
const GROWTH = 'd784b13a4fa55e8e1e5f6a0271db412fda5f4407221349fd1a6d1498dfad6a96'; // dash-growth-q4-2026
const TESTNET_GOV = '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ';

/** CGovernanceVote SER_NETWORK: txid(32, internal order) n(u32) parent(32) outcome(i32) signal(i32) time(i64) sigLen sig. */
function voteJson(v: { hash: string; rawHex: string }) {
  const b = Buffer.from(v.rawHex, 'hex');
  return {
    hash: v.hash,
    collateralTxid: Buffer.from(b.subarray(0, 32)).reverse().toString('hex'),
    collateralIndex: b.readUInt32LE(32),
    outcome: b.readInt32LE(68),
    signal: b.readInt32LE(72),
    time: Number(b.readBigInt64LE(76)),
    sig: b.subarray(85, 85 + b[84]!).toString('base64'),
    rawHex: v.rawHex,
  };
}

test('@live voting keys of recorded votes are confirmed by the masternode list that mainnet DAPI nodes agree on', async ({ page, context }) => {
  test.setTimeout(240_000);
  const rec = JSON.parse(readFileSync(new URL('../../../services/bridge/test/fixtures/mainnet-votes.json', import.meta.url), 'utf8')) as Recording;
  const p = rec.proposals.find((x) => x.govHash === GROWTH)!;
  const requested: string[] = [];
  await context.route('https://bridge.test/**', async (route) => {
    const u = new URL(route.request().url());
    requested.push(u.pathname + u.search);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (u.pathname === `/v1/proposals/${GROWTH}/votes`) {
      const h = Number(u.searchParams.get('height') ?? rec.mnList.height);
      return json({ govHash: GROWTH, network: 'mainnet', voteSetHashVersion: 'govhub-voteset-v1', asOfHeight: h, tallyHeight: h, mnListHash: rec.mnList.listHash, voteSetHash: p.tally.voteSetHash, count: p.votes.length, votes: p.votes.map(voteJson) });
    }
    if (u.pathname.startsWith('/v1/mnlist')) {
      const masternodes = rec.mnList.entries.map((e) => ({ ...e, type: e.type === 'Evo' ? 'evo' : 'regular', weight: e.type === 'Evo' ? 4 : 1, valid: e.isValid }));
      return json({ height: rec.mnList.height, listHash: rec.mnList.listHash, masternodes });
    }
    return json({ error: 'not found' }, 404);
  });
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key!, value!),
    [
      'govhub.registry.v1',
      JSON.stringify({
        version: 1,
        coreNetwork: 'mainnet',
        platformNetwork: 'testnet',
        dapi: { source: 'quorum', quorumUrl: 'https://quorums.mainnet.networks.dash.org/masternodes', nodes: [] },
        platform: { trusted: true, addresses: [] },
        govContractId: TESTNET_GOV,
        bridges: [{ name: 'recorded bridge', httpBase: 'https://bridge.test', govContractId: TESTNET_GOV, bridgeIdentityId: '', enabled: true }],
        relays: [],
        priceFeed: null,
      }),
    ],
  );
  const errors = await watchPage(page);
  await page.goto(`/p/h/${GROWTH}?fixtures=0`);
  await expect(page.getByRole('heading', { level: 1, name: 'dash-growth-q4-2026' })).toBeVisible({ timeout: 120_000 });

  // The recount runs on its own once the tallies are read; it targets the Platform tally's height.
  await expect(page.getByTestId('p-votes')).toContainText(/\d+ yes/, { timeout: 120_000 });
  const drawer = await openDrawer(page);
  const votes = drawer.getByTestId('votes-check');
  await expect(votes.locator('[data-votes]')).toBeAttached({ timeout: 200_000 });
  const text = ((await votes.textContent()) ?? '').replace(/\s+/g, ' ');
  console.log(`live: votes: ${text.slice(0, 900)}`);
  // Platform's tally may predate the voteSetHash alignment (govhub-voteset-v1) or differ in votes cast since: say which fields.
  console.log(`live: fields that differ from the Platform tally: ${JSON.stringify(await votes.locator('table.compare tr:has(td.bad) th').allInnerTexts())}`);
  // The keys were checked against the masternode list proven into the verified chain (in the worker).
  await expect(votes).toContainText('voting keys checked against the masternode list');
  await expect(votes).toContainText(/\d+ checked/);
  // The vote set was requested at the Platform tally's height, the masternode list at the tally's height.
  expect(requested.some((r) => /\/votes\?height=\d+$/.test(r))).toBe(true);
  expect(requested.some((r) => /\/v1\/mnlist\/\d+$/.test(r))).toBe(true);
  expect(errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});
