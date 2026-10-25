// The proposal-creation wizard end to end in fixture mode: a simulated payment and a simulated relay, everything else real (Core's
// rules on the exact bytes, the schedule, the backup file, the collateral transaction built and checked in the browser).
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { cspViolations, gotoFixtures, watchPage } from './helpers.ts';

async function signInAs(page: Page, who: RegExp) {
  await page.getByTestId('session-button').click();
  await page.getByRole('button', { name: who }).click();
  await expect(page.getByTestId('session-button')).not.toHaveText('Sign in');
}

async function fillDetails(page: Page, name: string) {
  await page.getByTestId('p-name').fill(name);
  await page.getByTestId('p-address').fill('XdWkmFKNosQvS1iPdof7SVme5Gd2GDsa62');
}

test.describe('create a proposal (fixtures)', () => {
  test('details → payments → review → backup → pay in the browser → relay submits → live; resume from the backup', async ({ page }, info) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/create');
    await expect(page.getByTestId('p-start')).toBeVisible();
    await expect(page.getByTestId('p-cost')).toContainText('Cost: 1 DASH');
    await page.getByTestId('p-new').click();

    // Details: Core's name rule and the address check, live
    await page.getByTestId('p-name').fill('bad name!');
    await page.getByTestId('p-name').blur();
    await expect(page.getByTestId('p-name-error')).toContainText('invalid characters');
    await fillDetails(page, 'govhub-wizard-demo');
    await expect(page.getByTestId('p-name-error')).toHaveCount(0);
    // the govhub URL needs a sign-in
    await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
    await signInAs(page, /^Alice$/);
    await expect(page.getByTestId('p-url-preview')).toContainText('https://gov.dashhq.org/p/');
    await expect(page.getByTestId('p-url-preview')).toContainText('/govhub-wizard-demo');
    await page.getByTestId('p-next').click();

    // Payments: superblock-aligned schedule, total, budget check
    await page.getByTestId('p-amount').fill('12.5');
    const first = page.getByTestId('p-first');
    const options = await first.locator('option:not([disabled])').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    expect(options.length).toBeGreaterThan(3);
    await first.selectOption(options[1]!);
    await page.getByTestId('p-count').fill('3');
    await expect(page.getByTestId('p-total')).toHaveText('37.5 DASH');
    await expect(page.getByTestId('p-summary').locator('.pw-dates li')).toHaveCount(3);
    await expect(page.getByTestId('p-deadline')).toContainText('Masternodes must vote yes before block');
    // more than a superblock can ever pay is refused
    await page.getByTestId('p-amount').fill('100000');
    await expect(page.getByTestId('p-amount-error')).toContainText('could never be paid');
    await page.getByTestId('p-amount').fill('12.5');
    await page.getByTestId('p-next').click();

    // Review: Core's checks on the exact bytes, the JSON, then lock
    await expect(page.getByTestId('p-core-ok')).toContainText("Passes Dash Core's proposal checks");
    const json = await page.getByTestId('p-json').textContent();
    expect(JSON.parse(json!)).toMatchObject({ name: 'govhub-wizard-demo', payment_address: 'XdWkmFKNosQvS1iPdof7SVme5Gd2GDsa62', payment_amount: 12.5, type: 1 });
    expect(Object.keys(JSON.parse(json!))).toEqual(['end_epoch', 'name', 'payment_address', 'payment_amount', 'start_epoch', 'type', 'url']);
    await page.getByTestId('p-lock').click();

    // Pay: nothing before the backup
    await expect(page.getByTestId('p-pay')).toBeVisible();
    await expect(page.getByTestId('p-pay-browser')).toHaveCount(0);
    const dl = page.waitForEvent('download');
    await page.getByTestId('p-backup-download').click();
    const backupPath = info.outputPath('backup-before-payment.json');
    await (await dl).saveAs(backupPath);
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
    expect(backup.format).toBe('govhub-proposal-backup');
    expect(backup.commands.prepare).toMatch(/^gobject prepare 0 1 \d+ [0-9a-f]+$/);
    expect(backup.collateralTxid).toBeNull();
    expect(JSON.stringify(backup)).not.toMatch(/privateKey|phrase"/);
    const govHash: string = backup.govHash;

    await page.getByTestId('p-pay-browser').click();
    await expect(page.getByTestId('p-refund')).not.toHaveValue('');
    await page.getByTestId('p-pay-start').click();
    await expect(page.getByTestId('p-deposit-address')).toBeVisible();
    await expect(page.getByTestId('p-deposit-amount')).toHaveText('1.00001 DASH');
    await page.getByTestId('p-demo-pay').click();

    // Submit: confirmations, the relay holds it and submits at 6, seen by the network, on govhub → celebration
    await expect(page.getByTestId('p-submit')).toBeVisible();
    await expect(page.getByTestId('p-submit-cmd')).toHaveText(new RegExp(`^gobject submit 0 1 \\d+ [0-9a-f]+ [0-9a-f]{64}$`));
    await expect(page.getByTestId('p-stage-submitted')).toContainText('holds it and submits it at 6 confirmations');
    await expect(page.getByTestId('p-stage-confs')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await expect(page.getByTestId('p-live')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('p-stage-published')).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('p-govhash')).toHaveText(govHash);
    await expect(page.getByTestId('p-view')).toHaveAttribute('href', new RegExp(`/p/h/${govHash}$`));
    await expect(page.getByTestId('p-claim')).toBeVisible();

    // the updated backup carries the collateral; restoring it in a fresh browser resumes the same proposal
    const dl2 = page.waitForEvent('download');
    await page.getByTestId('p-backup-download').click();
    const paidPath = info.outputPath('backup-paid.json');
    await (await dl2).saveAs(paidPath);
    const paid = JSON.parse(readFileSync(paidPath, 'utf8'));
    expect(paid.collateralTxid).toMatch(/^[0-9a-f]{64}$/);
    expect(paid.commands.submit).toContain(paid.collateralTxid);

    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('govhub.proposalDraft.')) localStorage.removeItem(k);
    });
    await gotoFixtures(page, '/create');
    await expect(page.getByTestId('p-drafts')).toHaveCount(0);
    await page.getByTestId('p-restore-file').setInputFiles(paidPath);
    await expect(page.getByTestId('p-wizard')).toHaveAttribute('data-stage', /submit|done/);
    await expect(page.getByTestId('p-govhash')).toHaveText(govHash);

    // an altered backup is refused
    const tampered = info.outputPath('tampered.json');
    const t = JSON.parse(readFileSync(backupPath, 'utf8'));
    t.draft.lock.time += 1;
    writeFileSync(tampered, JSON.stringify(t));
    await gotoFixtures(page, '/create');
    await page.getByTestId('p-restore-file').setInputFiles(tampered);
    await expect(page.getByTestId('p-restore-error')).toContainText('altered');

    expect(errors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('pay with Dash Core: the exact prepare command, and a txid that does not pay this proposal is refused', async ({ page }) => {
    await gotoFixtures(page, '/create');
    await page.getByTestId('p-new').click();
    await fillDetails(page, 'core-path-demo');
    await page.getByTestId('p-url-custom').check();
    await page.getByTestId('p-url').fill('https://forum.example.org/t/core-path-demo');
    await page.getByTestId('p-next').click();
    await page.getByTestId('p-amount').fill('1');
    const first = page.getByTestId('p-first');
    const v = await first.locator('option:not([disabled])').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean)[0]);
    await first.selectOption(v!);
    await page.getByTestId('p-next').click();
    await page.getByTestId('p-lock').click();
    await page.getByTestId('p-backup-download').click();
    await page.getByTestId('p-pay-core').click();
    await expect(page.getByTestId('p-prepare')).toHaveText(/^gobject prepare 0 1 \d+ [0-9a-f]+$/);
    await page.getByTestId('p-txid').fill('ab'.repeat(32));
    await page.getByTestId('p-txid-check').click();
    await expect(page.getByText('No DAPI node knows this transaction yet')).toBeVisible();
    await expect(page.getByTestId('p-wizard')).toHaveAttribute('data-stage', 'pay');
  });

  test('mobile width: the steps and fields fit', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await gotoFixtures(page, '/create');
    await page.getByTestId('p-new').click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('p-name')).toBeVisible();
  });
});
