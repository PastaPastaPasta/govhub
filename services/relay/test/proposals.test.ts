// POST /v1/proposals/submit, on the regtest fixtures recorded from a real dashd (packages/verify/test/fixtures/proposals.regtest.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CoreRpcError } from '../src/core/rpc.ts';
import { World } from './world.ts';

interface Fx {
  label: string;
  parent: string;
  revision: number;
  time: number;
  dataHex: string;
  txid: string;
  coreHash: string;
  rawTx: string;
}
const fx = JSON.parse(readFileSync(new URL('../../../packages/verify/test/fixtures/proposals.regtest.json', import.meta.url), 'utf8')).proposals as Fx[];
const basic = fx.find((p) => p.label === 'p2pkh-basic')!;
const p2sh = fx.find((p) => p.label === 'p2sh-payout')!;

function setup(env: Record<string, string> = {}, confirmations = 8) {
  const w = new World('regtest', env);
  w.clock.t = basic.time + 100;
  w.core.rawTxs.set(basic.txid, { hex: basic.rawTx, confirmations });
  w.core.rawTxs.set(p2sh.txid, { hex: p2sh.rawTx, confirmations });
  w.core.submitResult = basic.coreHash;
  const body = { network: 'regtest', parentHash: '0', revision: 1, time: basic.time, dataHex: basic.dataHex, collateralTxid: basic.txid };
  return { w, body };
}

describe('proposal submit', () => {
  it('re-verifies everything and then calls gobject submit', async () => {
    const { w, body } = setup();
    const r = await w.post('/v1/proposals/submit', body);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ govHash: basic.coreHash, result: basic.coreHash, postponed: false });
    expect(w.core.calls.find((c) => c.method === 'gobject')!.params).toEqual(['submit', '0', 1, basic.time, basic.dataHex, basic.txid]);
    expect(w.core.calls.find((c) => c.method === 'getrawtransaction')!.params).toEqual([basic.txid, true]);
  });

  it('accepts an all-zero parentHash, mixed-case hex and the regtest p2sh payout fixture', async () => {
    const { w, body } = setup();
    const r1 = await w.post('/v1/proposals/submit', { ...body, parentHash: '0'.repeat(64), dataHex: body.dataHex.toUpperCase(), collateralTxid: body.collateralTxid.toUpperCase() });
    expect(r1.status).toBe(200);
    w.core.submitResult = p2sh.coreHash;
    const r2 = await w.post('/v1/proposals/submit', { ...body, time: p2sh.time, dataHex: p2sh.dataHex, collateralTxid: p2sh.txid });
    expect(r2.body.govHash).toBe(p2sh.coreHash);
  });

  it('answers 425 below 6 confirmations without a ChainLock and never submits early', async () => {
    const { w, body } = setup({}, 3);
    const r = await w.post('/v1/proposals/submit', body);
    expect(r.status).toBe(425);
    expect(r.body).toMatchObject({ code: 'collateral-unconfirmed', confirmations: 3, chainlock: false });
    expect(w.core.count('gobject', 'submit')).toBe(0);
    w.core.rawTxs.get(basic.txid)!.confirmations = 6;
    expect((await w.post('/v1/proposals/submit', body)).status).toBe(200);
  });

  it('treats a transaction without confirmations (mempool) as unconfirmed', async () => {
    const { w, body } = setup();
    delete (w.core.rawTxs.get(basic.txid) as { confirmations?: number }).confirmations;
    const r = await w.post('/v1/proposals/submit', body);
    expect(r.status).toBe(425);
    expect(r.body.confirmations).toBe(0);
  });

  it('submits at 1 confirmation in a ChainLocked block and says Core postponed it until 6', async () => {
    const { w, body } = setup({}, 1);
    w.core.rawTxs.get(basic.txid)!.chainlock = true;
    const r = await w.post('/v1/proposals/submit', body);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ govHash: basic.coreHash, result: basic.coreHash, postponed: true });
    expect(w.core.postponed.get(basic.coreHash)).toBe(basic.txid);
  });

  it('with MIN_COLLATERAL_CONFS=6 a ChainLock is not enough: 425 until 6', async () => {
    const { w, body } = setup({ MIN_COLLATERAL_CONFS: '6' }, 5);
    w.core.rawTxs.get(basic.txid)!.chainlock = true;
    expect((await w.post('/v1/proposals/submit', body)).status).toBe(425);
    w.core.rawTxs.get(basic.txid)!.confirmations = 6;
    expect((await w.post('/v1/proposals/submit', body)).body).toMatchObject({ postponed: false });
  });

  it('is disabled with PROPOSAL_SUBMIT=0 (501) and says so in /v1/status', async () => {
    const { w, body } = setup({ PROPOSAL_SUBMIT: '0' });
    const r = await w.post('/v1/proposals/submit', body);
    expect(r.status).toBe(501);
    expect(r.body.code).toBe('disabled');
    expect(w.core.calls.length).toBe(0);
    expect((await w.get('/v1/status')).body.proposalSubmit).toBe(false);
  });

  it('rejects malformed requests before touching Core', async () => {
    const { w, body } = setup();
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ ...body, network: 'mainnet' }, 'wrong-network'],
      [{ ...body, parentHash: 'aa'.repeat(32) }, 'bad-request'],
      [{ ...body, parentHash: 0 }, 'bad-request'],
      [{ ...body, revision: 2 }, 'bad-request'],
      [{ ...body, time: 'now' }, 'bad-request'],
      [{ ...body, dataHex: 'xyz' }, 'bad-request'],
      [{ ...body, dataHex: '' }, 'bad-request'],
      [{ ...body, collateralTxid: 'abc' }, 'bad-request'],
      [{ ...body, extra: true }, 'bad-request'],
      [{ ...body, dataHex: '7b7d' }, 'bad-proposal'],
    ];
    for (const [b, code] of bad) {
      const r = await w.post('/v1/proposals/submit', b);
      expect(r.status, JSON.stringify(b).slice(0, 80)).toBe(400);
      expect(r.body.code).toBe(code);
    }
    expect(w.core.calls.length).toBe(0);
  });

  it('rejects proposal data that fails Core rules (expired end_epoch)', async () => {
    const { w, body } = setup();
    w.clock.t = 1_900_000_000; // after end_epoch 1887414577
    const r = await w.post('/v1/proposals/submit', body);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('bad-proposal');
    expect(w.core.calls.length).toBe(0);
  });

  it('rejects a collateral that does not commit to this proposal (bad-collateral) or is not the named transaction', async () => {
    const { w, body } = setup();
    // right transaction, other proposal's hash
    const other = await w.post('/v1/proposals/submit', { ...body, collateralTxid: p2sh.txid });
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({ code: 'bad-collateral', failure: 'no-matching-op-return' });
    // Core answers with different bytes than the txid names
    w.core.rawTxs.set(basic.txid, { hex: p2sh.rawTx, confirmations: 8 });
    const swapped = await w.post('/v1/proposals/submit', body);
    expect(swapped.body).toMatchObject({ code: 'bad-collateral', failure: 'txid-mismatch' });
    expect(w.core.count('gobject', 'submit')).toBe(0);
  });

  it('reports an unknown collateral, Core rejections and a Core outage', async () => {
    const { w, body } = setup();
    expect((await w.post('/v1/proposals/submit', { ...body, collateralTxid: 'cd'.repeat(32) })).body.code).toBe('unknown-collateral');

    w.core.submitError = new CoreRpcError('gobject', -32603, 'Governance object is not valid - x - Invalid proposal collateral');
    const rej = await w.post('/v1/proposals/submit', body);
    expect(rej.status).toBe(409);
    expect(rej.body).toEqual({ error: 'Governance object is not valid - x - Invalid proposal collateral', code: 'core-rejected' });

    w.core.down = true;
    const down = await w.post('/v1/proposals/submit', body);
    expect(down.status).toBe(503);
    expect(down.body.code).toBe('core-unavailable');
  });
});
