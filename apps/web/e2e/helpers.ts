import { expect, type Page } from '@playwright/test';

/** Collects page errors and CSP violations; read the violations with cspViolations(). */
export async function watchPage(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return errors;
}

export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

export async function gotoFixtures(page: Page, path = '/') {
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}fixtures=1`);
  await expect(page.getByText('Demo data.', { exact: true })).toBeVisible();
}

/** Opens the proposal's "How do we know?" drawer (every check's detail lives there). */
export async function openDrawer(page: Page) {
  await page.getByTestId('trust-badge').click();
  await expect(page.getByTestId('verify-drawer')).toBeVisible();
  return page.getByTestId('verify-drawer');
}
