// @live-badge: the badge posted by scripts/badge-live.ts shows next to identity A's comment, read live from testnet Platform
// with proofs, in the Dev profile (testnet Platform). Opt-in: GOVHUB_LIVE_BADGE=1 npx playwright test --grep @live-badge
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const STATE = join(homedir(), '.local/share/govhub-badge-live/state.json');

test.describe('MN badge, live testnet', () => {
  test.skip(!process.env.GOVHUB_LIVE_BADGE, 'set GOVHUB_LIVE_BADGE=1 after scripts/badge-live.ts post');
  test('@live-badge the chip shows next to the badge holder, and not next to the identity that copied the badge', async ({ page }) => {
    test.setTimeout(240_000);
    const st = JSON.parse(readFileSync(STATE, 'utf8')) as { ids: { A: { identityId: string } }; comment: { govHash: string; id: string } };
    await page.goto(`/p/h/${st.comment.govHash}?comment=${st.comment.id}`);
    const comment = page.locator(`#comment-${st.comment.id}`);
    await expect(comment).toBeVisible({ timeout: 180_000 });
    await expect(comment.locator('.chip-mn')).toHaveText('MN · vouched by govhub', { timeout: 120_000 });
    // without a deep link, the filter default flips to "Proposal owner + MN owners" once a trusted badge is live
    await page.goto(`/p/h/${st.comment.govHash}`);
    await expect(page.getByRole('radio', { name: 'Proposal owner + MN owners' })).toBeChecked({ timeout: 180_000 });
    await expect(page.locator(`#comment-${st.comment.id} .chip-mn`)).toHaveText('MN · vouched by govhub', { timeout: 120_000 });
  });
});
