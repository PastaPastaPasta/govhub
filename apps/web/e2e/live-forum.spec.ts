// Opt-in live testnet run of the social features (npm run e2e:live, which builds with VITE_GOVHUB_DEV_SIGNIN=1):
// a real browser signs with the dev key-paste session as phase-0 spike identities and writes to the testnet forum and
// mod contracts. On a real proposal of the testnet gov contract (OrchardPay): comment, reply, react, flip, a
// moderator block on the default list and its removal, a user block and unblock, clearing the reaction and
// retracting both comments. Then a payment-address claim and an owner description on the synthetic proposal from
// scripts/testnet-claim-fixture.ts (the only proposal whose payout key we hold). Document ids and credits spent are
// written to e2e/live-results.json. Keys are read from ~/.local/share/govhub-phase0/testnet at run time.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { base58, base64 } from '@scure/base';
import { signMessageWif } from '@govhub/verify';
import { connect, spikeIdentity } from '../scripts/live-lib.ts';
import { cspViolations, watchPage } from './helpers.ts';

test.skip(!process.env.GOVHUB_LIVE, 'set GOVHUB_LIVE=1 to write to testnet');

const FORUM = 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw';
const MOD = 'CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY';
const CLAIM_KEY_FILE = `${process.env.HOME}/.local/share/govhub-phase0/testnet/claim-test.json`;
const WRITE = { timeout: 120_000 };

/** Sessions live in tab memory: a reload signs out, and switching identity signs out first. */
async function signIn(page: Page, who: { identityId: string; highKeyHex: string }) {
  if ((await page.getByTestId('session-button').innerText()).trim() !== 'Sign in') await signOut(page);
  await page.getByTestId('session-button').click();
  const dialog = page.locator('dialog[open]');
  await dialog.getByLabel('Identity id').fill(who.identityId);
  await dialog.getByLabel(/Private key/).fill(who.highKeyHex);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('session-button')).toContainText(who.identityId.slice(0, 4), { timeout: 120_000 });
}
async function signOut(page: Page) {
  await page.getByTestId('session-button').click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByTestId('session-button')).toHaveText('Sign in');
}
const comment = (page: Page, text: string) => page.locator('li.comment', { has: page.locator(':scope > article', { hasText: text }) });
const own = (li: ReturnType<typeof comment>) => li.locator(':scope > article');

test('@live forum on testnet: comment, reply, react, flip, block, unblock, retract, claim, owner post', async ({ page }) => {
  test.setTimeout(900_000);
  expect(existsSync(CLAIM_KEY_FILE), 'run scripts/testnet-claim-fixture.ts first').toBe(true);
  const claimKey = JSON.parse(readFileSync(CLAIM_KEY_FILE, 'utf8')) as { wif: string; address: string; govHash: string; docId: string };
  const errors = await watchPage(page);
  const { sdk, stableBalance } = await connect();
  const u6 = spikeIdentity('u6');
  const mod = spikeIdentity('owner');
  const before = { u6: await stableBalance(u6.identityId), moderator: await stableBalance(mod.identityId) };
  const docs: Record<string, string> = {};
  /** A proven query from Node, retried until it returns something (nodes lag right after a write). */
  const q = async (contract: string, documentTypeName: string, where: unknown[], orderBy?: unknown[]) => {
    for (let i = 0; ; i++) {
      const r = await sdk.documents.queryWithProof({ dataContractId: contract, documentTypeName, where, ...(orderBy ? { orderBy } : {}), limit: 100 } as never);
      const docs = [...r.data.values()].filter(Boolean).map((x) => x!.toJSON() as Record<string, unknown>);
      if (docs.length || i >= 20) return docs;
      await new Promise((res) => setTimeout(res, 3000));
    }
  };

  // ---- comment and reply as u6 on a real proposal ------------------------------------------------------------------
  await page.goto('/p/OrchardPay?fixtures=0');
  const d = page.getByTestId('discussion');
  await expect(d.locator('#discussion-title .count')).toBeVisible({ timeout: 180_000 });
  await signIn(page, u6);
  const stamp = new Date().toISOString();
  const text = `govhub live e2e ${stamp}: comment`;
  await d.getByRole('textbox', { name: 'Post comment' }).fill(`${text} with **markdown**`);
  await expect(d.getByTestId('composer-meta').first()).toContainText(/costs about 0\.000\d+ DASH · your balance 0\.\d+ DASH/);
  await d.getByRole('button', { name: 'Post comment' }).click();
  const c1 = comment(page, text);
  await expect(c1).toBeVisible(WRITE);
  docs.comment = (await c1.getAttribute('data-comment-id'))!;
  await own(c1).getByRole('button', { name: 'Reply' }).click();
  const replyText = `govhub live e2e ${stamp}: reply`;
  await own(c1).getByRole('textbox', { name: 'Post reply' }).fill(replyText);
  await own(c1).getByRole('button', { name: 'Post reply' }).click();
  const r1 = comment(page, replyText);
  await expect(c1.locator('.replies').locator('li.comment', { hasText: replyText })).toBeVisible(WRITE);
  docs.reply = (await r1.getAttribute('data-comment-id'))!;

  // Read back from Platform after a reload: threading and the deep link.
  await expect(async () => {
    await page.goto(`/p/OrchardPay?fixtures=0&comment=${docs.reply}`);
    await expect(page.locator(`#comment-${docs.reply}.comment-focus`)).toBeVisible({ timeout: 60_000 });
  }).toPass({ timeout: 240_000 });
  await expect(comment(page, text).locator('.replies')).toContainText(replyText);
  await expect(comment(page, text).locator('strong', { hasText: 'markdown' })).toBeVisible();

  // ---- reactions as the moderator identity: first vote, flip ------------------------------------------------------
  await signIn(page, mod);
  const score = own(comment(page, text)).locator('.vote-score');
  await own(comment(page, text)).locator('.vote-up').click();
  await expect(score).toHaveText('+1', WRITE);
  await own(comment(page, text)).locator('.vote-down').click();
  await expect(score).toHaveText('−1', WRITE);
  const target = base64.encode(base58.decode(docs.comment));
  await expect(async () => {
    const reactions = await q(FORUM, 'reaction', [['$ownerId', '==', mod.identityId], ['target', '==', target]]);
    expect(reactions[0]).toMatchObject({ value: -1, $revision: 2 }); // flipped by replace, not a second document
    docs.reaction = String(reactions[0]!.$id);
  }).toPass({ timeout: 120_000, intervals: [3_000] });

  // ---- moderator: the reply onto the default list (mod.block, kind document), then off again ---------------------
  await own(comment(page, replyText)).getByText('Hide…').click();
  await own(comment(page, replyText)).getByRole('button', { name: 'Add comment to the default list' }).click();
  await expect(comment(page, replyText)).toHaveCount(0, WRITE);
  const modBlocks = await q(MOD, 'block', [['$ownerId', '==', mod.identityId], ['target', 'in', [docs.reply]]], [['$ownerId', 'asc'], ['target', 'asc']]);
  docs.modBlock = String(modBlocks[0]?.$id);
  await expect(async () => {
    await page.reload();
    await expect(d.getByTestId('toggle-hidden')).toBeVisible({ timeout: 60_000 });
    await expect(comment(page, replyText)).toHaveCount(0);
  }).toPass({ timeout: 240_000 });
  await signIn(page, mod);
  await d.getByTestId('toggle-hidden').click();
  await expect(comment(page, replyText)).toContainText('comment on govhub moderation', { timeout: 60_000 });
  await own(comment(page, replyText)).getByText('Hide…').click();
  await own(comment(page, replyText)).getByRole('button', { name: 'Remove from the default list' }).click();
  await expect(comment(page, replyText).locator('.hidden-note')).toHaveCount(0, WRITE);

  // ---- user block: hide everything by u6 for the moderator identity's own list, then unblock ----------------------
  await own(comment(page, text)).getByText('Hide…').click();
  await own(comment(page, text)).getByRole('button', { name: 'Hide everything by this author' }).click();
  await expect(comment(page, text).locator(':scope > article .hidden-note')).toContainText('author on your blocks', WRITE);
  const userBlocks = await q(FORUM, 'block', [['$ownerId', '==', mod.identityId], ['target', 'in', [u6.identityId]]], [['$ownerId', 'asc'], ['target', 'asc']]);
  docs.userBlock = String(userBlocks[0]?.$id);
  await own(comment(page, text)).getByText('Hide…').click();
  await own(comment(page, text)).getByRole('button', { name: /Unblock/ }).click();
  await expect(comment(page, text).locator(':scope > article .hidden-note')).toHaveCount(0, WRITE);

  // Clear the reaction (delete refunds most of it).
  await own(comment(page, text)).locator('.vote-down').click();
  await expect(score).toHaveText('0', WRITE);

  // ---- retract both comments as u6 --------------------------------------------------------------------------------
  await signIn(page, u6);
  for (const t of [replyText, text]) {
    await own(comment(page, t)).getByRole('button', { name: 'Retract' }).click();
    await own(comment(page, t)).getByRole('button', { name: /Confirm: delete/ }).click();
    await expect(comment(page, t)).toHaveCount(0, WRITE);
  }

  // ---- payment-address claim on the synthetic proposal, then the owner's description ------------------------------
  await page.goto(`/p/h/${claimKey.govHash}?fixtures=0`);
  await expect(page.getByRole('heading', { level: 1, name: 'govhub-claim-test' })).toBeVisible({ timeout: 180_000 });
  await signIn(page, u6);
  const owner = page.getByTestId('owner');
  if ((await owner.count()) === 0 || (await owner.getAttribute('data-owner')) !== u6.identityId) {
    const panel = page.getByTestId('claim-panel');
    await panel.locator('summary').click();
    const message = (await panel.getByTestId('claim-message').innerText()).trim();
    expect(message).toBe(`govhub-claim|mainnet|${claimKey.govHash}|${u6.identityId}`);
    // What Dash Core's signmessage would print for this key (byte-identical, see packages/verify message tests).
    await panel.getByLabel(/Signature/).fill(signMessageWif(claimKey.wif, message, 'mainnet'));
    await expect(panel.getByTestId('claim-sig-status')).toContainText(`Signature checks out for ${claimKey.address}`);
    await panel.getByRole('button', { name: 'Publish claim' }).click();
  }
  await expect(async () => {
    await expect(owner).toHaveAttribute('data-owner', u6.identityId, { timeout: 30_000 });
  }).toPass({ timeout: 240_000, intervals: [5_000] });
  await expect(owner).toHaveAttribute('data-method', '2');
  const claims = await q(FORUM, 'claim', [['govHash', '==', base64.encode(Buffer.from(claimKey.govHash, 'hex'))]], [['govHash', 'asc'], ['$createdAt', 'asc']]);
  docs.claim = String(claims.find((c) => c.$ownerId === u6.identityId)?.$id);

  const post = page.getByTestId('owner-post');
  await post.getByRole('button', { name: /description/ }).click();
  const title = `Live claim test ${stamp}`;
  await post.getByLabel('Title').fill(title);
  await post.getByLabel('Description (markdown)').fill(`Written by the live e2e run at ${stamp}.\n\n- deflated into **b0**\n- shown in place of the raw fields`);
  await expect(post.getByTestId('post-meta')).toContainText('(1 of 3 fields)');
  await post.getByRole('button', { name: 'Publish description' }).click();
  await expect(post.getByRole('heading', { name: title })).toBeVisible(WRITE);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('owner-post').getByRole('heading', { name: title })).toBeVisible({ timeout: 60_000 });
  }).toPass({ timeout: 240_000 });
  await expect(page.locator('details.raw-collapsed')).toBeVisible();
  const posts = await q(FORUM, 'proposalPost', [['govHash', '==', base64.encode(Buffer.from(claimKey.govHash, 'hex'))], ['$ownerId', '==', u6.identityId]]);
  docs.proposalPost = String(posts[0]?.$id);

  // ---- credits ------------------------------------------------------------------------------------------------------
  const after = { u6: await stableBalance(u6.identityId), moderator: await stableBalance(mod.identityId) };
  const spent = { u6: before.u6 - after.u6, moderator: before.moderator - after.moderator };
  const results = {
    ranAt: stamp,
    proposal: 'OrchardPay (8410614191c3f2df69a224a1c34ebc745288700515fdece6ad3764bfc1c987fe) in testnet gov 3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ',
    claimProposal: { name: 'govhub-claim-test', govHash: claimKey.govHash, docId: claimKey.docId, paymentAddress: claimKey.address },
    identities: { u6: u6.identityId, moderator: mod.identityId },
    docs,
    credits: { u6: spent.u6.toString(), moderator: spent.moderator.toString(), total: (spent.u6 + spent.moderator).toString() },
    tDash: { u6: Number(spent.u6) / 1e11, moderator: Number(spent.moderator) / 1e11, total: Number(spent.u6 + spent.moderator) / 1e11 },
    notes: 'comment, reply, reaction, both blocks were deleted again (deletes refund storage); claim and proposalPost stay as test fixtures',
  };
  writeFileSync(new URL('./live-results.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
  console.log(`live forum: ${JSON.stringify(results)}`);
  expect(errors).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});
