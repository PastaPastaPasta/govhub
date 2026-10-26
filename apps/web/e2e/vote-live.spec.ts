// Opt-in live TESTNET run of the masternode keyring and voting in headless Chromium (GOVHUB_LIVE_VOTE=1 npm run e2e:vote):
//   1. sign in with a recovery phrase (the keyring opens, or is created on Platform)
//   2. add the GOVHUB_VOTE_MN voting key (removed first if a previous run left it) -> exactly its 1 masternode, with details
//   3. vote on an active testnet proposal, immediately -> the tracker reaches "seen by the network" (the bridge's verified vote set)
//   4. vote again at once: Core's one-change-per-hour rule makes the relay hold it -> cancel it
// Inputs (env, required): GOVHUB_VOTE_PROPOSAL (gov hash of an active testnet proposal the MN has not voted on), GOVHUB_VOTE_MN
// (testnet.yml masternode name; reserved MNs are refused), GOVHUB_VOTE_PROTX and GOVHUB_VOTE_PAYOUT (its public registration,
// what step 2 must find). Optional: GOVHUB_VOTE_RELAY (default: the Testnet profile's relay). The phrase is
// the e2e identity's (~/.local/share/govhub-phase2/e2e-phrase.json); the voting key comes from
// ~/workspace/dash-network-configs/testnet.yml. Neither is printed; traces are off for live runs (playwright.config.ts).
// The e2e identity's keyring holds other masternodes' keys too (reserved masternode-27 among them): the composer selects ONLY the
// GOVHUB_VOTE_MN row, and a route guard (live-vote-guard.ts) aborts any vote POST for another masternode; the run fails if it had to.
// Results without secrets: e2e/results/vote-live.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { profileRegistry } from '../src/config/registry.ts';
import { RESERVED_TESTNET_MNS, testnetMnKeys } from '../scripts/testnet-mn-keys.ts';
import { cspViolations, watchPage } from './helpers.ts';
import { guardLiveVotes } from './live-vote-guard.ts';

test.skip(!process.env.GOVHUB_LIVE_VOTE, 'set GOVHUB_LIVE_VOTE=1 to run the live testnet keyring and voting flow (spends tCredits)');
test.setTimeout(20 * 60_000);

const GOV = process.env.GOVHUB_VOTE_PROPOSAL ?? '';
const MN = process.env.GOVHUB_VOTE_MN ?? '';
/** the MN's registration (public): what step 2 must find */
const EXPECT = { proTxHash: process.env.GOVHUB_VOTE_PROTX ?? '', payout: process.env.GOVHUB_VOTE_PAYOUT ?? '' };
const PHRASE = JSON.parse(readFileSync(join(homedir(), '.local/share/govhub-phase2/e2e-phrase.json'), 'utf8')).phrase as string;
const base = profileRegistry('testnet');
const REGISTRY = process.env.GOVHUB_VOTE_RELAY ? { ...base, relays: [{ name: 'relay', url: process.env.GOVHUB_VOTE_RELAY }] } : base;

async function signInWithPhrase(page: Page) {
  await page.getByTestId('session-button').click();
  const sheet = page.locator('dialog[open]');
  await sheet.getByRole('button', { name: /I have a recovery phrase/ }).click();
  await sheet.getByTestId('phrase-input').fill(PHRASE);
  await sheet.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByTestId('session-button')).not.toHaveText('Sign in', { timeout: 120_000 });
}
const since = (t0: number) => Math.round((Date.now() - t0) / 1000);

test('@live-vote keyring: add a masternode, vote now until the network has it, hold one for the hour rule and cancel it', async ({ page }) => {
  expect(GOV).toMatch(/^[0-9a-f]{64}$/);
  expect(EXPECT.proTxHash).toMatch(/^[0-9a-f]{64}$/);
  expect(EXPECT.payout).not.toBe('');
  expect(RESERVED_TESTNET_MNS.has(MN), `${MN} is reserved: pick another masternode`).toBe(false);
  const key = testnetMnKeys().find((k) => k.name === MN);
  expect(key).toBeTruthy();
  const errors = await watchPage(page);
  const results: Record<string, unknown> = { network: 'testnet', at: new Date().toISOString(), proposal: GOV, masternode: MN, votingAddress: key!.address, relays: REGISTRY.relays.map((r) => r.url) };
  page.on('console', (m) => m.type() === 'error' && console.log(`console.error: ${m.text().replace(/[1-9A-HJ-NP-Za-km-z]{50,}/g, '[b58]').slice(0, 300)}`));
  await page.addInitScript((r) => localStorage.setItem('govhub.registry.v2', JSON.stringify(r)), REGISTRY);
  const guard = await guardLiveVotes(page.context(), { bridge: REGISTRY.bridges[0]!.httpBase, proTxHash: EXPECT.proTxHash });

  // ---- 1. seed sign-in, keyring ----
  console.log('step 1: sign in with the phrase');
  await page.goto('/masternodes');
  await signInWithPhrase(page);
  const status = page.getByTestId('keyring-status');
  const create = page.getByTestId('create-keyring');
  await expect(status.or(create)).toBeVisible({ timeout: 120_000 });
  if (await create.isVisible()) {
    await create.click();
    await expect(status).toContainText('Unlocked', { timeout: 180_000 });
  }
  await expect(page.getByTestId('keyring-settings').locator('summary')).toContainText('Opens with your recovery phrase');

  // ---- 2. add the GOVHUB_VOTE_MN key: exactly its masternode ----
  console.log('step 2: add the voting key');
  const group = page.getByTestId('key-group').filter({ hasText: key!.address });
  if (await group.count()) {
    await group.getByRole('button', { name: /^Remove / }).click();
    await group.getByRole('button', { name: 'Remove key' }).click();
    await expect(group).toHaveCount(0, { timeout: 180_000 });
  }
  const t2 = Date.now();
  await page.getByTestId('addkey-open').click();
  await page.getByTestId('voting-key-input').fill(key!.wif);
  await page.getByTestId('voting-key-label').fill(MN);
  await page.getByTestId('voting-key-add').click();
  await expect(page.getByTestId('addkey-result')).toHaveText(`✓ ${MN} controls 1 masternode.`, { timeout: 180_000 });
  results.addKeySeconds = since(t2);
  await expect(page.getByTestId('mn-progress')).toHaveCount(0, { timeout: 90_000 }); // the lookup never spins forever
  await expect(group.getByTestId('key-count')).toHaveText('controls 1 masternode');
  const card = group.getByTestId('mn-row');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-protx', EXPECT.proTxHash);
  await expect(card).toContainText('Regular');
  await expect(card).toContainText('Can vote');
  await expect(card.locator(`[title="${EXPECT.payout}"]`)).toHaveCount(1);
  results.found = { proTxHash: EXPECT.proTxHash, type: 'regular', valid: true, payout: EXPECT.payout, proof: ((await card.locator('.kr-mn-proof').textContent()) ?? '').trim() };
  await expect(page.getByTestId('mn-error')).toHaveCount(0);
  results.relayHealth = await page.getByTestId('relay-row').allInnerTexts();

  // ---- 3. vote now on an active proposal: until the network has it ----
  console.log('step 3: vote now');
  await page.goto(`/p/h/${GOV}`);
  await signInWithPhrase(page); // a full page load is a new tab state: the keyring opens again with the phrase
  const panel = page.getByTestId('mn-vote-panel');
  const row = panel.locator(`[data-testid="vote-mn-row"][data-protx="${EXPECT.proTxHash}"]`);
  await expect(row).toHaveCount(1, { timeout: 180_000 });
  await expect(row.getByTestId('current-vote')).not.toContainText('…', { timeout: 60_000 });
  const before = (await row.getByTestId('current-vote').locator('.vout').innerText()).trim();
  results.currentBefore = before;
  const first = before === 'Abstain' ? 'No' : 'Abstain';
  const second = first === 'Abstain' ? 'Yes' : 'Abstain';
  // only this masternode: every other row unchecked, whatever the keyring holds
  const mnsBox = panel.getByTestId('vote-mns');
  if ((await mnsBox.getAttribute('open')) === null) await mnsBox.locator('summary').click();
  const all = panel.getByRole('checkbox', { name: 'All masternodes' });
  if (await all.count()) await all.uncheck();
  await row.getByRole('checkbox').check();
  const rows = panel.getByTestId('vote-mn-row');
  for (let i = 0; i < (await rows.count()); i++) {
    const r = rows.nth(i);
    await expect(r.getByRole('checkbox')).toBeChecked({ checked: (await r.getAttribute('data-protx')) === EXPECT.proTxHash });
  }
  await panel.getByTestId('vote-choice').getByRole('radio', { name: first }).click();
  await expect(panel.getByTestId('vote-send')).toHaveText(`Vote ${first} with 1 masternode`);
  const t3 = Date.now();
  await panel.getByTestId('vote-send').click();
  const tracker = panel.getByTestId('vote-tracker').first();
  await expect(tracker).toBeVisible({ timeout: 60_000 });
  await expect(tracker.locator('[data-step="relay"]')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
  results.acceptedByRelaySeconds = since(t3);
  await expect(tracker).toHaveAttribute('data-status', /broadcast|confirmed/, { timeout: 180_000 });
  results.broadcastSeconds = since(t3);
  await expect(tracker).toHaveAttribute('data-status', 'confirmed', { timeout: 8 * 60_000 });
  results.seenByNetworkSeconds = since(t3);
  await expect(panel.getByTestId('vote-success')).toBeVisible();
  results.voteConfirmedInBridge = true;
  results.firstVote = first;
  await expect(tracker).toHaveAttribute('data-counted', 'yes', { timeout: 3 * 60_000 }).then(
    () => (results.countedSeconds = since(t3)),
    () => (results.countedSeconds = null),
  );
  await panel.getByTestId('vote-verify').click();
  await expect(panel.getByTestId('vote-proof').locator('li')).toHaveCount(4, { timeout: 120_000 });
  results.proof = await panel.getByTestId('vote-proof').locator('li').allInnerTexts();
  await expect(row.getByTestId('current-vote').locator('.vout')).toHaveText(first, { timeout: 60_000 });

  // ---- 4. a vote the relay holds (Core's one-change-per-hour rule) -> cancel ----
  console.log('step 4: a held vote, then cancel');
  await panel.getByRole('button', { name: 'Dismiss' }).click();
  await panel.getByTestId('vote-choice').getByRole('radio', { name: second }).click();
  await panel.getByTestId('vote-send').click();
  const held = panel.getByTestId('vote-tracker').filter({ has: page.locator(`.vout-${second === 'Yes' ? 1 : 3}`) }).first();
  await expect(held).toHaveAttribute('data-status', 'held', { timeout: 120_000 });
  await expect(held.getByTestId('vote-tracker-line')).toContainText('Core allows one vote change per hour per masternode');
  results.heldLine = (await held.getByTestId('vote-tracker-line').innerText()).trim();
  await held.getByTestId('vote-cancel').click();
  await expect(held).toHaveCount(0, { timeout: 120_000 });
  await page.goto('/masternodes');
  await signInWithPhrase(page);
  await expect(page.getByTestId('watched-row').filter({ hasText: 'Cancelled' }).first()).toBeVisible({ timeout: 60_000 });
  results.heldVoteCancelled = true;

  mkdirSync('e2e/results', { recursive: true });
  writeFileSync('e2e/results/vote-live.json', JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results));
  expect(guard.blocked, 'a vote for another masternode was attempted').toEqual([]);
  expect(errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});
