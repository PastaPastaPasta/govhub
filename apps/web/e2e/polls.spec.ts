// Masternode polls in fixture mode: the list (open, ended, mine), a yes/no and a multiple choice poll page, and the vote panel.
import { expect, test } from '@playwright/test';
import { cspViolations, gotoFixtures, watchPage } from './helpers.ts';

test.describe('masternode polls (fixtures)', () => {
  test('list: open polls closing soonest first, then ended ones; Mine asks to sign in', async ({ page }) => {
    const errors = await watchPage(page);
    await gotoFixtures(page, '/polls');
    await expect(page.getByTestId('nav-polls')).toHaveAttribute('aria-current', 'page');
    const open = page.getByTestId('open-polls').getByTestId('poll-card');
    await expect(open).toHaveCount(3);
    await expect(open.nth(0)).toContainText('Fund a second independent audit');
    await expect(open.nth(0).getByTestId('poll-status')).toHaveText(/Closes in 20 hours/);
    // yes 301 of 545 is 55%: above 50%, and 545 is above 20% of 4,312 (863)? No: too few voted
    await expect(open.nth(0)).toContainText('Not passing yet');
    await expect(open.nth(0)).toContainText('Turnout 545 of about 863 needed');
    await expect(open.nth(1)).toContainText('Passing: yes 72% of yes and no');
    await expect(open.nth(2)).toContainText('Lisbon leads');

    await page.locator('.polls-seg label', { hasText: 'Ended' }).click();
    await expect(page).toHaveURL(/show=ended/);
    const ended = page.getByTestId('ended-polls').getByTestId('poll-card');
    await expect(ended).toHaveCount(2);
    await expect(ended.nth(0)).toContainText('Which color should the new testnet explorer use?');
    await expect(ended.nth(0).getByTestId('poll-status')).toHaveText('Decided');
    await expect(ended.nth(1).getByTestId('poll-status')).toHaveText('Passed');

    await page.locator('.polls-seg label', { hasText: 'Mine' }).click();
    await expect(page.getByTestId('polls-mine-signin')).toBeVisible();
    expect(errors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('a yes/no poll: tallies against its rule, the text, and the vote panel', async ({ page }) => {
    await gotoFixtures(page, '/polls/Bx4sgMPNXuZxZwnHa42sT7NKvzZsMpywSX9zDiYp69bK');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Should the next core release ship with the new fee schedule turned on?');
    await expect(page.getByTestId('poll-status-line')).toHaveText(/Voting closes in 11 days/);
    await expect(page.getByTestId('poll-tally')).toContainText('512');
    await expect(page.getByTestId('poll-outlook')).toContainText('Passing');
    await expect(page.getByTestId('poll-outlook')).toContainText('Turnout 708 of about 432 needed');
    await expect(page.getByTestId('poll-description')).toContainText('Yes: the release turns the new fee schedule on');
    await expect(page.getByTestId('poll-url')).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
    await expect(page.getByTestId('contest-vote-panel')).toContainText('Your vote');
    await expect(page.getByTestId('vote-cta')).toBeVisible();
  });

  test('a multiple choice poll: its choices, abstain and none of the choices; an ended one keeps only the winner’s text', async ({ page }) => {
    await gotoFixtures(page, '/polls/6Gne8CbK4x4cYz1nzpk7hpXS5PuCELMeURkeEfrJjbtj');
    const choices = page.getByTestId('poll-choice');
    await expect(choices).toHaveCount(3);
    await expect(choices.nth(0)).toContainText('Lisbon');
    await expect(page.getByTestId('poll-tally')).toContainText('None of the choices');
    await expect(page.getByTestId('summary')).toContainText('Anyone');

    await gotoFixtures(page, '/polls/9ZQrCUi34TzLKqyE4jyMwQJbEJUjHdBArhu2D68bBocV');
    await expect(page.getByTestId('poll-status-line')).toContainText('Dash blue was kept');
    await expect(page.getByTestId('poll-choice').nth(1)).toContainText('Its text left Platform');
    await expect(page.getByTestId('contest-vote-panel')).toHaveCount(0);
  });

  test('an unknown poll id says so', async ({ page }) => {
    await gotoFixtures(page, '/polls/5kskMkHbcEbu5WygRVBhvk5fVWcErB9HZiCRQA8L72Fo');
    await expect(page.getByRole('heading', { name: 'No such poll' })).toBeVisible();
  });
});
