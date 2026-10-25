// Masternode keyring and voting in fixture mode: a demo keyring signs real votes with the synthetic masternodes' keys and the
// pretend relays and bridge of src/voting/sim.ts carry them, so every state of the vote tracker, the success card and the error
// states can be checked without a network. `?votesim=manual` moves votes one stage per window.__voteSim.advance().
import { expect, test, type Page } from '@playwright/test';
import { cspViolations, gotoFixtures, watchPage } from './helpers.ts';

const PROPOSAL = '/p/OrchardPay';

async function signIn(page: Page) {
  await page.getByTestId('session-button').click();
  await page.getByRole('button', { name: /^Alice$/ }).click();
  await expect(page.getByTestId('session-button')).not.toHaveText('Sign in');
}
const advance = (page: Page) => page.evaluate(() => (window as unknown as { __voteSim: { advance(): void } }).__voteSim.advance());

async function openPanel(page: Page, sim: string) {
  await gotoFixtures(page, `${PROPOSAL}?votesim=${sim}`);
  await signIn(page);
  const panel = page.getByTestId('mn-vote-panel');
  await expect(panel.getByTestId('vote-mn-row')).toHaveCount(3);
  return panel;
}

/** The masternode list is folded under "With all 3 of your masternodes"; opens it. */
async function openMns(page: Page) {
  const mns = page.getByTestId('mn-vote-panel').getByTestId('vote-mns');
  if ((await mns.getAttribute('open')) === null) await mns.locator('summary').click();
}

/** Selects only the first masternode and votes `outcome` with it. */
async function voteWithFirst(page: Page, outcome: 'Yes' | 'No' | 'Abstain') {
  const panel = page.getByTestId('mn-vote-panel');
  await openMns(page);
  await panel.getByRole('checkbox', { name: 'All masternodes' }).uncheck();
  await panel.getByTestId('vote-mn-row').first().getByRole('checkbox').check();
  await panel.getByTestId('vote-choice').getByRole('radio', { name: outcome }).click();
  await panel.getByTestId('vote-send').click();
  return panel.getByTestId('vote-tracker').first();
}

test.describe('keyring page (fixtures, demo keyring)', () => {
  test('masternodes grouped by voting key, empty votes, add-key warning, privacy collapsed', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/masternodes');
    await expect(page.getByRole('heading', { name: 'Sign in to add your masternodes' })).toBeVisible();
    await signIn(page);
    await expect(page.getByTestId('keyring-status')).toContainText('Demo keyring');
    const groups = page.getByTestId('key-group');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0).getByTestId('key-count')).toHaveText('controls 2 masternodes');
    await expect(groups.nth(1).getByTestId('key-count')).toHaveText('controls 1 masternode');
    await expect(groups.nth(1).getByTestId('mn-row')).toContainText('Evonode ×4');
    await expect(page.getByTestId('mn-row').first()).toContainText('Can vote');
    await expect(page.getByTestId('mn-row').first().getByRole('button', { name: 'Copy masternode ID' })).toBeVisible();
    await expect(page.getByTestId('votes-empty')).toBeVisible();
    await expect(page.locator('#addkey-warn')).toHaveText(/Only the voting key/);
    await expect(page.getByTestId('voting-key-input')).toHaveAttribute('aria-describedby', 'addkey-warn');
    const privacy = page.locator('details.kr-privacy');
    await expect(privacy).not.toHaveAttribute('open', '');
    await privacy.locator('summary').click();
    await expect(privacy).toContainText('DAPI evonodes');
    await expect(page.getByTestId('relay-row')).toHaveCount(2);
    await expect(page.getByTestId('relay-row').first()).toContainText('reachable');
    expect(errors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
  });
});

test.describe('vote panel (fixtures)', () => {
  test('one clear action: no "0 votes" button, keyboard picks the vote, the count follows the selection', async ({ page }) => {
    const panel = await openPanel(page, 'manual');
    const send = panel.getByTestId('vote-send');
    await expect(send).toBeDisabled();
    await expect(send).toHaveText('Choose Yes, No or Abstain');
    await expect(panel.getByTestId('vote-send-hint')).toHaveCount(0); // the button says it
    // keyboard: focus the group, arrows move the choice
    await panel.getByTestId('vote-choice').getByRole('radio', { name: 'Yes' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(panel.getByTestId('vote-choice').getByRole('radio', { name: 'No' })).toHaveAttribute('aria-checked', 'true');
    await expect(panel.getByTestId('vote-choice').getByRole('radio', { name: 'No' })).toBeFocused();
    await expect(send).toBeEnabled();
    await expect(send).toHaveText(/^Vote No with [1-3] masternodes?$/);
    // the masternodes are one line, folded: "With all 3 of your masternodes"
    await expect(panel.getByTestId('vote-mns').locator('summary')).toContainText('With all 3 of your masternodes');
    await openMns(page);
    await panel.getByRole('checkbox', { name: 'All masternodes' }).uncheck();
    await expect(send).toBeDisabled();
    await expect(send).toHaveText('Select at least one masternode');
    await expect(send).not.toHaveText(/\b0\b/);
    // random timing: offered, or it says why not
    const why = panel.getByTestId('vote-deferred-why');
    if (await panel.getByTestId('vote-deferred').isDisabled()) await expect(why).toHaveText(/Voting (closes in|for this superblock has closed)|not known yet/);
    else await expect(why).toHaveText(/random time before the deadline/);
    // timing is an option, folded
    await expect(panel.locator('details.vwhen')).not.toHaveAttribute('open', '');
  });

  test('a vote equal to the current one warns and needs a confirmation', async ({ page }) => {
    const panel = await openPanel(page, 'manual');
    await openMns(page);
    const row = panel.getByTestId('vote-mn-row').first();
    await expect(row.getByTestId('current-vote')).not.toContainText('…');
    const current = (await row.getByTestId('current-vote').locator('.vout').innerText()).trim();
    test.skip(current === 'Not voted', 'the first synthetic masternode has no vote on this proposal');
    await panel.getByRole('checkbox', { name: 'All masternodes' }).uncheck();
    await row.getByRole('checkbox').check();
    await panel.getByTestId('vote-choice').getByRole('radio', { name: current }).click();
    await expect(panel.getByTestId('vote-same-warning')).toContainText(`already voted ${current.toUpperCase()}; re-sending only updates the timestamp`);
    await expect(panel.getByTestId('vote-send')).toBeDisabled();
    await panel.getByTestId('vote-resend').check();
    await expect(panel.getByTestId('vote-send')).toBeEnabled();
  });

  test('stepper: every state, then the success card with the tally and "check it yourself"', async ({ page }) => {
    const errors = await watchPage(page);
    await openPanel(page, 'manual');
    const tracker = await voteWithFirst(page, 'Abstain');
    const step = (k: string) => tracker.locator(`[data-step="${k}"]`);
    // the relay took it and holds it: signed + accepted done, broadcast in progress
    await expect(tracker).toHaveAttribute('data-status', 'held');
    await expect(step('signed')).toHaveAttribute('data-state', 'done');
    await expect(step('relay')).toHaveAttribute('data-state', 'done');
    await expect(step('broadcast')).toHaveAttribute('data-state', 'active');
    await expect(tracker.getByTestId('vote-tracker-badge')).toHaveText('Held by relay');
    await expect(tracker.getByTestId('vote-tracker-line')).toContainText(/relay-(one|two)\.example/);
    // broadcast: waiting for the network
    await advance(page);
    await expect(tracker).toHaveAttribute('data-status', 'broadcast', { timeout: 15_000 });
    await expect(step('broadcast')).toHaveAttribute('data-state', 'done');
    await expect(step('seen')).toHaveAttribute('data-state', 'active');
    await expect(tracker.getByTestId('vote-tracker-line')).toContainText('waiting for the network');
    // seen by the network (bridge vote set, signature checked), then counted by the recount
    await advance(page);
    const win = page.getByTestId('vote-success');
    await expect(win).toBeVisible({ timeout: 15_000 });
    await expect(win.getByRole('heading')).toHaveText('Your vote is on the network');
    await expect(win).toContainText('voted ABSTAIN on OrchardPay');
    await expect(step('seen')).toHaveAttribute('data-state', 'done');
    await expect(tracker).toHaveAttribute('data-counted', 'yes', { timeout: 15_000 });
    await expect(step('counted')).toHaveAttribute('data-state', 'done');
    await expect(win.getByTestId('tally-abstain')).toBeVisible();
    // check it yourself: folded, then the vote re-verified here
    await win.getByTestId('vote-yourself').locator('summary').click();
    await win.getByTestId('vote-verify').click();
    const proof = win.getByTestId('vote-proof');
    await expect(proof.locator('li.ok')).toHaveCount(3);
    await expect(proof).toContainText('The signature is valid');
    await expect(proof).toContainText('The network has it as the current vote');
    await expect(win.getByRole('button', { name: 'Copy the gobject getcurrentvotes command' })).toBeVisible();
    await win.getByRole('button', { name: 'Dismiss' }).click();
    await expect(win).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('the success card is animated, and still with reduced motion', async ({ page }) => {
    await openPanel(page, 'auto');
    await voteWithFirst(page, 'No');
    const win = page.getByTestId('vote-success');
    await expect(win).toBeVisible({ timeout: 20_000 });
    expect(await win.locator('.vwin-tick').evaluate((e) => getComputedStyle(e).animationName)).toBe('vwin-draw');
    expect(await win.locator('.vwin-bit').first().evaluate((e) => getComputedStyle(e).display)).not.toBe('none');
  });
  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });
    test('no burst, no drawing: the finished check is shown at once', async ({ page }) => {
      await openPanel(page, 'auto');
      await voteWithFirst(page, 'No');
      const win = page.getByTestId('vote-success');
      await expect(win).toBeVisible({ timeout: 20_000 });
      expect(await win.locator('.vwin-tick').evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
      expect(await win.locator('.vwin-tick').evaluate((e) => getComputedStyle(e).strokeDashoffset)).toMatch(/^0(px)?$/);
      expect(await win.locator('.vwin-bit').first().evaluate((e) => getComputedStyle(e).display)).toBe('none');
    });
  });

  test('relay unreachable: kept in the browser, plain error, Retry now sends it once a relay is back', async ({ page }) => {
    await openPanel(page, 'down');
    const tracker = await voteWithFirst(page, 'No');
    await expect(tracker).toHaveAttribute('data-status', 'queued');
    await expect(tracker.getByTestId('vote-tracker-badge')).toHaveText('Not sent yet');
    await expect(tracker.getByTestId('vote-tracker-line')).toContainText('Not accepted by a relay yet: relay-');
    await expect(tracker.getByTestId('vote-tracker-line')).toContainText('Kept in this browser');
    await expect(tracker.locator('[data-step="relay"]')).toHaveAttribute('data-state', 'error');
    await expect(tracker.getByTestId('vote-retry')).toHaveText('Retry now (tries every relay)');
    await page.evaluate(() => (window as unknown as { __voteSim: { up(): void } }).__voteSim.up());
    await tracker.getByTestId('vote-retry').click();
    await expect(tracker).not.toHaveAttribute('data-status', 'queued', { timeout: 15_000 });
    await expect(page.getByTestId('vote-success')).toBeVisible({ timeout: 20_000 });
  });

  test('held for the one-hour rule: says so, with the time; then cancelled', async ({ page }) => {
    await openPanel(page, 'hour');
    const tracker = await voteWithFirst(page, 'Abstain');
    await expect(tracker).toHaveAttribute('data-status', 'held');
    await expect(tracker.getByTestId('vote-tracker-line')).toContainText(/Core allows one vote change per hour per masternode; relay-(one|two)\.example sends this at \d{1,2}:\d{2}/);
    await openMns(page);
    await expect(page.getByTestId('mn-vote-panel').getByTestId('pending-vote').first()).toContainText('Held by relay');
    await tracker.getByTestId('vote-cancel').click();
    await expect(page.getByTestId('vote-tracker')).toHaveCount(0);
  });

  test('my votes: grouped by proposal on the keyring page, with the new statuses', async ({ page }) => {
    await openPanel(page, 'manual');
    await voteWithFirst(page, 'No');
    await expect(page.getByTestId('vote-tracker').first()).toHaveAttribute('data-status', 'held');
    await page.getByRole('link', { name: 'My masternodes', exact: true }).click();
    const rows = page.getByTestId('watched-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-status', 'held');
    await expect(rows.first().getByTestId('watched-badge')).toHaveText('Held by relay');
    await expect(page.locator('.vgroup-title')).toHaveText('OrchardPay');
    await expect(page.getByTestId('relay-row').filter({ hasText: 'holds 1 of your votes' })).toHaveCount(1);
  });
});
