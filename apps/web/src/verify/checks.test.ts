// Hide rules: which proposals the lists and the budget header leave out, and how the background checks behave.
import { describe, expect, it } from 'vitest';
import { loadFixtures } from '../data/fixtures.ts';
import type { Proposal, Sourced, Tally } from '../data/types.ts';
import { GOV_PARAMS } from '../lib/governance.ts';
import { budgetView, deriveRow, partitionByCheck } from '../lib/view.ts';
import { forgetCheckResults, ProposalChecks, type CheckCache, type StoredCheck } from './checks.ts';
import { verdictFailure, verifyCollateral, type CollateralVerdict } from './collateral.ts';

const snap = await loadFixtures();
const real = snap.proposals[0]!;
const [tampered, noCollateral] = snap.invalid as [Proposal, Proposal];
const okVerdict: CollateralVerdict = { ok: true, steps: [] };

class MemCache implements CheckCache {
  m = new Map<string, StoredCheck>();
  async get(k: string) {
    return this.m.get(k);
  }
  async put(k: string, v: StoredCheck) {
    this.m.set(k, v);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
let scopes = 0;
const uniq = () => `test-${scopes++}`;

describe('collateral verdicts that hide a proposal', () => {
  it('a collateral every node says does not exist: failed', () => {
    const v = verifyCollateral(noCollateral, { error: 'Transaction not found', notFound: true });
    expect(v.inconclusive).toBeUndefined();
    expect(verdictFailure(v)).toMatch(/not on the chain/);
  });
  it('unreachable nodes: inconclusive, never a reason to hide', () => {
    const v = verifyCollateral(real, { error: 'all 4 node attempts failed: fetch failed' });
    expect(v.inconclusive).toBe(true);
    expect(verdictFailure(v)).toBeNull();
  });
  it('published fields that do not match the hashed data: failed', () => {
    expect(verdictFailure(verifyCollateral(tampered, { error: 'x', notFound: true }))).toMatch(/Displayed fields: differ from the hashed data: url/);
  });
  it('a disagreeing second node alone is about the nodes, not the proposal', () => {
    const v: CollateralVerdict = { ok: false, steps: [{ id: 'crosscheck', status: 'fail', label: 'Second node', detail: 'disagrees' }] };
    expect(verdictFailure(v)).toBeNull();
  });
  it('what one node can cause never hides: altered bytes, a low confirmation count', () => {
    const altered: CollateralVerdict = { ok: false, steps: [{ id: 'collateral', status: 'fail', basis: 'reported', label: 'OP_RETURN and outputs', detail: 'txid-mismatch' }] };
    const unsynced: CollateralVerdict = { ok: false, steps: [{ id: 'confirmations', status: 'fail', basis: 'reported', label: 'Confirmations', detail: '0' }] };
    const disagreeing: CollateralVerdict = { ok: false, steps: [{ id: 'collateral', status: 'fail', label: 'OP_RETURN and outputs', detail: 'no-matching-op-return' }, { id: 'crosscheck', status: 'fail', label: 'Second node', detail: 'different bytes' }] };
    for (const v of [altered, unsynced, disagreeing]) expect(verdictFailure(v)).toBeNull();
    // The real collateral (bytes hash to its txid) that does not burn to the gov hash is a fact about the proposal.
    expect(verdictFailure({ ok: false, steps: [{ id: 'collateral', status: 'fail', label: 'OP_RETURN and outputs', detail: 'no-matching-op-return' }] })).toMatch(/no-matching-op-return/);
  });
});

describe('ProposalChecks', () => {
  it('content failures are known at once, with no network', () => {
    let runs = 0;
    const c = new ProposalChecks({ scope: uniq(), run: async () => (runs++, okVerdict) });
    expect(c.state(tampered)).toMatchObject({ status: 'failed', reason: expect.stringContaining('url') });
    c.ensure([tampered]);
    expect(runs).toBe(0);
  });

  it('pending until the worker answers, then ok or failed; results are cached per govHash', async () => {
    const cache = new MemCache();
    const c = new ProposalChecks({ scope: 'dev', cache, run: async (p) => (p === noCollateral ? verifyCollateral(p, { error: 'not found', notFound: true }) : okVerdict) });
    expect(c.state(real)).toEqual({ status: 'pending' });
    c.ensure([real, noCollateral]);
    expect(c.state(real)).toEqual({ status: 'pending' });
    for (let i = 0; i < 5; i++) await tick();
    expect(c.state(real)).toEqual({ status: 'ok' });
    expect(c.state(noCollateral)).toMatchObject({ status: 'failed' });
    expect([...cache.m.keys()].every((k) => k.startsWith('dev:check:'))).toBe(true);

    // A new session (nothing in memory) reads the cache and runs nothing while the results are fresh.
    forgetCheckResults();
    let runs = 0;
    const again = new ProposalChecks({ scope: 'dev', cache, run: async () => (runs++, okVerdict) });
    again.ensure([real, noCollateral]);
    await tick();
    await tick();
    expect(again.state(noCollateral).status).toBe('failed');
    expect(runs).toBe(0);
  });

  it('re-checks stale cached results in the background, showing the cached state meanwhile', async () => {
    const cache = new MemCache();
    let now = 1_000_000_000_000;
    const scope = uniq();
    const first = new ProposalChecks({ scope, cache, now: () => now, run: async () => verifyCollateral(noCollateral, { error: 'nf', notFound: true }) });
    first.ensure([noCollateral]);
    for (let i = 0; i < 5; i++) await tick();
    now += 2 * 86_400_000;
    forgetCheckResults();
    let release!: () => void;
    const second = new ProposalChecks({ scope, cache, now: () => now, run: () => new Promise((r) => (release = () => r(okVerdict))) });
    second.ensure([noCollateral]);
    for (let i = 0; i < 3; i++) await tick();
    expect(second.state(noCollateral).status).toBe('failed');
    release();
    for (let i = 0; i < 3; i++) await tick();
    expect(second.state(noCollateral).status).toBe('ok');
  });

  it('runs at most `concurrency` checks at once', async () => {
    let inFlight = 0;
    let max = 0;
    const c = new ProposalChecks({
      scope: uniq(),
      concurrency: 2,
      run: async () => {
        inFlight++;
        max = Math.max(max, inFlight);
        await tick();
        inFlight--;
        return okVerdict;
      },
    });
    c.ensure(snap.proposals);
    for (let i = 0; i < 60; i++) await tick();
    expect(max).toBe(2);
    expect(snap.proposals.every((p) => c.state(p).status === 'ok')).toBe(true);
  });

  it('an inconclusive check never hides, and never overrides a definite result', async () => {
    const cache = new MemCache();
    const c = new ProposalChecks({ scope: uniq(), cache, run: async () => Promise.reject(new Error('worker crashed')) });
    c.ensure([real]);
    for (let i = 0; i < 5; i++) await tick();
    expect(c.state(real).status).toBe('inconclusive');
    expect(cache.m.size).toBe(0);
    c.record(real, okVerdict);
    c.record(real, verifyCollateral(real, { error: 'timeout' }));
    expect(c.state(real).status).toBe('ok');
  });

  it('notifies subscribers once per batch of results', async () => {
    const c = new ProposalChecks({ scope: uniq(), run: async () => okVerdict });
    let calls = 0;
    c.subscribe(() => calls++);
    c.record(real, okVerdict);
    c.record(snap.proposals[1]!, okVerdict);
    await tick();
    expect(calls).toBe(1);
    expect(c.version).toBe(2);
  });

  it('a full check outranks a later light result; a disposed instance does nothing', async () => {
    const c = new ProposalChecks({ scope: uniq(), run: async () => okVerdict });
    c.record(noCollateral, verifyCollateral(noCollateral, { error: 'nf', notFound: true }), { full: true });
    c.record(noCollateral, okVerdict);
    expect(c.state(noCollateral).status).toBe('failed');
    let runs = 0;
    const d = new ProposalChecks({ scope: uniq(), run: async () => (runs++, okVerdict) });
    d.dispose();
    d.ensure([real]);
    for (let i = 0; i < 3; i++) await tick();
    expect(runs).toBe(0);
    expect(d.state(real).status).toBe('pending');
  });

  it('instances of one scope share results (a rebuilt source does not flash hidden proposals back as pending)', () => {
    const scope = uniq();
    new ProposalChecks({ scope, run: async () => okVerdict }).record(noCollateral, verifyCollateral(noCollateral, { error: 'nf', notFound: true }));
    expect(new ProposalChecks({ scope, run: async () => okVerdict }).state(noCollateral).status).toBe('failed');
    expect(new ProposalChecks({ scope: uniq(), run: async () => okVerdict }).state(noCollateral).status).toBe('pending');
  });
});

describe('hide rules in the lists and the budget header', () => {
  const prov = { kind: 'proof', source: 'test' } as const;
  const sp = (p: Proposal): Sourced<Proposal> => ({ value: p, prov });
  const tally = (govHash: string, inNextBudget: boolean): Sourced<Tally> => ({
    value: { govHash, asOfHeight: 1, yesWeighted: 500, noWeighted: 0, abstainWeighted: 0, yesCount: 500, noCount: 0, abstainCount: 0, voteSetHash: '', rank: 1, inNextBudget, margin: 0 },
    prov,
  });

  it('failed proposals are hidden; pending and inconclusive stay listed', () => {
    const c = new ProposalChecks({ scope: uniq(), run: async () => okVerdict });
    const second = snap.proposals[1]!;
    c.record(second, verifyCollateral(second, { error: 'timeout' }));
    const { shown, failed } = partitionByCheck([real, second, tampered], (p) => c.state(p));
    expect(shown.map((x) => [x.item.name, x.check.status])).toEqual([
      [real.name, 'pending'],
      [second.name, 'inconclusive'],
    ]);
    expect(failed.map((x) => x.item.name)).toEqual(['govhub-fixture-tampered']);
  });

  it('hidden proposals count for nothing: not allocated, not in the next budget, not active', () => {
    const tallies = new Map([
      [real.govHash, tally(real.govHash, true)],
      [tampered.govHash, tally(tampered.govHash, true)],
    ]);
    const row = (p: Proposal) => deriveRow(sp(p), tallies, new Map(), null, GOV_PARAMS.mainnet, snap.now);
    const allocated = real.paymentAmount + tampered.paymentAmount;
    const b = budgetView([row(real)], [row(tampered)], { allocated });
    expect(b.funded.map((r) => r.p.value.name)).toEqual([real.name]);
    expect(b.allocated).toBe(real.paymentAmount);
    expect(b.fundedSum).toBe(real.paymentAmount);
    expect(b.active).toBe(1);
  });
});
