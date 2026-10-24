// Opt-in live tests (GOVHUB_LIVE=1 npm run e2e:live): real evo-sdk Platform reads with proofs from
// the testnet gov contract, a real mainnet DAPI collateral lookup (block proof, ChainLock when the block is recent
// enough) from the browser worker, and the masternode-list agreement of several mainnet DAPI nodes confirming the
// voting keys of recorded mainnet votes.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { cspViolations, watchPage } from './helpers.ts';

test.skip(!process.env.GOVHUB_LIVE, 'set GOVHUB_LIVE=1 to run against live Platform and DAPI');
test.setTimeout(180_000);

test('@live reads the gov contract with proofs and verifies a collateral over mainnet DAPI', async ({ page }) => {
  const errors = await watchPage(page);
  await page.goto('/?fixtures=0');

  // The SDK chunk loads lazily; either proposals or the "nothing published yet" banner appear.
  const cards = page.locator('article.card');
  const empty = page.getByText('No active proposals on Platform yet.');
  await expect(cards.first().or(empty)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Platform could not be read.')).toHaveCount(0);

  const n = await cards.count();
  console.log(`live: ${n} active proposals on Platform`);
  if (process.env.SCREENSHOTS) await page.screenshot({ path: 'screenshots/live-active-light-desktop.png', fullPage: true });
  // Real proposals (content check passes) must verify against mainnet over DAPI; phase-0 spike
  // documents on testnet carry a "do not match" chip and are skipped.
  const real = cards.filter({ hasNot: page.locator('.chip-bad') });
  if ((await real.count()) > 0) {
    await expect(real.first().locator('[data-prov="proof"], [data-prov="reported"]').first()).toBeVisible();
    await real.first().locator('h3 a').click();
    const collateral = page.getByTestId('collateral-check');
    await expect(collateral.locator('[data-verdict]')).toBeVisible({ timeout: 90_000 });
    console.log(`live: ${await page.locator('h1').innerText()}: ${(await collateral.innerText()).replace(/\s+/g, ' ').slice(0, 500)}`);
    await expect(collateral.locator('[data-verdict]')).toHaveAttribute('data-verdict', 'ok');
    await expect(collateral.locator('[data-step="tx"]')).not.toContainText('recorded.dapi.invalid');
    // The block proof (whole block fetched, merkle root recomputed, coinbase height, X11 hash) must have worked against real mainnet
    // nodes. It counts as "verified" only when a BLS-valid ChainLock anchors the block (collaterals older than ~3.5 days cannot be).
    await expect(collateral.locator('[data-step="block"]')).toHaveAttribute('data-status', 'ok');
    // The ChainLock is BLS-verified when the nodes allow it, else a labelled node claim; either way the collateral line says which.
    const chainlock = collateral.locator('[data-step="chainlock"]');
    const basis = await chainlock.getAttribute('data-basis');
    console.log(`live: ChainLock basis=${basis}: ${(await chainlock.innerText()).replace(/\s+/g, ' ')}`);
    await expect(page.locator('.info-row', { hasText: 'Collateral status' })).toContainText(basis === 'verified' ? 'BLS-verified' : 'node');
    if (process.env.SCREENSHOTS) await page.screenshot({ path: 'screenshots/live-proposal-light-desktop.png', fullPage: true });
  }

  expect(errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
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

  await expect(page.getByRole('checkbox', { name: /Confirm voting keys/ })).toBeChecked();
  await page.getByRole('button', { name: 'Verify votes' }).click();
  const votes = page.getByTestId('votes-check');
  await expect(votes.locator('[data-votes]')).toBeVisible({ timeout: 200_000 });
  const text = (await votes.innerText()).replace(/\s+/g, ' ');
  console.log(`live: votes: ${text.slice(0, 900)}`);
  // Platform's tally may predate the voteSetHash alignment (govhub-voteset-v1) or differ in votes cast since: say which fields.
  console.log(`live: fields that differ from the Platform tally: ${JSON.stringify(await votes.locator('table.compare tr:has(td.bad) th').allInnerTexts())}`);
  // The keys were checked against the masternode list the DAPI nodes agree on (cross-node agreement, in the worker).
  await expect(votes).toContainText('voting keys confirmed against the masternode list that DAPI nodes');
  await expect(votes).toContainText(/\d+ checked/);
  // The vote set was requested at the Platform tally's height, the masternode list at the tally's height.
  expect(requested.some((r) => /\/votes\?height=\d+$/.test(r))).toBe(true);
  expect(requested.some((r) => /\/v1\/mnlist\/\d+$/.test(r))).toBe(true);
  expect(errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});
