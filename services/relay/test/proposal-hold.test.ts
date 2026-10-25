// POST /v1/proposals (held submission), GET /v1/proposals/:id and the worker that runs `gobject submit` once the collateral has
// MIN_COLLATERAL_CONFS confirmations. Real regtest fixtures recorded from dashd (packages/verify/test/fixtures).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreRpcError } from '../src/core/rpc.ts';
import { log } from '../src/log.ts';
import { MAX_PROPOSALS_PER_HASH, PROPOSAL_ERROR } from '../src/proposer.ts';
import { Relay } from '../src/relay.ts';
import { World } from './world.ts';

interface Fx {
  label: string;
  time: number;
  dataHex: string;
  txid: string;
  coreHash: string;
  rawTx: string;
}
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../packages/verify/test/fixtures/${name}`, import.meta.url), 'utf8'));
const proposals = fixture('proposals.regtest.json').proposals as Fx[];
const scenarios = fixture('collateral.regtest.json').scenarios as Fx[];
const basic = proposals.find((p) => p.label === 'p2pkh-basic')!;
const p2sh = proposals.find((p) => p.label === 'p2sh-payout')!;
const good = scenarios.find((p) => p.label === 'good-exact')!;
const p2shOutput = scenarios.find((p) => p.label === 'bad-extra-p2sh-output')!;
const END_EPOCH = 1_887_414_577; // all fixtures

/** stored event times are kept to the hour */
const hour = (t: number) => t - (t % 3600);
/** the next check `d` s after `now` on the PROPOSAL_CHECK_S (30 s) grid, as the worker schedules it */
const nextAt = (now: number, d: number) => {
  const t = Math.floor((now + d) / 30) * 30;
  return t > now ? t : t + 30;
};

const bodyOf = (p: Fx, extra: Record<string, unknown> = {}) => ({ network: 'regtest', parentHash: '0', revision: 1, time: p.time, dataHex: p.dataHex, collateralTxid: p.txid, ...extra });

/** confirmations: null = in the mempool (no `confirmations` field) */
function setup(env: Record<string, string> = {}, confirmations: number | null = 0) {
  const w = new World('regtest', env);
  w.clock.t = basic.time + 100;
  for (const p of [basic, p2sh, good, p2shOutput]) w.core.rawTxs.set(p.txid, { hex: p.rawTx, confirmations: 8 });
  setConfs(w, basic.txid, confirmations);
  w.core.submitResult = basic.coreHash;
  return w;
}

function setConfs(w: World, txid: string, n: number | null): void {
  const tx = w.core.rawTxs.get(txid)!;
  if (n === null) delete (tx as { confirmations?: number }).confirmations;
  else tx.confirmations = n;
}

async function hold(w: World, p: Fx = basic) {
  const r = await w.post('/v1/proposals', bodyOf(p));
  if (r.status !== 202) throw new Error(`hold failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; status: string };
}

/** Advance the clock and run one worker pass. */
async function step(w: World, s: number) {
  w.clock.advance(s);
  await w.proposer.tick();
}

const submits = (w: World) => w.core.calls.filter((c) => c.method === 'gobject' && c.params[0] === 'submit');

describe('POST /v1/proposals: accept and hold', () => {
  it('holds a mempool collateral, keeps waiting at 3 confirmations, submits with the exact params once Core counts 6', async () => {
    const w = setup({}, null);
    const t0 = w.clock.t;
    const r = await w.post('/v1/proposals', bodyOf(basic));
    expect(r.status).toBe(202);
    expect(r.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      govHash: basic.coreHash,
      collateralTxid: basic.txid,
      status: 'waiting',
      confirmations: 0,
      minConfirmations: 6,
      attempts: 0,
      lastError: null,
      nextAttemptAt: t0,
      submittedAt: null,
      finishedAt: null,
    });
    const id = r.body.id as string;
    expect(w.core.calls.map((c) => c.method)).toEqual(['getrawtransaction']);
    // due at once (the row keeps no exact receive second), then every PROPOSAL_CHECK_S
    expect(w.proposalRow(id).next_attempt_at).toBe(t0 - (t0 % 3600));
    await w.proposer.tick();
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', confirmations: 0, next_attempt_at: nextAt(t0, 30) });
    await step(w, 10); // not due yet
    expect(w.core.calls.length).toBe(2);

    setConfs(w, basic.txid, 3);
    await step(w, 20);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', confirmations: 3, next_attempt_at: nextAt(t0 + 30, 30), last_error: null });
    expect(submits(w)).toEqual([]);

    setConfs(w, basic.txid, 5);
    await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', confirmations: 5 });
    expect(submits(w)).toEqual([]);

    setConfs(w, basic.txid, 6);
    await step(w, 30);
    expect(submits(w).map((c) => c.params)).toEqual([['submit', '0', 1, basic.time, basic.dataHex, basic.txid]]);
    const g = await w.get(`/v1/proposals/${id}`);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ ...r.body, status: 'submitted', confirmations: 6, attempts: 1, nextAttemptAt: null, submittedAt: hour(w.clock.t), finishedAt: hour(w.clock.t) });
    // final: nothing more happens
    await step(w, 3600);
    expect(submits(w).length).toBe(1);
  });

  it('submits within the request when the collateral is already deep enough', async () => {
    const w = setup({}, 8);
    const r = await w.post('/v1/proposals', bodyOf(basic));
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'submitted', confirmations: 6, attempts: 1, lastError: null, submittedAt: hour(w.clock.t), nextAttemptAt: null });
    expect(submits(w).map((c) => c.params)).toEqual([['submit', '0', 1, basic.time, basic.dataHex, basic.txid]]);
    expect(w.core.count('getrawtransaction')).toBe(1);

    // the same path reports Core's refusal right away
    w.core.submitError = new CoreRpcError('gobject', -8, 'Invalid proposal data, error messages: something');
    w.core.submitResult = p2sh.coreHash;
    const rej = await w.post('/v1/proposals', bodyOf(p2sh));
    expect(rej.status).toBe(202);
    expect(rej.body).toMatchObject({ status: 'failed', lastError: 'core-rejected', coreMessage: 'Invalid proposal data, error messages: something', finishedAt: hour(w.clock.t) });
  });

  it('a second POST while the immediate submit is in flight gets the same record (submitting), and only one submit goes out', async () => {
    const w = setup({}, 8);
    let open!: () => void;
    w.core.submitGate = new Promise<void>((r) => (open = r));
    const first = w.post('/v1/proposals', bodyOf(basic));
    for (let i = 0; i < 50 && !w.store.findProposal(basic.coreHash, basic.txid); i++) await new Promise((r) => setImmediate(r));
    const again = await w.post('/v1/proposals', bodyOf(basic));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'submitting', attempts: 1 });
    open();
    const r = await first;
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ id: again.body.id, status: 'submitted' });
    expect(submits(w).length).toBe(1);
  });

  it('accepts an all-zero parentHash and mixed-case hex (stored lowercase)', async () => {
    const w = setup();
    const r = await w.post('/v1/proposals', bodyOf(basic, { parentHash: '0'.repeat(64), dataHex: basic.dataHex.toUpperCase(), collateralTxid: basic.txid.toUpperCase() }));
    expect(r.status).toBe(202);
    expect(w.proposalRow(r.body.id)).toMatchObject({ gov_hash: basic.coreHash, collateral_txid: basic.txid, data_hex: basic.dataHex });
  });

  it('is idempotent in every state: same id, 200, no Core call', async () => {
    const w = setup({}, 2);
    const first = await hold(w);
    const again = async () => {
      const before = w.core.calls.length;
      const r = await w.post('/v1/proposals', bodyOf(basic));
      expect(w.core.calls.length).toBe(before);
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(first.id);
      return r.body;
    };
    expect(await again()).toMatchObject({ status: 'waiting', confirmations: 2 });
    w.store.markProposalSubmitting(first.id, 6);
    expect(await again()).toMatchObject({ status: 'submitting' });
    w.store.proposalWait(first.id, 'submitting', { confirmations: 6, at: w.clock.t, code: null, failN: 0, missingSince: null });
    setConfs(w, basic.txid, 6);
    await w.proposer.tick();
    expect(await again()).toMatchObject({ status: 'submitted' });

    // a failed one too (and an equal body in other casing is the same record)
    w.core.submitError = new CoreRpcError('gobject', -32603, 'nope');
    w.core.submitResult = p2sh.coreHash;
    const failed = await w.post('/v1/proposals', bodyOf(p2sh));
    expect(failed.body.status).toBe('failed');
    const n = w.core.calls.length;
    const re = await w.post('/v1/proposals', bodyOf(p2sh, { dataHex: p2sh.dataHex.toUpperCase() }));
    expect(re.status).toBe(200);
    expect(re.body).toEqual(failed.body);
    expect(w.core.calls.length).toBe(n);
  });

  it(`caps rows per gov hash at ${MAX_PROPOSALS_PER_HASH} (409 too-many-collaterals) before asking Core`, async () => {
    const w = setup();
    for (let i = 0; i < MAX_PROPOSALS_PER_HASH; i++) {
      w.store.insertProposal({ id: `${i}`.padStart(32, '0'), gov_hash: basic.coreHash, collateral_txid: `${i}`.padStart(64, 'a'), time: basic.time, data_hex: basic.dataHex, confirmations: 0, next_attempt_at: w.clock.t, received_hour: 0 });
    }
    const r = await w.post('/v1/proposals', bodyOf(basic));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('too-many-collaterals');
    expect(w.core.calls.length).toBe(0);
    // another proposal is not affected
    expect((await w.post('/v1/proposals', bodyOf(good))).status).toBe(202);
  });

  it('answers 503 relay-full at MAX_HELD_PROPOSALS waiting rows; a submitted row frees its slot', async () => {
    const w = setup({ MAX_HELD_PROPOSALS: '1' }, 0);
    const held = await hold(w);
    const n = w.core.calls.length;
    const full = await w.post('/v1/proposals', bodyOf(good));
    expect(full.status).toBe(503);
    expect(full.body.code).toBe('relay-full');
    expect(full.headers.get('retry-after')).toBe('60');
    expect(w.core.calls.length).toBe(n);
    // the held one can still be looked at again
    expect((await w.post('/v1/proposals', bodyOf(basic))).status).toBe(200);
    expect((await w.get('/v1/status')).body).toMatchObject({ proposalHold: true, proposalSubmit: true });
    expect((await w.get('/v1/status')).body.heldProposals).toBeUndefined(); // no count: it would hint which relay took a burn

    setConfs(w, basic.txid, 6);
    await step(w, 30);
    expect(w.proposalRow(held.id).status).toBe('submitted');
    expect((await w.post('/v1/proposals', bodyOf(good))).status).toBe(202);
  });
});

describe('POST /v1/proposals: refusals', () => {
  it('validates the body exactly like /v1/proposals/submit, before touching Core', async () => {
    const w = setup();
    const body = bodyOf(basic);
    const bad: Array<[unknown, string]> = [
      ['[1]', 'bad-request'],
      [[], 'bad-request'],
      [{ ...body, network: 'mainnet' }, 'wrong-network'],
      [{ ...body, parentHash: 'aa'.repeat(32) }, 'bad-request'],
      [{ ...body, revision: 2 }, 'bad-request'],
      [{ ...body, time: 'now' }, 'bad-request'],
      [{ ...body, time: 0 }, 'bad-request'],
      [{ ...body, dataHex: 'xyz' }, 'bad-request'],
      [{ ...body, collateralTxid: 'abc' }, 'bad-request'],
      [{ ...body, extra: true }, 'bad-request'],
      [{ ...body, govHash: basic.coreHash }, 'bad-request'],
      [{ ...body, dataHex: '7b7d' }, 'bad-proposal'],
    ];
    for (const [b, code] of bad) {
      const r = await w.post('/v1/proposals', b);
      expect(r.status, JSON.stringify(b).slice(0, 80)).toBe(400);
      expect(r.body.code).toBe(code);
    }
    expect((await w.post('/v1/proposals', '{broken')).body.code).toBe('bad-request');
    expect(w.core.calls.length).toBe(0);
    expect(w.store.countProposalsForHash(basic.coreHash)).toBe(0);
  });

  it('refuses an expired proposal (Core validates end_epoch on submit)', async () => {
    const w = setup();
    w.clock.t = END_EPOCH;
    const r = await w.post('/v1/proposals', bodyOf(basic));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('bad-proposal');
    expect(w.core.calls.length).toBe(0);
  });

  it('refuses a collateral for another hash, one with a P2SH output, and bytes that are not the named tx', async () => {
    const w = setup();
    const other = await w.post('/v1/proposals', bodyOf(basic, { collateralTxid: p2sh.txid }));
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({ code: 'bad-collateral', failure: 'no-matching-op-return' });
    const script = await w.post('/v1/proposals', bodyOf(p2shOutput));
    expect(script.status).toBe(400);
    expect(script.body).toMatchObject({ code: 'bad-collateral', failure: 'invalid-output-script' });
    w.core.rawTxs.set(basic.txid, { hex: p2sh.rawTx, confirmations: 0 });
    expect((await w.post('/v1/proposals', bodyOf(basic))).body).toMatchObject({ code: 'bad-collateral', failure: 'txid-mismatch' });
    expect(w.store.countHeldProposals()).toBe(0);
  });

  it('answers 404 unknown-collateral (retry later) and 503 core-unavailable, storing nothing', async () => {
    const w = setup();
    const r = await w.post('/v1/proposals', bodyOf(basic, { collateralTxid: 'cd'.repeat(32) }));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('unknown-collateral');
    w.core.down = true;
    const down = await w.post('/v1/proposals', bodyOf(basic));
    expect(down.status).toBe(503);
    expect(down.body.code).toBe('core-unavailable');
    expect(w.store.countHeldProposals()).toBe(0);
    // once it propagated, the same request is accepted
    w.core.down = false;
    expect((await w.post('/v1/proposals', bodyOf(basic))).status).toBe(202);
  });

  it('is disabled with PROPOSAL_SUBMIT=0: both new endpoints answer 501 and the worker does nothing', async () => {
    const w = setup({ PROPOSAL_SUBMIT: '0' });
    const r = await w.post('/v1/proposals', bodyOf(basic));
    expect(r.status).toBe(501);
    expect(r.body.code).toBe('disabled');
    expect((await w.get(`/v1/proposals/${'ab'.repeat(16)}`)).status).toBe(501);
    w.store.insertProposal({ id: 'ab'.repeat(16), gov_hash: basic.coreHash, collateral_txid: basic.txid, time: basic.time, data_hex: basic.dataHex, confirmations: 0, next_attempt_at: 0, received_hour: 0 });
    await step(w, 60);
    expect(w.core.calls.length).toBe(0);
    expect((await w.get('/v1/status')).body).toMatchObject({ proposalSubmit: false, proposalHold: true });
  });
});

describe('GET /v1/proposals/:id', () => {
  it('404 not-found for an unknown id; the gov hash is not a handle', async () => {
    const w = setup();
    await hold(w);
    const unknown = await w.get(`/v1/proposals/${'00'.repeat(16)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('not-found');
    const byHash = await w.get(`/v1/proposals/${basic.coreHash}`);
    expect(byHash.status).toBe(400);
    expect(byHash.body.code).toBe('bad-request');
  });

  it('only POST on /v1/proposals and only GET on /v1/proposals/:id', async () => {
    const w = setup();
    expect((await w.app.request('/v1/proposals')).status).toBe(405);
    expect((await w.app.request('/v1/proposals/submit')).status).toBe(405);
    const post = await w.app.request(`/v1/proposals/${'00'.repeat(16)}`, { method: 'POST', body: '{}' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
  });
});

describe('held proposal worker', () => {
  it('fails an expired proposal without submitting it', async () => {
    const w = setup();
    const { id } = await hold(w);
    w.clock.t = END_EPOCH;
    await w.proposer.tick();
    expect(w.proposalRow(id)).toMatchObject({ status: 'failed', last_error: 'expired', finished_at: hour(END_EPOCH) });
    expect(w.core.count('getrawtransaction')).toBe(1);
  });

  it('keeps waiting while the collateral is missing, fails after PROPOSAL_MISSING_S, and forgets a gap once it is back', async () => {
    const w = setup();
    const { id } = await hold(w);
    const tx = w.core.rawTxs.get(basic.txid)!;
    w.core.rawTxs.delete(basic.txid);
    await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', last_error: 'collateral-missing', missing_since: w.clock.t - (w.clock.t % 30) });
    // back: the gap is forgotten
    w.core.rawTxs.set(basic.txid, tx);
    await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', last_error: null, missing_since: null });
    // gone for good
    w.core.rawTxs.delete(basic.txid);
    await step(w, 30);
    const since = w.proposalRow(id).missing_since!;
    while (w.clock.t + 30 <= since + 21_600) await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', missing_since: since });
    await step(w, 30);
    expect(w.clock.t - since).toBeGreaterThan(21_600);
    expect(w.proposalRow(id)).toMatchObject({ status: 'failed', last_error: 'collateral-missing', finished_at: hour(w.clock.t) });
    expect(submits(w)).toEqual([]);
  });

  it('a re-POST holds a proposal again that failed for a reason that can pass; a final failure stays', async () => {
    const w = setup();
    const { id } = await hold(w);
    const tx = w.core.rawTxs.get(basic.txid)!;
    w.core.rawTxs.delete(basic.txid);
    for (let i = 0; i < 800 && w.proposalRow(id).status !== 'failed'; i++) await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'failed', last_error: 'collateral-missing' });
    w.core.rawTxs.set(basic.txid, tx);
    setConfs(w, basic.txid, 6);
    const again = await w.post('/v1/proposals', bodyOf(basic));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id, status: 'waiting', lastError: null });
    expect(w.proposalRow(id).received_hour).toBe(hour(w.clock.t));
    await step(w, 30);
    expect(w.proposalRow(id).status).toBe('submitted');
    // stored depth is capped at the minimum (a deeper count would date the request)
    expect(w.proposalRow(id).confirmations).toBe(6);
  });

  it('stores a deep collateral\'s confirmations capped at MIN_COLLATERAL_CONFS', async () => {
    const w = setup({}, 500);
    const r = await w.post('/v1/proposals', bodyOf(basic));
    expect(r.body).toMatchObject({ status: 'submitted', confirmations: 6 });
  });

  it('fails as unconfirmed PROPOSAL_MAX_WAIT_S after the hour it was received', async () => {
    const w = setup({}, 1);
    const { id } = await hold(w);
    const hour = w.proposalRow(id).received_hour;
    expect(hour % 3600).toBe(0);
    w.clock.t = hour + 259_200 - 1;
    await w.proposer.tick();
    expect(w.proposalRow(id).status).toBe('waiting');
    await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'failed', last_error: 'unconfirmed', confirmations: 1 });
  });

  it('retries a node that is not synced yet (-10) with a doubling backoff, then submits', async () => {
    const w = setup({}, 2);
    const { id } = await hold(w);
    setConfs(w, basic.txid, 6);
    const sync = () => new CoreRpcError('gobject', -10, 'Must wait for client to sync with masternode network. Try again in a minute or so.');
    w.core.submitErrors.push(sync(), sync());
    await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', last_error: 'core-syncing', fail_n: 1, attempts: 1, next_attempt_at: nextAt(w.clock.t, 30) });
    await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', last_error: 'core-syncing', fail_n: 2, attempts: 2, next_attempt_at: nextAt(w.clock.t, 60) });
    await step(w, 30); // not due
    expect(submits(w).length).toBe(2);
    await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'submitted', attempts: 3, last_error: null, fail_n: 0 });
  });

  it('goes back to waiting when Core refuses the collateral after a reorg, and submits once it is deep again', async () => {
    const w = setup({}, 2);
    const { id } = await hold(w);
    setConfs(w, basic.txid, 6);
    // Core's real text: IsValidLocally replaces every collateral error with "Invalid proposal collateral"
    w.core.submitErrors.push(new CoreRpcError('gobject', -32603, `Governance object is not valid - ${basic.coreHash} - Invalid proposal collateral`));
    const call = w.core.call.bind(w.core);
    let reorgOnSubmit = true;
    (w.core as { call: unknown }).call = async (method: string, params: unknown[] = []) => {
      if (method === 'gobject' && params[0] === 'submit' && reorgOnSubmit) setConfs(w, basic.txid, 0);
      return call(method, params);
    };
    await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', last_error: 'collateral-reorg', confirmations: 0, attempts: 1 });
    expect(w.core.count('getrawtransaction')).toBe(3); // POST, check, re-check after the refusal
    reorgOnSubmit = false;
    setConfs(w, basic.txid, 4);
    await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', confirmations: 4, last_error: null });
    setConfs(w, basic.txid, 6);
    await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'submitted', attempts: 2 });
  });

  it('a collateral refusal while Core itself still counts enough confirmations is final (core-rejected)', async () => {
    const w = setup({}, 2);
    const { id } = await hold(w);
    setConfs(w, basic.txid, 9);
    w.core.submitErrors.push(new CoreRpcError('gobject', -32603, 'Governance object is not valid - x - Collateral requires at least 6 confirmations to be relayed throughout the network (it has only 9)'));
    await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'failed', last_error: 'core-rejected' });
  });

  it('records any other Core refusal as final core-rejected with Core message trimmed to 200 characters', async () => {
    const w = setup({}, 3);
    const { id } = await hold(w);
    setConfs(w, basic.txid, 6);
    const long = 'Invalid proposal data, error messages: ' + 'x'.repeat(400);
    w.core.submitError = new CoreRpcError('gobject', -8, long);
    await step(w, 30);
    const g = await w.get(`/v1/proposals/${id}`);
    expect(g.body).toMatchObject({ status: 'failed', lastError: 'core-rejected', coreMessage: long.slice(0, 200), attempts: 1, nextAttemptAt: null, finishedAt: hour(w.clock.t) });
    await step(w, 3600);
    expect(submits(w).length).toBe(1);
  });

  it('fails core-hash-mismatch when gobject submit returns another hash', async () => {
    const w = setup({}, 3);
    const { id } = await hold(w);
    setConfs(w, basic.txid, 6);
    w.core.submitResult = p2sh.coreHash;
    await step(w, 30);
    const g = await w.get(`/v1/proposals/${id}`);
    expect(g.body).toMatchObject({ status: 'failed', lastError: 'core-hash-mismatch' });
    expect(g.body).not.toHaveProperty('coreMessage');
  });

  it('retries transport errors (getrawtransaction and gobject submit) without failing', async () => {
    const w = setup({}, 0);
    const { id } = await hold(w);
    w.core.down = true;
    await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', last_error: 'core-error', fail_n: 1, next_attempt_at: nextAt(w.clock.t, 30) });
    await step(w, 30);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', last_error: 'core-error', fail_n: 2, next_attempt_at: nextAt(w.clock.t, 60) });
    for (let i = 0; i < 20; i++) await step(w, 600);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', last_error: 'core-error', next_attempt_at: nextAt(w.clock.t, 600) });
    w.core.down = false;
    setConfs(w, basic.txid, 6);
    w.core.submitErrors.push(new Error('fetch failed: ETIMEDOUT'));
    await step(w, 600);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', last_error: 'core-error', attempts: 1 });
    await step(w, 600);
    expect(w.proposalRow(id)).toMatchObject({ status: 'submitted', attempts: 2 });
    expect(submits(w).length).toBe(2);
  });

  it('a row left in submitting by a crash goes back to waiting at start-up and is submitted again', async () => {
    const w = setup({}, 2);
    const { id } = await hold(w);
    setConfs(w, basic.txid, 6);
    expect(w.store.markProposalSubmitting(id, 6)).toBe(true);
    const restarted = new Relay(w.cfg, w.store, w.core, w.clock.now);
    expect(w.proposalRow(id)).toMatchObject({ status: 'waiting', last_error: 'core-error', next_attempt_at: w.clock.t });
    await restarted.proposer.tick();
    expect(w.proposalRow(id)).toMatchObject({ status: 'submitted', attempts: 2 });
  });

  it('purges final rows RETENTION_DAYS after they finished; waiting rows stay', async () => {
    const w = setup({}, 8);
    const done = await hold(w);
    expect(done.status).toBe('submitted');
    setConfs(w, good.txid, 1);
    const waiting = await hold(w, good);
    expect(waiting.status).toBe('waiting');
    const finished = w.proposalRow(done.id).finished_at!;
    expect(finished % 3600).toBe(0);
    w.clock.t = finished + 7 * 86400;
    expect(w.broadcaster.tickPurge().proposals).toBe(0);
    w.clock.advance(1);
    expect(w.broadcaster.tickPurge().proposals).toBe(1);
    expect((await w.get(`/v1/proposals/${done.id}`)).status).toBe(404);
    expect(w.proposalRow(waiting.id).status).toBe('waiting');
  });
});

describe('logs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    log.setLevel('error');
  });

  it('carry only the row id and a short code: never a gov hash, txid, proposal data or Core text', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => (lines.push(String(s)), true)) as never);
    log.setLevel('debug');
    const w = setup({}, 0);
    const { id } = await hold(w);
    w.core.down = true;
    await step(w, 30);
    w.core.down = false;
    setConfs(w, basic.txid, 6);
    w.core.submitErrors.push(new CoreRpcError('gobject', -10, 'Must wait for client to sync with masternode network. Try again in a minute or so.'));
    await step(w, 60);
    w.core.submitError = new CoreRpcError('gobject', -32603, `secret-core-text ${basic.coreHash}`);
    await step(w, 60);
    expect(w.proposalRow(id)).toMatchObject({ status: 'failed', last_error: PROPOSAL_ERROR.coreRejected });
    // and a submitted one
    w.core.submitError = null;
    w.core.submitResult = good.coreHash;
    expect((await w.post('/v1/proposals', bodyOf(good))).body.status).toBe('submitted');

    const text = lines.join('');
    expect(text).toContain(id);
    expect(text).toContain('core-rejected');
    for (const needle of [basic.coreHash, basic.txid, basic.dataHex, good.coreHash, good.txid, 'secret-core-text', 'Must wait']) expect(text.includes(needle), needle).toBe(false);
  });
});
