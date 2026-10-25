// Opt-in live TESTNET run of the whole sign-in story in headless Chromium (GOVHUB_LIVE_AUTH=1 npm run e2e:auth):
//   create a phrase -> pay the QR address from the QA wallet -> identity created -> sign out -> sign in with the phrase ->
//   add a passkey (CDP virtual authenticator with PRF) -> sign out -> sign in with the passkey -> top up -> redeem a voucher.
// The QA wallet (tooling, packages/auth/scripts/qa-funder.ts) plays the user's external wallet. Spends real tDASH; results without
// secrets go to e2e/results/auth-live.json. The phrase is kept only in ~/.local/share/govhub-phase2/ (0600) for later inspection.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createDapi } from '@govhub/dapi';
import { decodeAddress } from '@govhub/verify';
import { PHASE2_DIR, qaFunder, writePrivate } from '../../../packages/auth/scripts/qa-funder.ts';
import { cspViolations, watchPage } from './helpers.ts';

test.skip(!process.env.GOVHUB_LIVE_AUTH, 'set GOVHUB_LIVE_AUTH=1 to run the live testnet sign-in flow (spends tDASH)');
test.setTimeout(15 * 60_000);

const dapi = createDapi({ network: 'testnet' });
const funder = qaFunder(dapi);
const credits = (t: string) => Math.round(Number(t.replace(/[^0-9.]/g, '')) * 1e11);

const panel = (page: Page) => page.locator('dialog[open]');
async function signedIn(page: Page, timeout: number) {
  await expect(page.getByTestId('session-button')).not.toHaveText('Sign in', { timeout });
}
async function openAccount(page: Page) {
  await page.getByTestId('session-button').click();
  await expect(page.getByTestId('session-identity')).toBeVisible();
}
async function closeAccount(page: Page) {
  await panel(page).getByRole('button', { name: 'Close', exact: true }).click();
}
async function identity(page: Page): Promise<string> {
  await openAccount(page);
  const id = (await page.getByTestId('session-identity').innerText()).trim();
  await closeAccount(page);
  return id;
}
async function balance(page: Page): Promise<number> {
  await openAccount(page);
  await expect(page.getByTestId('session-balance')).not.toHaveText('reading…', { timeout: 60_000 });
  const b = credits(await page.getByTestId('session-balance').innerText());
  await closeAccount(page);
  return b;
}
async function signOut(page: Page) {
  await openAccount(page);
  await panel(page).getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
}
async function accountAction(page: Page, name: 'Top up' | 'Add passkey') {
  await openAccount(page);
  await panel(page).getByRole('button', { name }).click();
}
async function payDepositAddress(page: Page, duffs: bigint) {
  const address = (await page.getByTestId('deposit-address').innerText({ timeout: 120_000 })).trim();
  const h = decodeAddress(address, 'testnet');
  if (!h) throw new Error(`not a testnet address: ${address}`);
  return funder.pay(h.hash160, duffs, `e2e deposit to ${address}`);
}

test('@live-auth create, fund, sign in with phrase, passkey and top up on testnet', async ({ page }) => {
  const errors = await watchPage(page);
  const t0 = Date.now();
  const spentBefore = funder.state();
  const results: Record<string, unknown> = { network: 'testnet', at: new Date().toISOString() };
  page.on('console', (m) => m.type() === 'error' && console.log(`console.error: ${m.text().slice(0, 300)}`));

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });

  // Fixture mode keeps the governance pages offline; sign-in and funding always use the live testnet Platform and DAPI.
  await page.goto('/?fixtures=1');

  // ---- 1. create: phrase, quiz, pay the QR address ----
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Create a new identity/ }).click();
  const phrase = (await page.getByTestId('phrase-words').locator('li').allInnerTexts()).map((t) => t.trim().split(/\s+/)[1]!);
  expect(phrase).toHaveLength(12);
  writePrivate(join(PHASE2_DIR, 'e2e-phrase.json'), { phrase: phrase.join(' '), at: new Date().toISOString() });
  await page.getByRole('button', { name: 'I wrote it down' }).click();
  for (const i of await page.locator('[data-testid^="quiz-"]').all()) await i.fill(phrase[Number((await i.getAttribute('data-testid'))!.slice(5)) - 1]!);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /Pay with DASH/ }).click();
  const tCreate = Date.now();
  results.depositTxid = await payDepositAddress(page, 500_000n);
  await signedIn(page, 5 * 60_000);
  results.createSeconds = Math.round((Date.now() - tCreate) / 1000);
  const identityId = await identity(page);
  results.identityId = identityId;
  results.balanceAfterCreate = await balance(page);
  console.log(`created ${identityId} in ${results.createSeconds} s`);

  // ---- 2. sign out, sign in with the phrase ----
  await signOut(page);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /I have a recovery phrase/ }).click();
  await page.getByTestId('phrase-input').fill(phrase.join(' '));
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await signedIn(page, 120_000);
  expect(await identity(page)).toBe(identityId);

  // ---- 3. add a passkey (PRF) ----
  await accountAction(page, 'Add passkey');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await page.getByRole('button', { name: 'Confirm with the passkey' }).click();
  await expect(page.getByTestId('passkey-saved')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText('this device')).toBeVisible({ timeout: 60_000 });
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  expect(credentials).toHaveLength(1);
  expect(credentials[0]!.isResidentCredential).toBe(true);
  await page.keyboard.press('Escape');
  results.balanceAfterPasskey = await balance(page);

  // ---- 4. sign out, sign in with the passkey ----
  await signOut(page);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Use a passkey/ }).click();
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  await signedIn(page, 120_000);
  await openAccount(page);
  await expect(page.getByTestId('session-identity')).toHaveText(identityId);
  await expect(panel(page)).toContainText('passkey, key 2');
  await closeAccount(page);

  // ---- 5. top up from the passkey session (its bundle is the seed: DIP-13 top-up key) ----
  await accountAction(page, 'Top up');
  const tTop = Date.now();
  results.topUpDepositTxid = await payDepositAddress(page, 100_000n);
  await expect(page.getByText('Top-up complete')).toBeVisible({ timeout: 5 * 60_000 });
  results.topUpSeconds = Math.round((Date.now() - tTop) / 1000);
  await page.getByRole('button', { name: 'Close' }).last().click();
  results.balanceAfterTopUp = await balance(page);

  // ---- 6. a second identity from a voucher (burn at vout 1, chain-lock proof), in a fresh phrase ----
  await signOut(page);
  const voucher = await funder.mintVoucher(300_000n);
  results.voucherTxid = voucher.txid;
  results.voucherBurnVout = voucher.burnVout;
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Create a new identity/ }).click();
  const phrase2 = (await page.getByTestId('phrase-words').locator('li').allInnerTexts()).map((t) => t.trim().split(/\s+/)[1]!);
  writePrivate(join(PHASE2_DIR, 'e2e-phrase-voucher.json'), { phrase: phrase2.join(' '), at: new Date().toISOString() });
  await page.getByRole('button', { name: 'I wrote it down' }).click();
  for (const i of await page.locator('[data-testid^="quiz-"]').all()) await i.fill(phrase2[Number((await i.getAttribute('data-testid'))!.slice(5)) - 1]!);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /I have a voucher link/ }).click();
  await page.getByPlaceholder(/dashpay:\/\/invite/).fill(voucher.link);
  const tV = Date.now();
  await page.getByRole('button', { name: 'Redeem' }).click();
  await signedIn(page, 10 * 60_000);
  results.voucherSeconds = Math.round((Date.now() - tV) / 1000);
  results.voucherIdentityId = await identity(page);
  results.voucherIdentityBalance = await balance(page);

  // Exact balances from Platform (proved reads in Node), for the credits-spent ledger.
  const evo = await import('@dashevo/evo-sdk');
  await evo.ensureInitialized?.();
  const sdk = evo.EvoSDK.testnetTrusted({ settings: { timeoutMs: 40000, retries: 2 } });
  await sdk.connect();
  const exact: Record<string, string> = {};
  for (const id of [identityId, results.voucherIdentityId as string]) exact[id] = String((await sdk.identities.balanceWithProof(id)).data ?? 0n);
  results.finalBalancesCredits = exact;
  const spent = funder.state();
  results.tDashSentFromQaWallet = Number(spent.spentDuffs - spentBefore.spentDuffs) / 1e8;
  results.l1FeesDuffs = Number(spent.feesDuffs - spentBefore.feesDuffs);
  // What the QA wallet sent, minus its own tx fees, went into asset locks; what is not on the two identities now was spent on
  // Platform (two identity creates, the passkey vault write, the top-up processing fee) or on the two asset-lock tx fees (~200 duffs each).
  const lockedCredits = (spent.spentDuffs - spentBefore.spentDuffs) * 1000n;
  results.spentCreditsIncludingAssetLockTxFees = String(lockedCredits - Object.values(exact).reduce((a, b) => a + BigInt(b), 0n));
  results.totalSeconds = Math.round((Date.now() - t0) / 1000);
  mkdirSync('e2e/results', { recursive: true });
  writeFileSync('e2e/results/auth-live.json', JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results));

  expect(errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});
