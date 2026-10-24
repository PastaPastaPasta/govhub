// Social features end to end in fixture mode: the sample discussion lives in an in-memory store that runs the same
// linted queries and DocumentOps as Platform, and sign-in picks a sample identity.
import { expect, test, type Page } from '@playwright/test';
import { cspViolations, gotoFixtures, watchPage } from './helpers.ts';

async function signInAs(page: Page, who: RegExp) {
  await page.getByTestId('session-button').click();
  await page.getByRole('button', { name: who }).click();
  await expect(page.getByTestId('session-button')).not.toHaveText('Sign in');
}
const comment = (page: Page, text: string | RegExp) => page.locator('li.comment', { has: page.locator(':scope > article', { hasText: text }) });

test.describe('discussion (fixtures)', () => {
  test('threads, sanitised markdown, moderation toggle, filter and deep links', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/p/OrchardPay');
    const d = page.getByTestId('discussion');
    await expect(d.locator('li.comment')).toHaveCount(5);

    // Threading: Carol replies to Bob, who replies to Alice; the orphan is a root with a note.
    const alice = comment(page, 'Strong proposal');
    await expect(alice.locator('.replies .replies li.comment', { hasText: 'Section 4' })).toHaveCount(1);
    await expect(comment(page, 'Following up')).toContainText('reply to a comment that is no longer available');
    await expect(alice.locator(':scope > article .vote-score')).toHaveText('+1'); // 2 up, 1 down; the blocked spammer's down-vote is not counted

    // Sanitiser: raw HTML is text, javascript: links lose their href, images are links, nothing executes.
    const markup = comment(page, 'Quick test');
    await expect(markup).toContainText('<script>alert("xss")</script>');
    await expect(markup.locator('script, img, iframe')).toHaveCount(0);
    await expect(markup.locator('a', { hasText: 'javascript' })).toHaveCount(0);
    await expect(markup.locator('.md-badlink', { hasText: 'a javascript: link' })).toBeVisible();
    await expect(markup.locator('a.md-image')).toHaveAttribute('href', 'https://evil.example/pixel.png');
    await expect(alice.locator('a.md-link')).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');

    // The default list hides the spammer; "show hidden (1)" reveals it with the reason.
    await expect(d).not.toContainText('FREE DASH!!!');
    await d.getByTestId('toggle-hidden').click();
    const spam = comment(page, 'FREE DASH!!!');
    await expect(spam).toContainText('author on govhub moderation (spam)');
    await d.getByTestId('toggle-hidden').click();
    await expect(spam).toHaveCount(0);

    // Filter: owner + MN owners (no badges yet, no owner) hides everyone; "show all" is one click.
    await d.getByText('Proposal owner + MN owners').click();
    await expect(d.locator('li.comment:not(.comment-placeholder)')).toHaveCount(0);
    await d.getByTestId('show-all').click();
    await expect(d.locator('li.comment:not(.comment-placeholder)')).toHaveCount(5);

    // Deep link to a blocked comment: focused, but still behind its placeholder; one click reveals it.
    await d.getByTestId('toggle-hidden').click();
    const spamId = await comment(page, 'FREE DASH!!!').getAttribute('data-comment-id');
    await gotoFixtures(page, `/p/OrchardPay?comment=${spamId}`);
    const linked = page.locator(`#comment-${spamId}`);
    await expect(linked).toHaveClass(/comment-focus/);
    await expect(linked).toContainText('Hidden: on govhub moderation');
    await expect(linked).not.toContainText('FREE DASH!!!');
    await linked.getByRole('button', { name: 'Show this comment' }).click();
    await expect(page.locator(`#comment-${spamId}`)).toContainText('FREE DASH!!!');

    expect(errors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('post, reply, react, flip, clear, block, unblock and retract as a signed-in identity', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/p/OrchardPay');
    await expect(page.getByRole('button', { name: 'Sign in to comment' })).toBeVisible();
    await signInAs(page, /^Alice$/);
    const d = page.getByTestId('discussion');

    // Cost and balance are shown before posting.
    await d.getByRole('textbox', { name: 'Post comment' }).fill('Fixture **comment** from Alice');
    await expect(d.getByTestId('composer-meta').first()).toContainText(/costs about 0\.0004\d DASH/);
    await expect(d.getByTestId('composer-meta').first()).toContainText('your balance 0.003 DASH');
    await d.getByRole('button', { name: 'Post comment' }).click();
    const mine = comment(page, 'Fixture comment from Alice');
    await expect(mine).toBeVisible();
    await expect(mine.locator('strong')).toHaveText('comment');

    // Reply nests under it.
    await mine.getByRole('button', { name: 'Reply' }).first().click();
    await mine.getByRole('textbox', { name: 'Post reply' }).fill('and a reply');
    await mine.getByRole('button', { name: 'Post reply' }).click();
    await expect(mine.locator('.replies li.comment', { hasText: 'and a reply' })).toBeVisible();

    // React on Bob's comment: first vote, flip, clear; each button says what it costs.
    const bob = comment(page, 'who audits');
    const up = bob.locator(':scope > article .vote-up');
    await expect(up).toHaveAttribute('title', /a first vote costs about 0\.0005 DASH/);
    await up.click();
    await expect(bob.locator(':scope > article .vote-score')).toHaveText('+1');
    const down = bob.locator(':scope > article .vote-down');
    await expect(down).toHaveAttribute('title', /flipping your vote costs about 0\.000032 DASH/);
    await down.click();
    await expect(bob.locator(':scope > article .vote-score')).toHaveText('−1');
    await expect(down).toHaveAttribute('aria-pressed', 'true');
    await down.click();
    await expect(bob.locator(':scope > article .vote-score')).toHaveText('0');

    // Community vote on the proposal.
    const cv = page.getByTestId('community-vote');
    await cv.locator('.vote-up').click();
    await expect(cv.locator('.vote-score')).toHaveText('+2');

    // Block Bob for me (hide, not delete), then unblock.
    await bob.locator(':scope > article').getByText('Hide…').click();
    await bob.getByRole('button', { name: 'Hide everything by this author' }).click();
    await expect(d.getByTestId('toggle-hidden')).toHaveText('Show hidden (3)');
    await expect(d).not.toContainText('who audits');
    await d.getByTestId('toggle-hidden').click();
    await expect(comment(page, 'who audits')).toContainText('author on your blocks');
    const bob2 = comment(page, 'who audits');
    await bob2.locator(':scope > article').getByText('Hide…').click();
    await bob2.getByRole('button', { name: /Unblock/ }).click();
    await expect(d.getByTestId('toggle-hidden')).toHaveText(/\(1\)/);

    // Retract asks for a second click, then the comment is gone (its reply becomes an orphan).
    await mine.locator(':scope > article').getByRole('button', { name: 'Retract' }).click();
    await mine.getByRole('button', { name: /Confirm: delete/ }).click();
    await expect(comment(page, 'Fixture comment from Alice')).toHaveCount(0);
    await expect(comment(page, 'and a reply')).toContainText('no longer available');

    // The pretend balance went down.
    await page.getByTestId('session-button').click();
    await expect(page.getByTestId('session-balance')).not.toHaveText('0.003 DASH');
    expect(errors).toEqual([]);
  });

  test('moderator adds a comment to the default list and removes it', async ({ page }) => {
    await gotoFixtures(page, '/p/OrchardPay');
    await signInAs(page, /Moderator/);
    const d = page.getByTestId('discussion');
    const markup = comment(page, 'Quick test');
    await markup.locator(':scope > article').getByText('Hide…').click();
    await markup.getByRole('button', { name: 'Add comment to the default list' }).click();
    await expect(d.getByTestId('toggle-hidden')).toHaveText('Show hidden (2)');
    await d.getByTestId('toggle-hidden').click();
    const hidden = comment(page, 'Quick test');
    await expect(hidden).toContainText('comment on govhub moderation');
    await hidden.locator(':scope > article').getByText('Hide…').click();
    await hidden.getByRole('button', { name: 'Remove from the default list' }).click();
    await expect(d.getByTestId('toggle-hidden')).toHaveText(/\(1\)/);
  });

  test('ownership: attestation owner, owner label, owner post and its editor; claim UI checks signatures', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/p/dash-growth-q4-2026');
    const owner = page.getByTestId('owner');
    await expect(owner).toHaveAttribute('data-method', '4');
    await expect(owner).toContainText('Dash Growth team');
    await expect(owner).toContainText('attestation by the hosting team');
    await expect(comment(page, 'Cost per funded wallet').locator('.chip-owner')).toHaveText('proposal owner');
    const post = page.getByTestId('owner-post');
    await expect(post.getByRole('heading', { name: 'Dash growth, Q4 2026' })).toBeVisible();
    await expect(post.locator('table td', { hasText: '420' })).toBeVisible();
    await expect(page.locator('details.raw-collapsed > summary')).toHaveText(/Raw proposal data/);

    await signInAs(page, /Dash Growth team/);
    await post.getByRole('button', { name: 'Edit the description' }).click();
    await post.getByLabel('Title').fill('Dash growth, Q4 2026 (updated)');
    await post.getByLabel('Description (markdown)').fill('## Update\n\nNow with **numbers**.');
    await expect(post.getByTestId('post-meta')).toContainText('of 15,360 bytes after compression (1 of 3 fields)');
    await post.getByRole('button', { name: 'Publish description' }).click();
    await expect(post.getByRole('heading', { name: 'Dash growth, Q4 2026 (updated)' })).toBeVisible();
    await expect(post.locator('strong', { hasText: 'numbers' })).toBeVisible();

    // Claim UI on an unclaimed proposal: the exact string, and a pasted signature is checked before publishing.
    await page.getByTestId('session-button').click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await gotoFixtures(page, '/p/OrchardPay');
    await signInAs(page, /^Alice$/);
    const panel = page.getByTestId('claim-panel');
    await panel.locator('summary').click();
    await expect(panel.getByTestId('claim-message')).toHaveText(/^govhub-claim\|mainnet\|8410614191c3f2df69a224a1c34ebc745288700515fdece6ad3764bfc1c987fe\|[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    await expect(panel).toContainText('signmessage "XbSrPJNL8Zt7qJQxeM4meNHEWS5orGbJCs"');
    await panel.getByLabel(/Signature/).fill('H6Ld8vS0ZMVZbBHkW6LZMxl0gm9mc6qtNnpGWzCzm6YmJ3n2v8C6zPPn6RvPwJ0E4ki2CL9e0z3Y5K1pXmBZcJg=');
    await expect(panel.getByTestId('claim-sig-status')).toContainText('does not verify');
    await expect(panel.getByRole('button', { name: 'Publish claim' })).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test('list cards count comments without the hidden ones; the default list can be turned off', async ({ page }) => {
    await gotoFixtures(page, '/');
    await expect(page.locator('article.card', { hasText: 'DCG-Operations-Aug-Nov-26' }).getByTestId('card-comments')).toHaveText(/2$/);
    await page.locator('.sentinel').scrollIntoViewIfNeeded();
    await expect(page.locator('article.card', { hasText: 'OrchardPay' }).getByTestId('card-comments')).toHaveText(/5$/);

    await page.getByRole('link', { name: 'Settings' }).click();
    const lists = page.getByRole('region', { name: 'Block lists' });
    await expect(lists).toContainText('govhub moderation: 1 block');
    await lists.getByLabel(/The default list/).uncheck();
    await lists.getByRole('button', { name: 'Save in this browser' }).click();
    await expect(lists).toContainText('Saved in this browser.');
    await gotoFixtures(page, '/p/OrchardPay');
    await expect(page.getByTestId('discussion')).toContainText('FREE DASH!!!');
    await expect(page.getByTestId('toggle-hidden')).toHaveCount(0);
  });
});
