// Opt-in live TESTNET run of the masternode keyring and voting in headless Chromium (GOVHUB_LIVE_VOTE=1 npm run e2e:vote):
//   sign in with a phrase -> save a keyring on Platform -> add a testnet masternode voting key -> its masternode appears ->
//   sign out -> sign in again -> the keyring is restored (key and masternode back) -> vote on a proposal through the relay ->
//   the vote shows up in the bridge.
// Inputs (env): GOVHUB_VOTE_PROPOSAL (gov hash), GOVHUB_VOTE_RELAY (default http://127.0.0.1:18791, an ssh tunnel to the relay),
// GOVHUB_VOTE_MN (testnet.yml masternode name, default masternode-5). The phrase is the e2e identity's
// (~/.local/share/govhub-phase2/e2e-phrase.json); the voting key comes from ~/workspace/dash-network-configs/testnet.yml. Neither
// is printed; traces are off for live runs (playwright.config.ts). Results without secrets: e2e/results/vote-live.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { testnetMnKeys } from '../scripts/testnet-mn-keys.ts';
import { cspViolations, watchPage } from './helpers.ts';

test.skip(!process.env.GOVHUB_LIVE_VOTE, 'set GOVHUB_LIVE_VOTE=1 to run the live testnet keyring and voting flow (spends tCredits)');
test.setTimeout(15 * 60_000);

const GOV = process.env.GOVHUB_VOTE_PROPOSAL ?? '';
const RELAY = process.env.GOVHUB_VOTE_RELAY ?? 'http://127.0.0.1:18791';
const MN = process.env.GOVHUB_VOTE_MN ?? 'masternode-5';
const PHRASE = JSON.parse(readFileSync(join(homedir(), '.local/share/govhub-phase2/e2e-phrase.json'), 'utf8')).phrase as string;

const REGISTRY = {
  version: 1,
  coreNetwork: 'testnet',
  platformNetwork: 'testnet',
  dapi: { source: 'quorum', quorumUrl: 'https://quorums.testnet.networks.dash.org/masternodes', nodes: [] },
  platform: { trusted: true, addresses: [] },
  govContractId: '5gMnJLDpcoMaQCQNqmHtBiSqCxRCmroXFAffPNdJ2NJC',
  bridges: [{ name: 'gov-bridge-testnet.dashhq.org', httpBase: 'https://gov-bridge-testnet.dashhq.org', govContractId: '5gMnJLDpcoMaQCQNqmHtBiSqCxRCmroXFAffPNdJ2NJC', bridgeIdentityId: '24tL6v5jMR1H9dtUoTgbedePsMJtYPk4Q4bo6h8jTdK9', enabled: true }],
  relays: [{ name: 'testnet relay (tunnel)', url: RELAY }],
  priceFeed: null,
  accounts: null,
  faucet: null,
  forum: { contractId: 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw', modContractId: 'CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY', moderationIdentityId: '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv', moderationName: 'govhub moderation', claimPortals: ['gov.dashhq.org'] },
};

async function signInWithPhrase(page: Page) {
  await page.getByRole('button', { name: 'Sign in' }).first().click();
  await page.getByRole('button', { name: /I have a recovery phrase/ }).click();
  await page.getByTestId('phrase-input').fill(PHRASE);
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await expect(page.getByTestId('session-button')).not.toHaveText('Sign in', { timeout: 120_000 });
}
async function signOut(page: Page) {
  await page.getByTestId('session-button').click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
}

test('@live-vote keyring saved on Platform, restored after signing in again, then a vote through the relay', async ({ page }) => {
  expect(GOV).toMatch(/^[0-9a-f]{64}$/);
  const key = testnetMnKeys().find((k) => k.name === MN);
  expect(key).toBeTruthy();
  const errors = await watchPage(page);
  const results: Record<string, unknown> = { network: 'testnet', at: new Date().toISOString(), proposal: GOV, masternode: MN, votingAddress: key!.address };
  page.on('console', (m) => m.type() === 'error' && console.log(`console.error: ${m.text().replace(/[1-9A-HJ-NP-Za-km-z]{50,}/g, '[b58]').slice(0, 300)}`));
  await page.addInitScript((r) => localStorage.setItem('govhub.registry.v1', JSON.stringify(r)), REGISTRY);

  // ---- 1. sign in, keyring ----
  await page.goto('/masternodes');
  await signInWithPhrase(page);
  const status = page.getByTestId('keyring-status');
  const create = page.getByTestId('create-keyring');
  await expect(status.or(create)).toBeVisible({ timeout: 120_000 });
  results.keyringExistedBefore = await status.isVisible();
  if (await create.isVisible()) {
    await create.click();
    await expect(status).toContainText('Saved on Platform', { timeout: 180_000 });
  }

  // ---- 2. add the voting key (skipped if a previous run left it in the keyring) ----
  const keyList = page.getByTestId('key-list');
  const already = (await keyList.count()) > 0 && (await keyList.innerText()).includes(key!.address);
  if (!already) {
    await page.getByTestId('voting-key-input').fill(key!.wif);
    await page.getByTestId('voting-key-label').fill('e2e key');
    await page.getByTestId('voting-key-add').click();
    await expect(keyList).toContainText(key!.address, { timeout: 180_000 });
  }
  await expect(page.getByTestId('mn-row').first()).toBeVisible({ timeout: 120_000 });
  results.masternodesBefore = await page.getByTestId('mn-row').count();
  await expect(page.getByTestId('keyring-error')).toHaveCount(0);

  // ---- 3. sign out: everything is gone from the page ----
  await signOut(page);
  await expect(page.getByTestId('key-list')).toHaveCount(0);
  await expect(page.getByTestId('mn-row')).toHaveCount(0);

  // ---- 4. sign in again: restored from Platform ----
  const t0 = Date.now();
  await signInWithPhrase(page);
  await expect(page.getByTestId('keyring-status')).toContainText('Saved on Platform', { timeout: 120_000 });
  await expect(page.getByTestId('key-list')).toContainText(key!.address);
  await expect(page.getByTestId('mn-row').first()).toBeVisible({ timeout: 120_000 });
  results.masternodesAfter = await page.getByTestId('mn-row').count();
  results.restoreSeconds = Math.round((Date.now() - t0) / 1000);
  expect(results.masternodesAfter).toBe(results.masternodesBefore);

  // ---- 5. vote on the proposal (immediately) ----
  await page.goto(`/p/h/${GOV}`);
  // a full page load is a new tab state: signing in again restores the keyring once more
  await signInWithPhrase(page);
  const panel = page.getByTestId('mn-vote-panel');
  await expect(panel.getByTestId('vote-mn-row').first()).toBeVisible({ timeout: 180_000 });
  await panel.getByTestId('vote-choice').selectOption('1');
  await panel.getByTestId('vote-send').click();
  await expect(panel.getByTestId('vote-result')).toContainText('signed and handed to a relay', { timeout: 120_000 });

  // ---- 6. the watchdog sees it in the bridge ----
  await page.goto('/masternodes');
  await signInWithPhrase(page);
  const row = page.getByTestId('watched-row').first();
  await expect(row).toHaveAttribute('data-status', 'confirmed', { timeout: 6 * 60_000 });
  results.voteConfirmedInBridge = true;
  mkdirSync('e2e/results', { recursive: true });
  writeFileSync('e2e/results/vote-live.json', JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results));
  expect(errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});
