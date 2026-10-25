// After payment: the relay client (holding relays, older relays, answers bound to this proposal) and one tick of the submission
// logic (hand-off, fallback to the next relay, a relay that lost the proposal, Core's refusal, seen by the network, on govhub).
import { checkNewProposal, lockProposal } from '@govhub/verify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newDraft, type DraftLock, type ProposalDraft } from './draft.ts';
import { HttpProposalRelay, RelayError, type HeldProposalState, type ProposalRelayPort, type SubmitBody } from './relay.ts';
import type { CollateralCheck, WizardServices } from './services.ts';
import { markManualSubmit, resetRelays, submissionTick } from './submission.ts';

const now = 1_792_800_000;
const TXID = 'cd'.repeat(32);
function paidDraft(): ProposalDraft {
  const c = checkNewProposal({ network: 'testnet', name: 'tick-test', paymentAddress: 'yXGeNPQXYFXhLAN1ZKrAjxzzBnZ2JZNKnh', paymentDuffs: 100_000_000n, url: 'https://example.org/t', startEpoch: now, endEpoch: now + 86400, now });
  const l = lockProposal(c.dataHex!, now);
  const lock: DraftLock = { ...l, name: 'tick-test', url: 'https://example.org/t', paymentAddress: 'yXGeNPQXYFXhLAN1ZKrAjxzzBnZ2JZNKnh', paymentDuffs: '100000000', startEpoch: now, endEpoch: now + 86400, superblocks: [], eligible: [], lockedAt: 0 };
  return { ...newDraft('testnet'), lock, payment: { method: 'core', txid: TXID } };
}

const mined = (n: number): CollateralCheck => ({ state: 'mined', confirmations: n, basis: 'verified', final: n >= 2 });

class FakeRelay implements ProposalRelayPort {
  calls: string[] = [];
  held: HeldProposalState | null = null;
  constructor(
    readonly name: string,
    public mode: 'hold' | 'legacy' | 'down' | 'reject' = 'hold',
  ) {}
  get base() {
    return `https://${this.name}`;
  }
  async hold(body: SubmitBody, govHash: string) {
    this.calls.push('hold');
    if (this.mode === 'down') throw new RelayError('unreachable');
    if (this.mode === 'reject') throw new RelayError('Invalid proposal data', 400, 'bad-proposal');
    if (this.mode === 'legacy') return { kind: 'legacy' as const };
    this.held ??= { id: 'a'.repeat(32), govHash, status: 'waiting', confirmations: 0, lastError: null, coreMessage: null, nextAttemptAt: null, submittedAt: null };
    expect(body).toEqual({ network: 'testnet', parentHash: '0', revision: 1, time: now, dataHex: expect.any(String), collateralTxid: TXID });
    return { kind: 'held' as const, state: this.held };
  }
  async status(id: string) {
    this.calls.push('status');
    if (this.mode === 'down') throw new RelayError('unreachable');
    return this.held && this.held.id === id ? this.held : null;
  }
  async submitNow() {
    this.calls.push('submitNow');
    return this.confs >= 6 ? { kind: 'submitted' as const, govHash: '' } : { kind: 'unconfirmed' as const, confirmations: this.confs };
  }
  confs = 0;
}

function services(relays: FakeRelay[], o: { check?: CollateralCheck; seen?: boolean | null; onGovhub?: boolean } = {}): WizardServices {
  return {
    demo: false,
    network: 'testnet',
    pollMs: 1,
    checkCollateral: async () => o.check ?? mined(1),
    fundCollateral: async () => ({ txid: TXID }),
    relays: () => relays,
    seenByNetwork: async () => o.seen ?? false,
    onGovhub: async () => o.onGovhub ?? false,
  };
}

describe('submissionTick', () => {
  it('hands the proposal to the first relay at once (it holds it), then follows its status', async () => {
    const r = new FakeRelay('relay-a');
    const t1 = await submissionTick(paidDraft(), services([r]));
    expect(t1.draft.submission!.relays).toMatchObject([{ name: 'relay-a', id: 'a'.repeat(32), status: 'waiting' }]);
    expect(t1.draft.submission!.confirmations).toMatchObject({ n: 1, basis: 'verified', final: false });
    r.held!.status = 'submitted';
    const t2 = await submissionTick(t1.draft, services([r], { check: mined(6) }));
    expect(r.calls).toEqual(['hold', 'status', 'status']);
    expect(t2.draft.submission).toMatchObject({ via: 'relay-a', submittedAt: expect.any(Number) });
  });

  it('a relay that is down three times in a row: the next relay takes it', async () => {
    const a = new FakeRelay('relay-a', 'down');
    const b = new FakeRelay('relay-b');
    let d = paidDraft();
    for (let i = 0; i < 3; i++) d = (await submissionTick(d, services([a, b]))).draft;
    expect(d.submission!.relays.find((x) => x.name === 'relay-a')!.status).toBe('unreachable');
    expect(d.submission!.relays.find((x) => x.name === 'relay-b')!.status).toBe('waiting');
    // "try the relays again" forgets the failure
    expect(resetRelays(d).submission!.relays.map((x) => x.name)).toEqual(['relay-b']);
  });

  it('an older relay without holding is asked at 6 confirmations, not before', async () => {
    const r = new FakeRelay('old', 'legacy');
    const t1 = await submissionTick(paidDraft(), services([r], { check: mined(3) }));
    expect(t1.draft.submission!.relays[0]).toMatchObject({ legacy: true, status: 'waiting' });
    expect(r.calls).toEqual(['hold']);
    r.confs = 6;
    const t2 = await submissionTick(t1.draft, services([r], { check: mined(6) }));
    expect(r.calls).toEqual(['hold', 'submitNow']);
    expect(t2.draft.submission!.via).toBe('old');
  });

  it("Core's refusal is final and not retried on other relays", async () => {
    const a = new FakeRelay('relay-a', 'reject');
    const b = new FakeRelay('relay-b');
    const t = await submissionTick(paidDraft(), services([a, b]));
    expect(t.draft.submission!.relays).toMatchObject([{ name: 'relay-a', status: 'failed', lastError: 'bad-proposal' }]);
    expect(b.calls).toEqual([]);
  });

  it('a relay that lost the proposal gets it again (idempotent)', async () => {
    const r = new FakeRelay('relay-a');
    const t1 = await submissionTick(paidDraft(), services([r]));
    r.held = null;
    const t2 = await submissionTick(t1.draft, services([r]));
    expect(r.calls).toEqual(['hold', 'status', 'status', 'hold']);
    expect(t2.draft.submission!.relays[0]!.status).toBe('waiting');
  });

  it('a collateral that does not pay this proposal stops everything', async () => {
    const r = new FakeRelay('relay-a');
    const t = await submissionTick(paidDraft(), services([r], { check: { state: 'invalid', confirmations: 0, basis: 'verified', final: false, message: 'no OP_RETURN' } }));
    expect(t.invalid).toBe('no OP_RETURN');
    expect(r.calls).toEqual([]);
  });

  it('seen by the network, then on govhub; a manual submit counts', async () => {
    const r = new FakeRelay('relay-a');
    r.held = { id: 'a'.repeat(32), govHash: paidDraft().lock!.govHash, status: 'submitted', confirmations: 6, lastError: null, coreMessage: null, nextAttemptAt: null, submittedAt: 1 };
    const t = await submissionTick(paidDraft(), services([r], { check: mined(7), seen: true, onGovhub: true }));
    expect(t.draft.submission).toMatchObject({ submittedAt: expect.any(Number), seenAt: expect.any(Number), publishedAt: expect.any(Number) });
    const m = markManualSubmit(paidDraft(), 5);
    expect(m.submission).toMatchObject({ submittedAt: 5, via: 'manual' });
    // the network has it although no relay submitted it (submitted by hand elsewhere)
    const t2 = await submissionTick(paidDraft(), services([], { seen: true }));
    expect(t2.draft.submission).toMatchObject({ via: 'network', seenAt: expect.any(Number) });
  });
});

describe('HttpProposalRelay', () => {
  afterEach(() => vi.unstubAllGlobals());
  const gov = 'ab'.repeat(32);
  const body: SubmitBody = { network: 'testnet', parentHash: '0', revision: 1, time: now, dataHex: '7b7d', collateralTxid: TXID };
  const reply = (status: number, json: unknown) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } }));

  it('holds: POST /v1/proposals, the answer must be for this proposal', async () => {
    const f = reply(202, { id: 'f'.repeat(32), govHash: gov, status: 'waiting', confirmations: 2 });
    vi.stubGlobal('fetch', f);
    const r = new HttpProposalRelay('https://relay.example/', 'relay');
    expect(await r.hold(body, gov)).toMatchObject({ kind: 'held', state: { status: 'waiting', confirmations: 2 } });
    expect(f.mock.calls[0]![0]).toBe('https://relay.example/v1/proposals');
    expect(JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string)).toEqual(body);
    expect((f.mock.calls[0]![1] as RequestInit).credentials).toBe('omit');
    vi.stubGlobal('fetch', reply(202, { id: 'f'.repeat(32), govHash: 'cc'.repeat(32), status: 'waiting' }));
    await expect(r.hold(body, gov)).rejects.toThrow(/different proposal/);
  });

  it('an older relay (no such route) is legacy; 425 means not confirmed yet', async () => {
    vi.stubGlobal('fetch', reply(404, { error: 'not found', code: 'not-found' }));
    const r = new HttpProposalRelay('https://relay.example');
    expect(await r.hold(body, gov)).toEqual({ kind: 'legacy' });
    vi.stubGlobal('fetch', reply(425, { error: 'needs 6', code: 'collateral-unconfirmed', confirmations: 3 }));
    expect(await r.submitNow(body)).toEqual({ kind: 'unconfirmed', confirmations: 3 });
    vi.stubGlobal('fetch', reply(200, { govHash: gov, result: gov }));
    expect(await r.submitNow(body)).toEqual({ kind: 'submitted', govHash: gov });
  });

  it('errors keep their code; status 404 is "unknown"', async () => {
    vi.stubGlobal('fetch', reply(404, { error: 'unknown collateral', code: 'unknown-collateral' }));
    const r = new HttpProposalRelay('https://relay.example');
    await expect(r.hold(body, gov)).rejects.toMatchObject({ status: 404, code: 'unknown-collateral' });
    vi.stubGlobal('fetch', reply(404, { error: 'not found', code: 'not-found' }));
    expect(await r.status('f'.repeat(32), gov)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(r.hold(body, gov)).rejects.toThrow(/unreachable/);
  });
});
