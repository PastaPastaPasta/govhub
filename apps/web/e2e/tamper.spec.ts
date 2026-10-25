// Tamper suite (QA streams S1 and S2, verification fixes): a recorded live Testnet session (e2e/recordings/testnet.json.gz) is
// replayed offline through the real page, worker and verification code, with chosen answers rewritten the way a lying bridge or
// DAPI node would. The untampered replay settles on "Verified" (so the harness can produce it); no tamper may. Runs in CI.
//
// Re-record against the live network (needed when the app's requests change):
//   GOVHUB_RECORD=1 npx playwright test e2e/tamper.spec.ts --grep @record
// The same scenarios against the live Testnet instead of the recording (answers fetched for real, then rewritten):
//   GOVHUB_TAMPER_LIVE=1 npx playwright test e2e/tamper.spec.ts
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { cspViolations, watchPage } from './helpers.ts';
import { liveTamper, loadRecording, record, replay, saveRecording, type Replay, type Tamper } from './replay.ts';

/** govhub-mn-voting-test-2026-10-24 on Testnet: collateral, chain, votes and funding all provable. */
const P = 'ab31c1fffb2eef4587f4ba85a92ddf98b3256aaf96542fe5221a0532d620708d';
const REC = new URL('./recordings/testnet.json.gz', import.meta.url);
const PORT = Number(process.env.GOVHUB_E2E_PORT ?? 4317);
const BASE = `http://localhost:${PORT}`;
const BRIDGE = 'gov-bridge-testnet.dashhq.org';
const LIVE = !!process.env.GOVHUB_TAMPER_LIVE;

async function testnetProfile(ctx: BrowserContext, overrides: Record<string, unknown> = {}) {
  await ctx.addInitScript((o) => {
    try {
      if (!localStorage.getItem('govhub.registry.v2')) localStorage.setItem('govhub.registry.v2', JSON.stringify({ version: 2, profile: 'testnet', overrides: o }));
    } catch { /* about:blank */ }
  }, overrides);
}

/** Waits for the badge to settle (not "checking"), opens the drawer and reads every check's state. */
async function settle(page: Page, path = `/p/h/${P}`) {
  await page.goto(`${path}?fixtures=0`);
  const badge = page.getByTestId('trust-badge');
  await expect(badge).toBeVisible({ timeout: 60_000 });
  await expect(badge).not.toHaveAttribute('data-trust', 'checking', { timeout: 120_000 });
  const level = (await badge.getAttribute('data-trust'))!;
  await badge.click();
  const drawer = page.getByTestId('verify-drawer');
  await expect(drawer).toBeVisible();
  const states: Record<string, string> = {};
  for (const id of ['content', 'collateral', 'chain', 'votes', 'funding']) states[id] = (await drawer.locator(`[data-check="${id}"]`).getAttribute('data-state'))!;
  return { level, states, drawer };
}

/** The glyph a drawer element draws. */
const glyphs = async (page: Page, sel: string) => page.locator(`${sel} svg.glyph`).evaluateAll((gs) => gs.map((g) => [...g.classList].find((c) => c.startsWith('glyph-'))));

// ---- recording ----------------------------------------------------------------------------------------------------------------

test.describe('@record', () => {
  test.skip(!process.env.GOVHUB_RECORD, 'set GOVHUB_RECORD=1 to record the live Testnet session');
  test('record a Testnet session: the list, then a proposal page settling on Verified', async ({ browser }) => {
    test.setTimeout(600_000);
    const ctx = await browser.newContext();
    await testnetProfile(ctx);
    const rec = await record(ctx, BASE);
    const page = await ctx.newPage();
    await page.goto('/?fixtures=0');
    await expect(page.getByTestId('proposal-card').first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(8000); // the background collateral checks of the list
    const r = await settle(page);
    expect(r.level).toBe('verified');
    await r.drawer.getByTestId('votes-check').locator(':scope > summary').click();
    await page.waitForTimeout(3000);
    await ctx.close();
    saveRecording(REC, rec.done());
  });
});

// ---- replayed scenarios -------------------------------------------------------------------------------------------------------

test.describe('tamper (replayed Testnet session)', () => {
  test.skip(!!process.env.GOVHUB_RECORD || !existsSync(REC), 'no recording');
  const PER_LOAD_MS = LIVE ? 600_000 : 180_000;
  test.describe.configure({ timeout: PER_LOAD_MS });
  /** The scenario ran on the recording alone: no request it lacked (which would fail like a network outage and prove nothing). */
  const complete = (r: Replay) => {
    if (!LIVE) expect(r.misses, r.misses.join('\n')).toEqual([]);
  };
  const rec = existsSync(REC) ? loadRecording(REC) : null;

  async function open(browser: import('@playwright/test').Browser, ...tampers: Array<Tamper | { overrides: Record<string, unknown> }>): Promise<{ page: Page; r: Replay; errors: string[]; ctx: BrowserContext }> {
    const ctx = await browser.newContext();
    await testnetProfile(ctx, tampers.find((t): t is { overrides: Record<string, unknown> } => typeof t === 'object')?.overrides);
    const r = LIVE ? await liveTamper(ctx, BASE) : await replay(ctx, rec!, BASE);
    for (const t of tampers) if (typeof t === 'function') r.tamper(t);
    const page = await ctx.newPage();
    const errors = await watchPage(page);
    return { page, r, errors, ctx };
  }

  // -- answer rewriting helpers
  const json = (edit: (o: any) => void): ((e: Parameters<Tamper>[0]) => ReturnType<Tamper>) => (e) => {
    const o = JSON.parse(e.body.toString('utf8'));
    edit(o);
    return { body: Buffer.from(JSON.stringify(o)) };
  };
  const onUrl = (re: RegExp, f: (e: Parameters<Tamper>[0]) => ReturnType<Tamper>): Tamper => (e) => (re.test(e.url) && e.status === 200 && e.body.length ? f(e) : null);
  const votesUrl = new RegExp(`${BRIDGE.replace(/\./g, '\\.')}/v1/proposals/${P}/votes`);
  const talliesUrl = new RegExp(`${BRIDGE.replace(/\./g, '\\.')}/v1/tallies`);
  const mnlistUrl = new RegExp(`${BRIDGE.replace(/\./g, '\\.')}/v1/mnlist`);
  const getTx = /\/org\.dash\.platform\.dapi\.v0\.Core\/getTransaction$/;
  /** grpc-web request for this txid (the body carries it as hex text). */
  const asks = (e: Parameters<Tamper>[0], txid: string) => e.post.includes(Buffer.from(txid));
  const notFound = () => ({ status: 200, headers: { 'content-type': 'application/grpc-web+proto', 'grpc-status': '5', 'grpc-message': 'Transaction not found' }, body: Buffer.alloc(0) });
  /** The proposal's collateral txid, from the bridge's recorded proposal list. */
  const collateralTxid = (): string => {
    const e = rec!.entries.find((x) => x.url.includes('/v1/proposals?state=active'))!;
    const p = (JSON.parse(Buffer.from(e.body, 'base64').toString('utf8')).proposals as Array<{ govHash: string; collateralTxid: string }>).find((x) => x.govHash === P)!;
    return p.collateralTxid;
  };
  // voteSetHash and recount, as the bridge computes them (S1 harness)
  const vsh = (votes: any[]) => {
    const rows = votes.map((v) => [`${v.collateralTxid.toLowerCase()}-${v.collateralIndex}`, v] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return createHash('sha256').update('govhub-voteset-v1\n' + rows.map(([id, v]) => `${id}|${v.outcome}|${v.time}\n`).join('')).digest('hex');
  };

  test('baseline: the untampered replay settles on Verified (the harness can produce it)', async ({ browser }) => {
    const { page, r, errors } = await open(browser);
    const s = await settle(page);
    expect(s.states).toEqual({ content: 'proven', collateral: 'proven', chain: 'proven', votes: 'proven', funding: 'proven' });
    expect(s.level).toBe('verified');
    await expect(s.drawer.getByTestId('collateral-check').locator('[data-verdict]')).toHaveAttribute('data-verdict', 'ok');
    if (!LIVE) expect(r.misses, r.misses.join('\n')).toEqual([]);
    expect(errors).toEqual([]);
    expect(await cspViolations(page)).toEqual([]);
    // D-064: no provenance marks on the page itself; the badge and the drawer carry the basis
    await page.keyboard.press('Escape');
    await expect(page.locator('article.proposal [data-prov]')).toHaveCount(0);
  });

  // S1-T3.1, T3.2, T3.4, T3.6 (D-007): every tampered vote set or tally is a reported mismatch, never verified, never "failed"
  const voteTampers: Record<string, Tamper> = {
    'vote-outcome': onUrl(votesUrl, json((o) => { o.votes[0].outcome = o.votes[0].outcome === 1 ? 2 : 1; })),
    'vote-time': onUrl(votesUrl, json((o) => { o.votes[0].time += 1; })),
    'vote-sig': onUrl(votesUrl, json((o) => { const s: string = o.votes[0].sig; const i = s.length >> 1; o.votes[0].sig = s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1); })),
    'drop-votes-only': onUrl(votesUrl, json((o) => { o.votes = o.votes.slice(1); o.count = o.votes.length; })),
    'tally-number': onUrl(talliesUrl, json((o) => { const t = o.tallies.find((x: any) => x.govHash === P); t.yesWeighted += 100; t.absoluteYes += 100; })),
  };
  for (const [name, t] of Object.entries(voteTampers)) {
    test(`${name}: the vote check reports a mismatch; the badge is not Verified`, async ({ browser }) => {
      const { page, r } = await open(browser, t);
      const s = await settle(page);
      complete(r);
      expect(s.level).not.toBe('verified');
      expect(s.level).not.toBe('failed');
      expect(s.states.votes).toBe('error');
      const row = s.drawer.locator('[data-check="votes"]');
      await expect(row).toHaveAttribute('data-mismatch', '');
      await expect(row.locator('.check-text')).toContainText('Mismatch:');
      expect(await glyphs(page, '[data-check="votes"] > .check-line')).toEqual(['glyph-mismatch']);
      await s.drawer.getByTestId('votes-check').locator(':scope > summary').click();
      await expect(s.drawer.locator('[data-votes]')).toHaveAttribute('data-votes', 'mismatch');
      // no green headline, no "Tally verified"
      await expect(s.drawer.getByTestId('votes-check')).not.toContainText('Tally verified');
      expect(await glyphs(page, '[data-testid="votes-check"] .votes-result > .verdict')).toEqual(['glyph-mismatch']);
    });
  }

  test('mnlist-key / mnlist-type / mnlist-drop: a faked masternode list never verifies the votes', async ({ browser }) => {
    const votes = rec!.entries.find((e) => votesUrl.test(e.url))!;
    const v0 = JSON.parse(Buffer.from(votes.body, 'base64').toString('utf8')).votes[0];
    const isV0 = (m: any) => m.collateralTxid === v0.collateralTxid && m.collateralIndex === v0.collateralIndex;
    const cases: Record<string, (o: any) => void> = {
      'mnlist-key': (o) => { const m = o.masternodes.find(isV0); const other = o.masternodes.find((x: any) => x !== m && x.votingAddress !== m.votingAddress); m.votingAddress = other.votingAddress; m.keyIdVoting = other.keyIdVoting; },
      'mnlist-type': (o) => { const m = o.masternodes.find(isV0); m.type = m.type === 'evo' ? 'regular' : 'evo'; m.weight = m.type === 'evo' ? 4 : 1; },
      'mnlist-drop': (o) => { o.masternodes = o.masternodes.filter((x: any) => !isV0(x)); o.count--; },
    };
    test.setTimeout(PER_LOAD_MS * Object.keys(cases).length);
    for (const [name, edit] of Object.entries(cases)) {
      const { page, ctx, r } = await open(browser, onUrl(mnlistUrl, json(edit)));
      const s = await settle(page);
      complete(r);
      expect(s.level, name).not.toBe('verified');
      expect(s.states.votes, name).not.toBe('proven');
      await expect(s.drawer.getByTestId('votes-check'), name).not.toContainText('Tally verified');
      await ctx.close();
    }
  });

  // S1-T3.3 (D-002): the lying bridge withholds a vote and serves a live tally that agrees with what it serves
  test('drop-votes-consistent: a withheld vote with a matching bridge tally is not verified', async ({ browser }) => {
    let consistent: any = null;
    const dropVotes = onUrl(votesUrl, json((o) => {
      o.votes = o.votes.slice(1);
      o.count = o.votes.length;
      const w = { 1: 0, 2: 0, 3: 0 } as Record<number, number>, c = { 1: 0, 2: 0, 3: 0 } as Record<number, number>;
      const sig = o.votes.filter((v: any) => v.signal === 1);
      for (const v of sig) { w[v.outcome]! += v.weight; c[v.outcome]!++; }
      consistent = { yesWeighted: w[1], noWeighted: w[2], abstainWeighted: w[3], yesCount: c[1], noCount: c[2], abstainCount: c[3], voteSetHash: vsh(sig) };
      Object.assign(o, { yesWeighted: w[1], noWeighted: w[2], abstainWeighted: w[3], voteSetHash: consistent.voteSetHash });
    }));
    const lyingTally = onUrl(talliesUrl, json((o) => {
      const t = o.tallies.find((x: any) => x.govHash === P);
      if (t && consistent) { Object.assign(t, consistent); t.absoluteYes = t.yesWeighted - t.noWeighted; }
    }));
    const { page, r } = await open(browser, dropVotes, lyingTally);
    const s = await settle(page);
    complete(r);
    expect(s.level).not.toBe('verified');
    expect(s.states.votes).not.toBe('proven');
    await s.drawer.getByTestId('votes-check').locator(':scope > summary').click();
    await expect(s.drawer.getByTestId('votes-check')).not.toContainText('Tally verified');
    // no compare-table cell is drawn as verified: the tally the recount matches is the bridge's own word
    expect(await glyphs(page, '[data-testid="votes-check"] table.compare')).not.toContain('glyph-verified');
  });

  // S1-T3.5 (D-001, D-066): "in the next budget" never follows the tally's own flag or rank
  test('funded-flag: a flipped inNextBudget/rank changes nothing the page claims', async ({ browser }) => {
    test.setTimeout(PER_LOAD_MS * 2);
    const truth = await open(browser);
    const base = await settle(truth.page);
    const fundingLine = await base.drawer.locator('[data-check="funding"] .check-text').textContent();
    await truth.page.keyboard.press('Escape');
    const tag = await truth.page.locator('.p-status .tag').allTextContents();
    await truth.ctx.close();
    const { page } = await open(browser, onUrl(talliesUrl, json((o) => { for (const t of o.tallies) if (t.govHash === P) { t.inNextBudget = !t.inNextBudget; t.rank = t.rank === 1 ? 9 : 1; } })));
    const s = await settle(page);
    expect(s.level).toBe(base.level);
    await expect(s.drawer.locator('[data-check="funding"] .check-text')).toHaveText(fundingLine!);
    await page.keyboard.press('Escape');
    expect(await page.locator('.p-status .tag').allTextContents()).toEqual(tag);
  });

  // S1-T3.7 (D-014): the bridge's getgovernanceinfo never sets the parameters the page computes with
  test('cycle: tampered governance parameters on /v1/cycle change no parameter on the page', async ({ browser }) => {
    // the recording may not hold /v1/cycle (this build never asks for governance parameters): a lying bridge answers it anyway
    const lie = { superblockcycle: 8000, superblockmaturitywindow: 100, governanceminquorum: 500 };
    const { page, r } = await open(browser, (e) => {
      if (!/\/v1\/cycle/.test(e.url)) return null;
      const o = e.status === 200 && e.body.length ? JSON.parse(e.body.toString('utf8')) : {};
      o.governance = { ...(o.governance ?? {}), ...lie };
      return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(o)) };
    });
    const s = await settle(page);
    complete(r);
    expect(s.level).toBe('verified');
    await page.keyboard.press('Escape');
    await expect(page.locator('.p-per')).toHaveText('per hour'); // testnet: a superblock every 24 blocks
  });

  // S1-T3.8, T3.10 (D-008): DAPI down or tampered is "couldn't verify", never "does not match"
  test('dapi-tx-bytes / dapi-down: the collateral is "couldn\'t verify", never a mismatch of the proposal', async ({ browser }) => {
    const txid = collateralTxid();
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    const flipByte: Tamper = (e) => {
      if (!getTx.test(e.url) || !asks(e, txid) || e.body.length < 80) return null;
      const b = Buffer.from(e.body);
      b[70]! ^= 0x01; // inside the transaction bytes (5-byte frame header, field tag, length)
      return { body: b };
    };
    const down: Tamper = (e) => (/\/org\.dash\.platform\.dapi\.v0\.Core\//.test(e.url) ? 'abort' : null);
    test.setTimeout(PER_LOAD_MS * 2);
    for (const [name, t] of [['dapi-tx-bytes', flipByte], ['dapi-down', down]] as const) {
      const { page, ctx } = await open(browser, t);
      const s = await settle(page);
      expect(s.level, name).toBe('error');
      expect(s.states.collateral, name).toBe('error');
      const v = s.drawer.getByTestId('collateral-check').locator('[data-verdict]');
      await expect(v, name).not.toHaveAttribute('data-verdict', 'fail');
      await expect(s.drawer.getByTestId('collateral-check'), name).not.toContainText('does not match');
      // no row of the collateral check is drawn as a mismatch of the proposal
      expect(await glyphs(page, '[data-testid="collateral-check"]'), name).not.toContain('glyph-mismatch');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('invalid-banner'), name).toHaveCount(0);
      await ctx.close();
    }
  });

  // D-003: the chain cannot be anchored (no quorum proof), so the block is not tied to the chain; of the two DAPI nodes, one returns
  // the transaction and the other answers NOT_FOUND
  test('second node NOT_FOUND: a contradiction, reported as such; the collateral headline is not "verified"', async ({ browser }) => {
    const txid = collateralTxid();
    const { page } = await open(
      browser,
      { overrides: { dapi: { source: 'manual', quorumUrl: 'https://quorums.testnet.networks.dash.org/masternodes', nodes: ['68.67.122.27:1443', '68.67.122.8:1443'] } } },
      // no quorum proof and no header downloads: the chain cannot be anchored by either path
      (e) => (/\/proofs$|\/v1\/quorum-proof|\/subscribeToBlockHeadersWithChainLocks$/.test(e.url) ? 'abort' : null),
      (e) => (getTx.test(e.url) && asks(e, txid) && e.url.startsWith('https://68.67.122.8:') ? notFound() : null),
    );
    const s = await settle(page);
    expect(s.level).not.toBe('verified');
    expect(s.states.collateral).toBe('error');
    const cc = s.drawer.getByTestId('collateral-check');
    await expect(cc.locator('[data-step="crosscheck"]')).toHaveAttribute('data-status', 'fail');
    await expect(cc.locator('[data-step="crosscheck"]')).toContainText('NOT_FOUND');
    await expect(cc).not.toContainText('Content matches the on-chain collateral');
    expect(await glyphs(page, '[data-testid="collateral-check"] > .verdict')).not.toContain('glyph-verified');
    for (const id of ['confirmations', 'chainlock']) await expect(cc.locator(`[data-step="${id}"]`)).toHaveAttribute('data-basis', 'reported');
  });

  // S1-T3.9: the bridge down
  test('bridge-down: votes are not recounted; not Verified', async ({ browser }) => {
    const { page } = await open(browser, (e) => (e.url.includes(BRIDGE) ? 'abort' : null));
    await page.goto(`/p/h/${P}?fixtures=0`);
    const badge = page.getByTestId('trust-badge');
    await expect(badge).toBeVisible({ timeout: 60_000 });
    await expect(badge).not.toHaveAttribute('data-trust', 'checking', { timeout: 120_000 });
    expect(await badge.getAttribute('data-trust')).not.toBe('verified');
  });

  // S2-T4.5/T4.6 (D-009, D-010): no quorum proof (blocked, or tampered): proof of work, which protects nothing on testnet
  test('proof sources blocked or tampered: every chain row says "checked", none "verified"', async ({ browser }) => {
    test.setTimeout(PER_LOAD_MS * 2);
    const proofs = /\/proofs$|\/v1\/quorum-proof/;
    for (const [name, t] of [
      ['blocked', (e: Parameters<Tamper>[0]) => (proofs.test(e.url) ? 'abort' : null)],
      ['tampered', (e: Parameters<Tamper>[0]) => { if (!proofs.test(e.url) || e.body.length < 600) return null; const b = Buffer.from(e.body); b[b.length - 400]! ^= 1; return { body: b }; }],
    ] as const) {
      const { page, ctx } = await open(browser, t as Tamper);
      const s = await settle(page);
      expect(s.level, name).not.toBe('verified');
      expect(s.states.collateral, name).not.toBe('proven');
      expect(s.states.chain, name).not.toBe('proven');
      const cc = s.drawer.getByTestId('collateral-check');
      for (const step of await cc.locator('[data-step]').all()) {
        const id = await step.getAttribute('data-step');
        if (['block', 'confirmations', 'chainlock', 'height'].includes(id!)) {
          await expect(step, `${name} ${id}`).toHaveAttribute('data-basis', 'reported');
          await expect(step, `${name} ${id}`).not.toContainText(/verified in this browser|BLS-verified/);
        }
      }
      expect(await glyphs(page, '[data-testid="collateral-check"] [data-step="block"], [data-testid="collateral-check"] [data-step="chainlock"]'), name).not.toContain('glyph-verified');
      expect(await glyphs(page, '[data-testid="chain-check"]'), name).not.toContain('glyph-verified');
      await ctx.close();
    }
  });

  // D-065: a saved ChainLock reused because the proof source answers 502 says the source failed, naming it once
  test('proof source 502 on a warm load: the trust root says the fetch failed, not "no newer one"', async ({ browser }) => {
    test.setTimeout(PER_LOAD_MS * 2);
    let warm = false;
    const { page } = await open(browser, (e) => (warm && /\/proofs$/.test(e.url) ? { status: 502, headers: { 'content-type': 'text/plain' }, body: Buffer.from('bad gateway') } : null));
    expect((await settle(page)).level).toBe('verified');
    warm = true;
    const s = await settle(page);
    await s.drawer.locator('[data-check="chain"] .check-more > summary').click();
    const how = s.drawer.getByTestId('chain-check').locator('details.how');
    await how.locator('summary').click();
    const trust = (await how.locator('dd').first().textContent())!;
    expect(trust).toContain('proved from that checkpoint earlier');
    expect(trust).toContain('no newer proof could be fetched');
    expect(trust).toContain('502');
    expect(trust).not.toContain('no newer one was available yet');
    const name = 'quorums.testnet.networks.dash.org';
    expect(trust.split(`${name}:`).length - 1).toBeLessThanOrEqual(1);
  });

  // D-020: a card whose check could not conclude shows it
  test('a card whose collateral check is inconclusive says "Couldn\'t verify", unlike one that passed', async ({ browser }) => {
    const txid = collateralTxid();
    const { page } = await open(browser, (e) => (getTx.test(e.url) && asks(e, txid) ? 'abort' : null));
    await page.goto('/?fixtures=0');
    const card = page.locator(`[data-testid="proposal-card"][data-govhash="${P}"]`);
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toHaveAttribute('data-check', 'inconclusive', { timeout: 90_000 });
    await expect(card.getByTestId('card-trust')).toHaveAttribute('data-trust', 'error');
    // a card whose check passed carries no such mark
    const other = page.locator('[data-testid="proposal-card"][data-check="ok"]').first();
    if (await other.count()) await expect(other.getByTestId('card-trust')).toHaveCount(0);
  });

  // D-012: the budget header's allocation is the cycle document's, not a sum of the tallies' flags
  test('budget header: tampered inNextBudget flags do not move "Allocated"', async ({ browser }) => {
    test.setTimeout(PER_LOAD_MS * 2);
    const truth = await open(browser);
    await truth.page.goto('/?fixtures=0');
    const facts = truth.page.locator('.budget-facts');
    await expect(facts).toContainText('Allocated', { timeout: 60_000 });
    const allocated = await facts.locator('div', { hasText: 'Allocated' }).locator('dd .num').textContent();
    await truth.ctx.close();
    const { page } = await open(browser, onUrl(talliesUrl, json((o) => { for (const t of o.tallies) t.inNextBudget = !t.inNextBudget; })));
    await page.goto('/?fixtures=0');
    await expect(page.locator('.budget-facts')).toContainText('Allocated', { timeout: 60_000 });
    await expect(page.locator('.budget-facts div', { hasText: 'Allocated' }).locator('dd .num')).toHaveText(allocated!);
    await expect(page.locator('.budget [data-prov]')).toHaveCount(0);
  });
});
