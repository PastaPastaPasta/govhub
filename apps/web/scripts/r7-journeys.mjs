import { chromium } from '../../../../../lab/node_modules/playwright/index.mjs';
import { installQaGuard } from '../../../../../lab/qa-guard.mjs';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const out = new URL('../../../../../shots/r7-gov-journeys/', import.meta.url);
await fs.mkdir(out, { recursive: true });
const report = { fixture: 'Live public reads; disposable local composer draft; no sign-in credentials and no chain writes.', gov: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('../../../', import.meta.url), encoding: 'utf8' }).trim(), cases: [] };
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1', '--disable-dev-shm-usage'] });
const gov = 'http://gov.dashhq.localhost:8787';
const node = 'd353cdcae53071401345c38ab482935cb62442be2174a1d3210ca356c9017eff';
try {
  for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, colorScheme: theme, serviceWorkers: 'block', locale: 'en-US', timezoneId: 'UTC' });
    const record = { device: phone ? 'phone' : 'desktop', theme, checks: [], blockedWrites: [], errors: [], pages: [] };
    await installQaGuard(context, { onBlocked: text => record.blockedWrites.push(text) });
    context.setDefaultTimeout(60000);
    const page = await context.newPage();
    page.on('pageerror', e => record.errors.push(e.message));
    const check = (name, value) => { record.checks.push({ name, passed: !!value }); if (!value) throw Error(name); };
    const shot = async name => { const file = `${record.device}-${theme}-${name}.png`; await page.screenshot({ path: new URL(file, out).pathname, animations: 'disabled' }); record.pages.push({ file, url: page.url() }); };
    try {
      await page.goto(`${gov}/polls?network=mainnet`);
      await page.getByText('Polls run on Testnet while the poll contract is tested.').waitFor();
      check('Mainnet stays Mainnet', new URL(page.url()).searchParams.get('network') === 'mainnet');
      await shot('polls-mainnet');
      await page.getByRole('link', { name: 'Open Polls on Testnet' }).click();
      await page.getByRole('link', { name: 'New poll', exact: true }).waitFor();
      check('Explicit Testnet handoff', new URL(page.url()).searchParams.get('network') === 'testnet');
      await page.waitForTimeout(18000);
      await shot('polls-list');
      const firstPoll = page.locator('.poll-title-link').first();
      if (await firstPoll.count()) { await firstPoll.click(); await page.waitForTimeout(18000); await shot('poll-record'); await page.getByRole('link', { name: '‹ Polls', exact: true }).click(); }
      else record.pollRecord = 'No open poll was returned by the live read.';
      await page.getByRole('button', { name: 'Closed', exact: true }).click();
      await page.waitForTimeout(12000);
      await shot('polls-closed');
      if (await firstPoll.count()) { await firstPoll.first().click(); await page.waitForTimeout(15000); await shot('closed-poll-record'); await page.getByRole('link', { name: '‹ Polls', exact: true }).click(); }
      await page.getByRole('button', { name: 'Mine', exact: true }).click();
      await page.getByText('Your polls, together').waitFor();
      await shot('polls-mine');
      await page.getByRole('link', { name: 'New poll', exact: true }).click();
      await page.getByLabel('Question', { exact: true }).fill('Which day should we meet?');
      await page.getByLabel('Option 1', { exact: true }).fill('Saturday');
      await page.getByLabel('Option 2', { exact: true }).fill('Sunday');
      await page.getByLabel('Allow more than one choice').check();
      await page.evaluate(() => scrollTo(0, 0));
      await shot('draft-before-signin');
      await page.getByRole('button', { name: 'Sign in to publish', exact: true }).scrollIntoViewIfNeeded();
      await page.locator('.poll-submit').getByText(/^(Est\.|Fee estimate unavailable)/).waitFor();
      record.fee = await page.locator('.poll-submit .small').innerText();
      await shot('poll-credit-cost');
      await page.getByRole('button', { name: 'Sign in to publish', exact: true }).click();
      await page.getByTestId('choose-passkey').waitFor();
      check('Governance sign-in choices visible', await page.getByTestId('choose-passkey').isVisible());
      await shot('governance-signin');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.locator('dialog[open]').waitFor({ state: 'hidden' });
      await page.reload();
      check('Question survives sign-in and reload', await page.getByLabel('Question', { exact: true }).inputValue() === 'Which day should we meet?');
      check('Options survive sign-in and reload', await page.getByLabel('Option 1', { exact: true }).inputValue() === 'Saturday' && await page.getByLabel('Option 2', { exact: true }).inputValue() === 'Sunday');
      check('Mode survives reload', await page.getByLabel('Allow more than one choice').isChecked());
      await page.evaluate(() => scrollTo(0, 0));
      await shot('draft-after-signin');
      await page.goto('http://bridge.dashhq.localhost:8787/?mode=resume&network=testnet');
      await page.goBack();
      check('Draft survives cross-site Back', await page.getByLabel('Question', { exact: true }).inputValue() === 'Which day should we meet?');
      await page.goto(`${gov}/masternodes/${node}?network=mainnet`);
      const proposals = page.locator('dashhq-bar [slot="nav"] a').filter({ hasText: /^Proposals$/ });
      if (phone) { await page.locator('dashhq-bar').getByRole('button', { name: /menu/i }).click(); await shot('governance-menu'); }
      check('Proposals tab carries selected node', new URL(await proposals.getAttribute('href'), gov).searchParams.get('mn') === node);
      await proposals.click();
      check('Proposals URL keeps selected node', new URL(page.url()).searchParams.get('mn') === node);
      const response = await page.goto(`${gov}/names/testtata?network=testnet`);
      check('Testnet contest document returns 200', response.status() === 200);
      await page.waitForTimeout(10000);
      await shot('contest-testtata');
      for (const [path, expected] of [['/', '/polls'], ['/create/', '/polls/new'], ['/my-polls/', '/polls?seg=mine'], ['/poll/?id=9mmD1KZFbtLxrEUMdeTDqxNGsRBDNwtJ1ZEicizTNANn', '/polls/9mmD1KZFbtLxrEUMdeTDqxNGsRBDNwtJ1ZEicizTNANn']]) {
        await page.goto(`http://pollr.dashhq.localhost:8787${path}`);
        await page.waitForURL(u => u.hostname === 'gov.dashhq.localhost' && u.pathname === expected.split('?')[0]);
        check(`Pollr forwards ${path}`, new URL(page.url()).searchParams.get('network') === 'testnet' && (!expected.includes('seg=mine') || new URL(page.url()).searchParams.get('seg') === 'mine'));
      }
      await page.getByRole('heading', { level: 1, name: 'Which count-tree feature matters most?' }).waitFor();
      await shot('pollr-forwarded-record');
      await page.goto(`${gov}/polls/archive?network=testnet`);
      await page.locator('.poll-title-link').first().waitFor();
      await page.waitForTimeout(8000);
      await shot('earlier-polls');
      const archived = 'FC9FQmwVB3HYisioAgk8TuFHBK4thZdYRkGPu9yXCPUN';
      await page.goto(`http://pollr.dashhq.localhost:8787/poll/?id=${archived}&archive=1&network=mainnet&tag=a&tag=b#answers`);
      await page.getByRole('heading', { level: 1, name: 'What should I ask?' }).waitFor();
      await page.getByText('Earlier polls are read-only.').waitFor();
      const forwarded = new URL(page.url());
      check('Archive forward retains record and Testnet', forwarded.pathname === `/polls/${archived}` && forwarded.searchParams.get('archive') === '1' && forwarded.searchParams.get('network') === 'testnet');
      check('Forward retains hashes and repeated query values', forwarded.hash === '#answers' && forwarded.searchParams.getAll('tag').join(',') === 'a,b');
      await page.waitForTimeout(8000);
      await shot('archive-forwarded-record');
      check('No document writes reached the guard', record.blockedWrites.length === 0);
      check('No horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    } catch (error) { record.failure = error.message; record.failureUrl = page.url(); record.failureText = await page.locator('body').innerText(); await shot('failure'); }
    report.cases.push(record);
    await fs.writeFile(new URL('report.json', out), JSON.stringify(report, null, 2));
    await context.close();
  }
} finally { await browser.close(); }
if (report.cases.some(c => c.failure || c.errors.length)) process.exitCode = 1;
console.log(JSON.stringify(report.cases.map(({ device, theme, checks, failure }) => ({ device, theme, checks, failure })), null, 2));
