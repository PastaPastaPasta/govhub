// HTTP API on recorded mainnet data, including a full client-side recount of a proposal from the API alone.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recoverVoteSigner, bytesToHex, countVotes } from '@govhub/verify';
import { createApi } from '../src/api/server.ts';
import { paymentCounts } from '../src/api/dashcentral.ts';
import { votesFixture } from './helpers.ts';
import { fixtureBridge } from './world.ts';

const b = await fixtureBridge();
const app = createApi(b);
const get = async (path: string) => {
  const r = await app.request(path);
  return { status: r.status, headers: r.headers, body: (await r.json()) as any };
};
const vf = votesFixture();
const big = vf.proposals[vf.proposals.length - 1]!;

describe('GET /v1/status', () => {
  it('is 200 with a numeric proposals count, even with Core unreachable', async () => {
    const r = await get('/v1/status');
    expect(r.status).toBe(200);
    expect(r.body.proposals).toBe(28);
    expect(r.body.network).toBe('mainnet');
    expect(r.body.core.reachable).toBe(false);
    expect(r.body.archive.votesByStatus.valid).toBeGreaterThan(500);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('is read-only: other methods get 405, CORS preflight still answers', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await app.request('/v1/status', { method, headers: { Origin: 'https://gov.dashhq.org' } });
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
    }
    const pre = await app.request('/v1/status', { method: 'OPTIONS', headers: { Origin: 'https://gov.dashhq.org', 'Access-Control-Request-Method': 'GET' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('GET');
  });
});

describe('proposals', () => {
  it('lists proposals with the gov document field names', async () => {
    const r = await get('/v1/proposals?state=all');
    expect(r.body.count).toBe(28);
    const p = r.body.proposals.find((x: any) => x.govHash === big.govHash);
    for (const k of ['govHash', 'parentHash', 'revision', 'time', 'dataHex', 'name', 'url', 'paymentAddress', 'paymentAmount', 'startEpoch', 'endEpoch', 'collateralTxid', 'collateralHeight']) expect(p).toHaveProperty(k);
    expect(Number.isInteger(p.paymentAmount)).toBe(true);
    expect(p.verified).toEqual({ hash: true, data: true, collateral: true });
    expect((await get('/v1/proposals?state=nope')).status).toBe(400);
  });

  it('serves the raw object and the raw collateral tx', async () => {
    const r = await get(`/v1/proposals/${big.govHash}`);
    expect(r.status).toBe(200);
    expect(r.body.rawHex).toMatch(/^[0-9a-f]+$/);
    expect(r.body.collateralRawTxHex).toMatch(/^[0-9a-f]+$/);
    expect(r.body.verification.collateralOk).toBe(true);
    expect((await get(`/v1/proposals/${'00'.repeat(32)}`)).status).toBe(404);
    expect((await get('/v1/proposals/xyz')).status).toBe(400);
  });
});

describe('votes: a client recount from the API alone matches the tally and its voteSetHash', () => {
  it('live vote set', async () => {
    const votes = (await get(`/v1/proposals/${big.govHash}/votes`)).body;
    const mn = (await get('/v1/mnlist')).body;
    expect(votes.voteSetHashVersion).toBe('govhub-voteset-v1');
    expect(votes.count).toBe(big.tally.currentVotes);
    const byOutpoint = new Map<string, any>(mn.masternodes.map((m: any) => [`${m.collateralTxid}-${m.collateralIndex}`, m]));
    const weights = new Map<string, number>(mn.masternodes.map((m: any) => [`${m.collateralTxid}-${m.collateralIndex}`, m.weight]));
    const verified = votes.votes.filter((v: any) => {
      const signer = recoverVoteSigner(v.sig, { collateralTxid: v.collateralTxid, collateralIndex: v.collateralIndex, govHashDisplay: big.govHash, signal: v.signal, outcome: v.outcome, time: v.time }, 'mainnet');
      return signer && bytesToHex(signer.keyId) === byOutpoint.get(`${v.collateralTxid}-${v.collateralIndex}`)?.keyIdVoting;
    });
    expect(verified.length).toBe(votes.count);
    const t = countVotes(verified.map((v: any) => ({ mn: `${v.collateralTxid}-${v.collateralIndex}`, outcome: v.outcome, time: v.time })), weights);
    expect(t.weighted).toEqual({ yes: big.tally.core.yes, no: big.tally.core.no, abstain: big.tally.core.abstain });
    expect(t.voteSetHash).toBe(votes.voteSetHash);
    expect(t.voteSetHash).toBe(big.tally.voteSetHash);
  });

  it('?height= serves the set behind the tally in force at that height; ?all=1 flags counted votes', async () => {
    const h = vf.mnList.height;
    const r = await get(`/v1/proposals/${big.govHash}/votes?height=${h}`);
    expect(r.status).toBe(200);
    expect(r.body.asOfHeight).toBe(h);
    expect(r.body.voteSetHash).toBe(big.tally.voteSetHash);
    expect(r.body.count).toBe(big.tally.currentVotes);
    expect((await get(`/v1/proposals/${big.govHash}/votes?height=${h - 1}`)).status).toBe(404);
    expect((await get(`/v1/proposals/${big.govHash}/votes?height=${h + 1}`)).status).toBe(404);
    const all = await get(`/v1/proposals/${big.govHash}/votes?all=1`);
    expect(all.body.votes.every((v: any) => v.counted === true)).toBe(true);
  });
});

describe('tallies, mnlist, cycle', () => {
  it('tallies use the tally document field names and are in rank order', async () => {
    const r = await get('/v1/tallies');
    // the fixture MN list is the voters' subset, so the threshold follows from its validWeighted
    expect(r.body.fundingThreshold).toBe(Math.max(10, Math.trunc(r.body.validWeighted / 10)));
    const ranks = r.body.tallies.map((t: any) => t.rank);
    expect(ranks).toEqual([...ranks].sort((a: number, c: number) => a - c));
    const t = r.body.tallies.find((x: any) => x.govHash === big.govHash);
    expect([t.yesWeighted, t.noWeighted, t.abstainWeighted]).toEqual([big.tally.core.yes, big.tally.core.no, big.tally.core.abstain]);
  });

  it('mnlist by height', async () => {
    expect((await get(`/v1/mnlist/${vf.mnList.height}`)).body.masternodes.length).toBe(vf.mnList.entries.length);
    expect((await get('/v1/mnlist/1')).status).toBe(404);
    expect((await get('/v1/mnlist/abc')).status).toBe(400);
  });

  it('cycle: next superblock live, last superblock with what it paid', async () => {
    const r = (await get('/v1/cycle')).body;
    expect(r.cycle.superblockHeight).toBe(2575480);
    expect(r.cycle.votingDeadlineHeight).toBe(2575480 - 1662);
    expect(r.cycle.paid).toBe(0);
    expect(r.last.superblockHeight).toBe(2558864);
    expect(r.last.paid).toBe(539300000000);
  });
});

describe('DashCentral-compatible API', () => {
  it('budget lists every active proposal with DashCentral field names and honest nulls', async () => {
    const r = await get('/api/v1/budget');
    expect(r.body.status).toBe('ok');
    expect(r.body.budget.superblock).toBe(2575480);
    const p = r.body.proposals[0];
    for (const k of ['hash', 'name', 'url', 'dw_url', 'title', 'date_added', 'date_end', 'voting_deadline', 'will_be_funded', 'remaining_yes_votes_until_funding', 'in_next_budget', 'monthly_amount', 'total_payment_count', 'remaining_payment_count', 'yes', 'no', 'abstain', 'order', 'comment_amount', 'owner_username']) expect(p).toHaveProperty(k);
    expect([p.title, p.comment_amount, p.owner_username]).toEqual([null, null, null]);
    expect(p.order).toBe(1);
  });

  it('single proposal', async () => {
    expect((await get(`/api/v1/proposal?hash=${big.govHash}`)).body.proposal.hash).toBe(big.govHash);
    expect((await get('/api/v1/proposal?hash=zz')).status).toBe(400);
    expect((await get(`/api/v1/proposal?hash=${'00'.repeat(32)}`)).status).toBe(404);
  });

  it('payment counts: superblocks inside [start - 2h, end + 2h]', () => {
    const step = 16616 * 2.62 * 60;
    expect(paymentCounts(1000, 1000 + 3 * step, 1000 + step / 2, 16616)).toEqual({ total: 3, remaining: 3 });
    expect(paymentCounts(1000 - 2 * step, 1000 + step, 1000 + step / 2, 16616)).toEqual({ total: 3, remaining: 1 });
  });
});

describe('OpenAPI spec', () => {
  const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
  it('documents every route the server registers', () => {
    const routes = app.routes.filter((r) => r.method === 'GET').map((r) => r.path.replace(/:(\w+)/g, '{$1}'));
    for (const r of new Set(routes)) expect(Object.keys(spec.paths), r).toContain(r);
  });
  it('responses carry the required fields of their schemas', async () => {
    const req = (name: string) => spec.components.schemas[name].required as string[];
    const status = (await get('/v1/status')).body;
    for (const k of req('Status')) expect(status, `Status.${k}`).toHaveProperty(k);
    const tally = (await get('/v1/tallies')).body.tallies[0];
    for (const k of req('Tally')) expect(tally, `Tally.${k}`).toHaveProperty(k);
    const votes = (await get(`/v1/proposals/${big.govHash}/votes`)).body;
    for (const k of req('VoteSet')) expect(votes).toHaveProperty(k);
    for (const k of req('Vote')) expect(votes.votes[0]).toHaveProperty(k);
    const cycle = (await get('/v1/cycle')).body.cycle;
    for (const k of req('Cycle')) expect(cycle).toHaveProperty(k);
    const mn = (await get('/v1/mnlist')).body;
    for (const k of req('MnList')) expect(mn).toHaveProperty(k);
  });
});
