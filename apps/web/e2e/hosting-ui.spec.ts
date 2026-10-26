// Hosting, settings, accessibility and loading fixes (QA ledger D-050 … D-086). Fixture mode or live mode with every non-local
// request aborted: no backend needed.
import { devices, expect, test, type Page } from '@playwright/test';
import { cspViolations, gotoFixtures, offline, openGroup, watchPage } from './helpers.ts';

const JSON_BOX = 'Settings JSON (paste and import, or copy)';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const savedProfile = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('govhub.registry.v2') ?? 'null')?.profile ?? null);

async function exportedSettings(page: Page) {
  await openGroup(page, 'Export, import and share');
  await page.getByRole('button', { name: 'Show JSON' }).click();
  return JSON.parse(await page.getByLabel(JSON_BOX).inputValue());
}

test.describe('?config= links', () => {
  test('D-054: a config URL is not fetched until the user agrees', async ({ page, context }) => {
    await offline(context);
    let asked = 0;
    await gotoFixtures(page, '/settings');
    const cfg = await exportedSettings(page);
    cfg.relays = [{ name: 'other relay', url: 'https://relay.attacker.example' }];
    await context.route('https://attacker.example/**', (r) => {
      asked++;
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(cfg) });
    });
    await page.goto('/settings?config=https://attacker.example/x.json');
    const offer = page.getByTestId('config-offer');
    await expect(offer).toContainText('attacker.example');
    await expect(offer).toContainText('has not contacted that host');
    await page.waitForTimeout(1500);
    expect(asked).toBe(0);
    await offer.getByRole('button', { name: 'Load settings from attacker.example' }).click();
    await expect(offer.getByTestId('config-diff')).toContainText('https://relay.attacker.example');
    expect(asked).toBe(1);
    // "Ignore this link" never fetches either
    await page.goto('/settings?config=https://attacker.example/y.json');
    await page.getByRole('button', { name: 'Ignore this link' }).click();
    await expect(page.getByTestId('config-offer')).toHaveCount(0);
    expect(asked).toBe(1);
  });

  test('D-052: the offer is a diff against the current settings and names every host, quorum proofs and bridge identity included', async ({ page }) => {
    await gotoFixtures(page, '/settings');
    const cfg = await exportedSettings(page);
    cfg.quorumProofs = [{ name: 'proofs', url: 'https://proofs.attacker.example/proofs', kind: 'bridge' }];
    cfg.bridges[0].bridgeIdentityId = '24tL6v5jMR1H9dtUoTgbedePsMJtYPk4Q4bo6h8jTdK9';
    await page.goto(`/settings?config=${b64(cfg)}`);
    const diff = page.getByTestId('config-diff');
    await expect(diff.locator('dt')).toHaveText(['Bridges', 'Quorum proof sources']);
    await expect(diff).toContainText('https://proofs.attacker.example/proofs');
    await expect(diff).toContainText('24tL6v5jMR1H9dtUoTgbedePsMJtYPk4Q4bo6h8jTdK9');
    await expect(diff).toContainText('gov-bridge.dashhq.org'); // what it replaces (the Dev profile's only proof source)
    // the unchanged settings are listed too (folded)
    await expect(page.locator('.config-unchanged')).toContainText('https://quorums.mainnet.networks.dash.org/masternodes');
    await page.getByRole('button', { name: 'Use these settings' }).click();
    const now = await exportedSettings(page);
    expect(now.quorumProofs).toEqual(cfg.quorumProofs);

    // the same settings again: nothing would change, and there is nothing to apply
    await page.goto(`/settings?config=${b64(now)}`);
    await expect(page.getByTestId('config-offer')).toContainText('nothing would change');
    await expect(page.getByRole('button', { name: 'Use these settings' })).toHaveCount(0);
  });

  test('D-050: inside a frame govhub renders nothing to click, a config link included', async ({ page, baseURL }) => {
    const cfg = { version: 2, profile: 'dev', overrides: {} };
    await page.setContent(`<iframe src="${baseURL}/settings?fixtures=1&config=${b64({ ...cfg, relays: [] })}" width="1000" height="700"></iframe>`);
    const frame = page.frameLocator('iframe');
    await expect(frame.getByTestId('framed-notice')).toContainText('only works in its own tab');
    await expect(frame.getByRole('link', { name: 'Open govhub in its own tab' })).toHaveAttribute('target', '_blank');
    await expect(frame.getByRole('button')).toHaveCount(0);
    await expect(frame.getByTestId('config-offer')).toHaveCount(0);
  });

  test('D-050: "Use these settings" arms only after the offer has been on screen for a moment', async ({ page }) => {
    await gotoFixtures(page, '/settings');
    const cfg = await exportedSettings(page);
    cfg.relays = [{ name: 'other', url: 'https://relay.other.example' }];
    await page.goto(`/settings?config=${b64(cfg)}`);
    const use = page.getByRole('button', { name: 'Use these settings' });
    await expect(use).toBeDisabled();
    await expect(use).toBeEnabled();
  });
});

test.describe('settings', () => {
  test('D-053: the share link keeps the app path', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await gotoFixtures(page, '/settings');
    await openGroup(page, 'Export, import and share');
    await page.getByRole('button', { name: 'Copy share link' }).click();
    await expect(page.getByText('Share link copied.')).toBeInViewport();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link.startsWith(`${baseURL}/?config=`)).toBe(true);
  });

  test('D-056 / D-057: import messages show next to the control; oversized files are refused', async ({ page }) => {
    await gotoFixtures(page, '/settings');
    const g = await openGroup(page, 'Export, import and share');
    await g.getByLabel(JSON_BOX).fill('{oops');
    await page.getByRole('button', { name: 'Import this JSON' }).click();
    await expect(page.getByRole('alert')).toContainText('Not valid JSON');
    await expect(page.getByRole('alert')).toBeInViewport();

    await page.locator('input[type=file]').setInputFiles({ name: 'big.json', mimeType: 'application/json', buffer: Buffer.alloc(12 * 1024 * 1024, 0x20) });
    await expect(page.getByRole('alert')).toContainText('Too large to be govhub settings: 12.0 MB');
    await expect(page.getByRole('alert')).toBeInViewport();

    await g.getByLabel(JSON_BOX).fill(' '.repeat(70 * 1024) + '{}');
    await page.getByRole('button', { name: 'Import this JSON' }).click();
    await expect(page.getByRole('alert')).toContainText('Too large');
  });

  test('D-058: arrow keys move through the profile radios without switching; the switch needs a confirmation', async ({ page, context }) => {
    await offline(context);
    await page.goto('/settings?fixtures=0');
    const label = page.getByTestId('profile-label');
    await expect(label).toContainText('Mainnet');
    await page.getByRole('radio', { name: 'Mainnet' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Testnet' })).toBeChecked();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('radio', { name: 'Testnet' })).toBeChecked();
    await expect(label).toContainText('Mainnet');
    expect(await savedProfile(page)).not.toBe('testnet');
    await page.getByRole('button', { name: 'Stay on Mainnet' }).click();
    await expect(page.getByRole('radio', { name: 'Mainnet' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Mainnet' })).toBeFocused();
    await page.locator('.profile-switch label', { hasText: 'Testnet' }).click();
    await page.getByRole('button', { name: 'Switch to Testnet' }).click();
    await expect(label).toContainText('Testnet');
    expect(await savedProfile(page)).toBe('testnet');
    await expect(page.getByRole('radio', { name: 'Testnet' })).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'Switched to Testnet' })).toBeInViewport();
  });

  test('D-084: saved settings that fail validation are reported, not silently replaced', async ({ page, context }) => {
    await offline(context);
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('govhub.registry.v2', JSON.stringify({ version: 2, profile: 'testnet', overrides: { priceFeed: { name: 'x', url: 'ftp://bad' } } }));
      }
    });
    await page.goto('/?fixtures=0');
    const notice = page.getByTestId('settings-problem');
    await expect(notice).toContainText('Your saved settings could not be used');
    await expect(notice).toContainText('price feed URL must be an https URL');
    await expect(notice).toContainText('Mainnet profile');
    // kept until replaced
    expect(await page.evaluate(() => localStorage.getItem('govhub.registry.v2'))).toContain('ftp://bad');
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toHaveCount(0);
  });
});

test.describe('accessibility', () => {
  test('D-062: focus returns to the account button when the sign-in sheet closes', async ({ page }) => {
    await gotoFixtures(page);
    for (const how of ['Escape', 'Close'] as const) {
      await page.getByTestId('session-button').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('dialog.sheet[open]')).toBeVisible();
      if (how === 'Escape') await page.keyboard.press('Escape');
      else await page.locator('dialog.sheet').getByRole('button', { name: 'Close' }).click();
      await expect(page.locator('dialog.sheet[open]')).toHaveCount(0);
      await expect(page.getByTestId('session-button')).toBeFocused();
    }
  });

  test('D-061: primary buttons and muted text meet AA contrast in the light theme', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('govhub.theme', 'light'));
    await gotoFixtures(page, '/settings');
    const ratios = await page.evaluate(() => {
      const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = (c: number[]) => {
        const [r, g, b] = c.map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const ratio = (a: string, b: string) => {
        const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p);
        return (x! + 0.05) / (y! + 0.05);
      };
      const btn = getComputedStyle(document.querySelector('.btn-primary')!);
      const probe = document.createElement('span');
      probe.style.color = 'var(--ink-3)';
      document.body.append(probe);
      const muted = getComputedStyle(probe).color;
      probe.remove();
      const sunk = getComputedStyle(document.documentElement).getPropertyValue('--sunk').trim();
      const toRgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(',')})`;
      return { button: ratio(btn.color, btn.backgroundColor), mutedOnSunk: ratio(muted, toRgb(sunk)) };
    });
    expect(ratios.button).toBeGreaterThanOrEqual(4.5);
    expect(ratios.mutedOnSunk).toBeGreaterThanOrEqual(4.5);
  });

  test('D-085: the budget strip is not an image wrapping links; card titles follow the page heading', async ({ page }) => {
    await gotoFixtures(page);
    await expect(page.locator('.strip')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.strip')).not.toHaveAttribute('role', 'img');
    await expect(page.locator('.budget p.visually-hidden')).toContainText('Allocated');
    await expect(page.locator('article.prow h2.prow-title').first()).toBeVisible();
    await expect(page.locator('article.prow h3')).toHaveCount(0);
  });
});

test.describe('phones', () => {
  // iPhone 14 screen and touch, in the project's Chromium
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['iPhone 14'];
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent });
  const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  test('D-059: Settings does not scroll sideways', async ({ page }) => {
    await gotoFixtures(page, '/settings');
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    expect(await noSideScroll(page)).toBe(true);
  });

  test('D-060: the comment Hide… menu opens inside the screen', async ({ page }) => {
    await gotoFixtures(page, '/p/OrchardPay');
    await page.getByTestId('session-button').click();
    await page.getByRole('button', { name: /^Alice$/ }).click();
    const sums = page.locator('details.menu > summary');
    await expect(sums.first()).toBeVisible();
    for (let i = 0; i < Math.min(await sums.count(), 4); i++) {
      await sums.nth(i).scrollIntoViewIfNeeded();
      await sums.nth(i).click();
      const box = (await page.locator('details.menu[open] .menu-body').boundingBox())!;
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vw);
      expect(await noSideScroll(page)).toBe(true);
      await sums.nth(i).click();
    }
  });
});

test.describe('loading', () => {
  test('D-063: the evo-sdk WASM is a separate application/wasm asset, not base64 inside a JS chunk', async ({ page, context }) => {
    await offline(context);
    const errors = await watchPage(page);
    const js: Array<{ url: string; bytes: number }> = [];
    page.on('response', async (r) => {
      if (/\.js(\?|$)/.test(r.url())) js.push({ url: r.url(), bytes: (await r.body().catch(() => Buffer.alloc(0))).length });
    });
    const wasm = page.waitForResponse((r) => /wasm_sdk_bg[^/]*\.wasm$/.test(r.url()), { timeout: 60_000 });
    await page.goto('/?fixtures=0'); // live mode: Platform reads load evo-sdk (they then fail offline)
    const res = await wasm;
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/wasm');
    await page.waitForTimeout(500);
    for (const f of js) expect(f.bytes, f.url).toBeLessThan(2 * 1024 * 1024);
    expect(errors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
  });
});
