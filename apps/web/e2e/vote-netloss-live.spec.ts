// Opt-in live TESTNET run of B-S1-1 (a D-005 variant) in headless Chromium:
//   GOVHUB_LIVE_NETLOSS=1 GOVHUB_VOTE_PROPOSAL=<gov hash> GOVHUB_VOTE_MN=<testnet.yml name> GOVHUB_VOTE_PROTX=<its proTxHash> \
//     npx playwright test --grep @live-netloss
//   1. sign in with the e2e phrase, lock the saved keyring and add ONLY GOVHUB_VOTE_MN's key, memory only (no Platform write)
//   2. vote now with it (relay broadcasts it), then vote differently: Core's one-change-per-hour rule makes the relay HOLD it
//   3. the relay stores that POST /v1/votes, but the browser loses the answer as a connection reset (route.fetch, then abort)
//   4. the tracker must say it may be at the relay (never "Not sent yet"), and "Cancel this vote" must cancel it AT THE RELAY
// A route guard (live-vote-guard.ts) lets votes out only for GOVHUB_VOTE_MN (never a reserved masternode). Keys and the phrase are
// never printed; results without secrets: e2e/results/vote-netloss-live.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { profileRegistry } from '../src/config/registry.ts';
import { RESERVED_TESTNET_MNS, testnetMnKeys } from '../scripts/testnet-mn-keys.ts';
import { watchPage } from './helpers.ts';
import { guardLiveVotes } from './live-vote-guard.ts';

test.skip(!process.env.GOVHUB_LIVE_NETLOSS, 'set GOVHUB_LIVE_NETLOSS=1 to run the live testnet lost-answer flow (casts real testnet votes)');
test.setTimeout(15 * 60_000);

const GOV = process.env.GOVHUB_VOTE_PROPOSAL ?? '';
const MN = process.env.GOVHUB_VOTE_MN ?? '';
const PROTX = process.env.GOVHUB_VOTE_PROTX ?? '';
const PHRASE = JSON.parse(readFileSync(join(homedir(), '.local/share/govhub-phase2/e2e-phrase.json'), 'utf8')).phrase as string;
const REGISTRY = profileRegistry('testnet');
const RELAY = REGISTRY.relays[0]!.url;

const relayVote = async (id: string) => (await fetch(`${RELAY}/v1/votes/${id}`)).json() as Promise<{ status: string; releaseAt: number; holdReason: string | null }>;
const navigate = (page: Page, path: string) =>
  page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);

test('@live-netloss a held vote whose answer is lost as a connection reset is cancelled at the relay, not discarded', async ({ page }) => {
  expect(GOV).toMatch(/^[0-9a-f]{64}$/);
  expect(PROTX).toMatch(/^[0-9a-f]{64}$/);
  expect(RESERVED_TESTNET_MNS.has(MN), `${MN} is reserved: pick another masternode`).toBe(false);
  const key = testnetMnKeys().find((k) => k.name === MN);
  expect(key, `${MN} is not a usable testnet.yml masternode`).toBeTruthy();
  const errors = await watchPage(page);
  const results: Record<string, unknown> = { network: 'testnet', at: new Date().toISOString(), proposal: GOV, masternode: MN, proTxHash: PROTX, relay: RELAY };
  await page.addInitScript((r) => localStorage.setItem('govhub.registry.v2', JSON.stringify(r)), REGISTRY);

  // vote POSTs: the relay always gets them; while `lose` is on, the browser gets a connection reset instead of the answer
  let lose = false;
  const posts: Array<{ at: string; outcome: unknown; status: number; id?: string; relayStatus?: string; lost: boolean }> = [];
  const cancels: Array<{ at: string; id: unknown }> = [];
  const guard = await guardLiveVotes(page.context(), {
    bridge: REGISTRY.bridges[0]!.httpBase,
    proTxHash: PROTX,
    onVote: async (route, body) => {
      const lost = lose;
      const resp = await route.fetch();
      const text = await resp.text();
      let j: { id?: string; status?: string } = {};
      try {
        j = JSON.parse(text) as typeof j;
      } catch {
        /* not JSON */
      }
      posts.push({ at: new Date().toISOString(), outcome: body.outcome, status: resp.status(), ...(j.id ? { id: j.id } : {}), ...(j.status ? { relayStatus: j.status } : {}), lost });
      if (lost) return route.abort('connectionreset');
      return route.fulfill({ response: resp, body: text });
    },
  });
  await page.context().route(/\/v1\/votes\/cancel$/, async (route) => {
    let id: unknown;
    try {
      id = (JSON.parse(route.request().postData() ?? '{}') as { id?: unknown }).id;
    } catch {
      /* unreadable */
    }
    cancels.push({ at: new Date().toISOString(), id });
    return route.fallback();
  });

  // ---- 1. sign in, lock the saved keyring, add only this masternode's key, memory only ----
  await page.goto('/masternodes');
  await page.getByTestId('session-button').click();
  const sheet = page.locator('dialog[open]');
  await sheet.getByRole('button', { name: /I have a recovery phrase/ }).click();
  await sheet.getByTestId('phrase-input').fill(PHRASE);
  await sheet.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByTestId('session-button')).not.toHaveText('Sign in', { timeout: 120_000 });
  const status = page.getByTestId('keyring-status');
  const memOnly = page.getByTestId('unlock-memory-only');
  await expect(status.or(memOnly)).toBeVisible({ timeout: 180_000 });
  if (await status.isVisible()) await page.getByTestId('keyring-lock').click();
  await memOnly.click();
  await page.getByTestId('flow-key-input').fill(key!.wif);
  await page.getByTestId('flow-key-label').fill(MN);
  await page.getByTestId('flow-find').click();
  await expect(page.getByTestId('flow-mns')).toContainText('votes for 1 masternode.', { timeout: 180_000 });
  await expect(page.getByTestId('flow-mns')).toContainText(PROTX.slice(0, 12));
  const badge = page.getByTestId('mnb-toggle');
  if ((await badge.count()) && (await badge.isChecked())) await badge.uncheck();
  await expect(page.getByTestId('flow-dont-save')).toBeChecked();
  await page.getByTestId('flow-confirm').click();
  await expect(page.getByTestId('flow-done')).toBeVisible({ timeout: 120_000 });

  // ---- 2. vote now (goes out), then a different vote: held for the one-hour rule ----
  await navigate(page, `/p/h/${GOV}`);
  const panel = page.getByTestId('mn-vote-panel');
  const rows = panel.getByTestId('vote-mn-row');
  await expect(rows).toHaveCount(1, { timeout: 180_000 }); // the memory-only keyring holds this masternode only
  await expect(rows.first()).toHaveAttribute('data-protx', PROTX);
  await expect(rows.first().getByTestId('current-vote')).not.toContainText('…', { timeout: 60_000 });
  const before = (await rows.first().getByTestId('current-vote').innerText()).trim();
  const first = /Abstain/.test(before) ? 'No' : 'Abstain';
  const second = first === 'Abstain' ? 'Yes' : 'Abstain';
  results.currentBefore = before;
  await panel.getByTestId('vote-choice').getByRole('radio', { name: first }).click();
  await expect(panel.getByTestId('vote-send')).toHaveText(`Vote ${first} with 1 masternode`);
  await panel.getByTestId('vote-send').click();
  const firstTracker = panel.getByTestId('vote-tracker').first();
  await expect(firstTracker).toHaveAttribute('data-status', /broadcast|confirmed/, { timeout: 180_000 });
  results.firstVote = { outcome: first, status: await firstTracker.getAttribute('data-status') };
  const dismiss = panel.getByRole('button', { name: 'Dismiss' });
  if (await dismiss.count()) await dismiss.click();

  // ---- 3. the second vote: the relay stores it, the browser loses the answer (connection reset) ----
  lose = true;
  const n0 = posts.length;
  await panel.getByTestId('vote-choice').getByRole('radio', { name: second }).click();
  await expect(panel.getByTestId('vote-send')).toHaveText(`Vote ${second} with 1 masternode`);
  await panel.getByTestId('vote-send').click();
  const secondTrackers = panel.getByTestId('vote-tracker').filter({ has: page.locator(`.vout-${second === 'Yes' ? 1 : 3}`) });
  const held = secondTrackers.first();
  await expect(held.getByTestId('vote-tracker-badge')).toHaveText('May be at the relay', { timeout: 60_000 });
  const lostPost = posts.slice(n0).find((p) => p.lost && p.id);
  expect(lostPost, 'the relay stored the vote whose answer was lost').toBeTruthy();
  const atRelay = await relayVote(lostPost!.id!);
  expect(atRelay.status).toBe('held');
  results.lostAnswer = { post: lostPost, relayAfterLoss: atRelay };
  const line = (await held.getByTestId('vote-tracker-line').innerText()).trim();
  results.trackerAfterLoss = { badge: await held.getByTestId('vote-tracker-badge').innerText(), line, cancelButton: await held.getByTestId('vote-cancel').innerText() };
  expect(line).not.toMatch(/Not sent|Not accepted/);
  expect(line).toContain('may already be held there');
  await expect(held.getByTestId('vote-cancel')).toHaveText('Cancel this vote');
  mkdirSync('e2e/results', { recursive: true });
  await held.screenshot({ path: 'e2e/results/vote-netloss-live-lost.png' });

  // ---- 4. cancel: posted again to learn the id at the relay, then cancelled there ----
  lose = false;
  const c0 = cancels.length;
  await held.getByTestId('vote-cancel').click();
  await expect.poll(() => cancels.slice(c0).some((c) => c.id === lostPost!.id), { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => (await relayVote(lostPost!.id!)).status, { timeout: 60_000 }).toBe('cancelled');
  await expect(secondTrackers).toHaveCount(0, { timeout: 60_000 });
  results.cancel = { requests: cancels.slice(c0), reposts: posts.slice(n0).filter((p) => !p.lost), relayFinal: await relayVote(lostPost!.id!) };
  results.blockedByGuard = guard.blocked;
  writeFileSync('e2e/results/vote-netloss-live.json', JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results));
  expect(guard.blocked, 'a vote for another masternode was attempted').toEqual([]);
  expect(errors).toEqual([]);
});
