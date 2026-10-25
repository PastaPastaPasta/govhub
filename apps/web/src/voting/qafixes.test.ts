// Regression tests for the keyring and voting fixes of the QA pass (DEFECT-LEDGER D-004 … D-071, fix group F2).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localRecordKey, type PendingVote } from '@govhub/auth';
import { bytesToHex, decodeAddress, encodeWif, hexToBytes, recoverVoteSigner, signVote, voteSignatureHash } from '@govhub/verify';
import { endSession, onSessionEnd } from '../session/end.ts';
import type { BridgeMasternode } from '../data/bridge.ts';
import { assertCanWrite, KEYRING_WRITE_CREDITS, topUpFromError, TopUpError } from './funds.ts';
import { castKeys, KeyringLock } from './gate.ts';
import { clearStash, stashPasskeyUnlock, takeStash } from './stash.ts';
import { keyRole, matchMasternodes, parseVotingKey, PROTX_FETCH, proveCollaterals, type OwnedMasternode } from './masternodes.ts';
import { loadWatchedSealed, mergeWatched, needsRebroadcast, pendingBackup, saveWatchedSealed, toPending, fromPending, type WatchedVote } from './pending.ts';
import { mnId, offlineSigningRequest, offlineVoteTime, signPlanned, voteFields, voterawCommand } from './plan.ts';
import { RelayClient, RelayError, type RelayVoteState } from './relay.ts';
import type { RelayPort } from './sim.ts';
import { applyRelayState, describeVote, relaySummary, VOTE_NOW_DELAY_TEXT } from './status.ts';
import { SAFE_RESUBMIT_S, withdrawVote, type WithdrawDeps } from './withdraw.ts';

const priv = hexToBytes('33'.repeat(32));
const mn = { proTxHash: 'aa'.repeat(32), collateralTxid: 'bb'.repeat(32), collateralIndex: 3 };
const gov = 'cc'.repeat(32);
const NOW = 1_800_000_000;
const R1 = 'https://relay-one.example';
const R2 = 'https://relay-two.example';
const fmt = (s: number) => `T${s - NOW}`;
const vote = (over: Partial<WatchedVote> = {}, outcome: 1 | 2 | 3 = 2, time = NOW): WatchedVote => ({
  ...signPlanned({ mn, govHash: gov, outcome, time, releaseAt: time, notes: [] }, priv, true, 'testnet'),
  refs: [],
  status: 'queued',
  rebroadcasts: 0,
  signedAt: time,
  ...over,
});
const state = (v: WatchedVote, over: Partial<RelayVoteState> = {}): RelayVoteState => ({
  id: 'ab'.repeat(16),
  voteHash: v.voteHash,
  status: 'held',
  releaseAt: v.releaseAt,
  broadcastAt: null,
  confirmedAt: null,
  lastError: null,
  nextAttemptAt: v.releaseAt,
  holdReason: 'release-time',
  sameAsCurrent: false,
  ...over,
});

/** A relay holding votes by hash; `byHash: false` = a relay without the by-hash endpoint. */
function fakeRelay(o: { byHash?: boolean } = {}) {
  const held = new Map<string, RelayVoteState>();
  const calls: string[] = [];
  const port: RelayPort = {
    submit: async (v) => {
      calls.push('submit');
      const st = held.get(v.voteHash) ?? { ...state(v as WatchedVote), id: v.voteHash.slice(0, 32) };
      held.set(v.voteHash, st);
      return st;
    },
    status: async (id) => {
      calls.push('status');
      return [...held.values()].find((x) => x.id === id) ?? null;
    },
    cancel: async (id) => {
      calls.push('cancel');
      const st = [...held.values()].find((x) => x.id === id);
      if (!st) throw new RelayError('unknown vote id', 404, 'unknown-id');
      if (st.status !== 'held') throw new RelayError(`the vote is ${st.status}`, 409, 'not-held', st.status);
      st.status = 'cancelled';
      return 'cancelled';
    },
    health: async () => ({ ok: true, checkedAt: 0 }),
    ...(o.byHash === false
      ? {}
      : {
          byHash: async (h: string) => {
            calls.push('byHash');
            return held.get(h) ?? null;
          },
        }),
  };
  return { port, held, calls };
}
const deps = (relays: Record<string, RelayPort>, now = NOW): WithdrawDeps => ({ relayFor: (u) => relays[u]!, network: 'testnet', cancelSig: () => 'sig', now: () => now });

describe('D-004 / D-025: sign-out wipes synchronously', () => {
  afterEach(() => vi.restoreAllMocks());
  it('session-end hooks run synchronously, all of them, even when one throws', () => {
    const key = new Uint8Array(32).fill(7);
    const order: string[] = [];
    const off1 = onSessionEnd(() => {
      order.push('a');
      throw new Error('boom');
    });
    const off2 = onSessionEnd(() => (order.push('b'), key.fill(0)));
    endSession();
    expect(order).toEqual(['a', 'b']);
    expect(key.every((b) => b === 0)).toBe(true);
    off1();
    off2();
    endSession();
    expect(order).toEqual(['a', 'b']);
  });
});

describe('D-004: the passkey that signs in next keeps its keyring hand-off; any other is wiped', () => {
  it('clearStash(next) keeps a stash for the identity signing in, wipes one for anybody else', () => {
    stashPasskeyUnlock('B', new Uint8Array(32).fill(5));
    clearStash('B');
    expect(takeStash('B')).not.toBeNull();
    stashPasskeyUnlock('A', new Uint8Array(32).fill(5));
    clearStash(null);
    expect(takeStash('A')).toBeNull();
  });
});

describe('D-015: a locked keyring needs the phrase or a passkey again in that session', () => {
  it('stays locked for the session that locked it (memory-only keys, Save, a profile switch); a new session starts unlocked', () => {
    const lock = new KeyringLock();
    const s1 = {};
    expect(lock.lockedIn(s1)).toBe(false);
    lock.lock(s1);
    expect(lock.lockedIn(s1)).toBe(true);
    expect(lock.lockedIn(s1)).toBe(true); // asked again (Save encrypted, the session effect re-running): still locked
    lock.unlock(); // the phrase or a passkey opened it
    expect(lock.lockedIn(s1)).toBe(false);
    lock.lock(s1);
    expect(lock.lockedIn({})).toBe(false); // signed in again: a new session
  });
});

describe('D-029: locking during a cast does not leave it without keys', () => {
  it('the cast signs with copies that survive the keyring being wiped, and wipes them itself', () => {
    const keys = [{ privateKey: priv.slice(), compressed: true }];
    const owned = [{ ...mn, type: 'regular', valid: true, votingAddress: '', keyIndex: 0, provenance: { key: 'sml', collateral: 'protx' } }] as OwnedMasternode[];
    const c = castKeys(keys, owned);
    keys[0]!.privateKey.fill(0); // Lock now / idle lock mid-cast
    const k = c.keyOf(mn)!;
    expect(bytesToHex(k.privateKey)).toBe(bytesToHex(priv));
    const s = signPlanned({ mn, govHash: gov, outcome: 3, time: NOW, releaseAt: NOW, notes: [] }, k.privateKey, k.compressed, 'testnet');
    expect(recoverVoteSigner(s.sig, voteFields({ mn, govHash: gov, outcome: 3, time: NOW }), 'testnet')).not.toBeNull();
    c.wipe();
    expect(k.privateKey.every((b) => b === 0)).toBe(true);
    expect(c.keyOf({ collateralTxid: 'ee'.repeat(32), collateralIndex: 0 })).toBeUndefined();
  });
});

describe('D-005: a vote a relay may hold is reconciled, not silently dropped', () => {
  it('a newer vote does not mark a queued vote whose submission timed out as "dropped"', () => {
    const lost = vote({ maybeAt: [R1], signedAt: NOW }, 2, NOW + 900);
    const yes = vote({ signedAt: NOW + 60 }, 1, NOW + 60);
    const m = mergeWatched([lost], [yes]);
    expect(m.find((x) => x.voteHash === lost.voteHash)!.status).toBe('queued');
    // a plain queued vote (never reached a relay) is still dropped
    const plain = vote({ signedAt: NOW }, 2, NOW + 900);
    expect(mergeWatched([plain], [yes]).find((x) => x.voteHash === plain.voteHash)!.status).toBe('dropped');
  });
  it('finds it at the relay by vote hash and cancels it there', async () => {
    const r = fakeRelay();
    const lost = vote({ maybeAt: [R1], releaseAt: NOW + 900 }, 2, NOW + 900);
    await r.port.submit(lost, 'testnet'); // the relay stored it; its answer never arrived
    const out = await withdrawVote(lost, deps({ [R1]: r.port }));
    expect(out.result).toBe('cancelled');
    expect(out.vote.refs.map((x) => x.relay)).toEqual([R1]);
    expect(out.vote.maybeAt).toBeUndefined();
    expect(r.held.get(lost.voteHash)!.status).toBe('cancelled');
  });
  it('a relay that answers "not here" means it never got it ("gone"); no cancel is sent', async () => {
    const r = fakeRelay();
    const out = await withdrawVote(vote({ maybeAt: [R1] }), deps({ [R1]: r.port }));
    expect(out.result).toBe('gone');
    expect(r.calls).toEqual(['byHash']);
  });
  it('without the by-hash endpoint: a vote released far ahead is re-sent for its id and cancelled; one due soon stays unknown', async () => {
    const far = fakeRelay({ byHash: false });
    const v = vote({ maybeAt: [R1], releaseAt: NOW + SAFE_RESUBMIT_S + 60 }, 2, NOW + 3600);
    await far.port.submit(v, 'testnet');
    far.calls.length = 0;
    const a = await withdrawVote(v, deps({ [R1]: far.port }));
    expect(a.result).toBe('cancelled');
    expect(far.calls.slice(0, 2)).toEqual(['submit', 'cancel']);
    const soon = fakeRelay({ byHash: false });
    const b = await withdrawVote(vote({ maybeAt: [R1], releaseAt: NOW + 10 }), deps({ [R1]: soon.port }));
    expect(b.result).toBe('unknown');
    expect(b.vote.maybeAt).toEqual([R1]);
    expect(soon.calls).toEqual([]);
    expect(describeVote({ ...b.vote, restored: true }, NOW, fmt)).toMatchObject({ badge: 'May be at a relay' });
  });
  it('RelayClient.byHash: 200 = the record, a relay 404 = not there, the generic route 404 = unsupported', async () => {
    const v = vote();
    const answers: Array<[number, unknown]> = [
      [200, state(v)],
      [404, { error: 'unknown vote', code: 'unknown-vote' }],
      [404, { error: 'not found', code: 'not-found' }],
      [405, {}],
    ];
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const [status, body] = answers.shift()!;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    });
    const c = new RelayClient(R1);
    expect(await c.byHash(v.voteHash)).toMatchObject({ voteHash: v.voteHash, status: 'held' });
    expect(await c.byHash(v.voteHash)).toBeNull();
    expect(await c.byHash(v.voteHash)).toBe('unsupported');
    expect(await c.byHash(v.voteHash)).toBe('unsupported');
    expect(urls[0]).toBe(`${R1}/v1/votes/by-hash/${v.voteHash}`);
    vi.unstubAllGlobals();
  });
});

describe('D-017: a vote the relay had broadcast is never reported "Cancelled"', () => {
  it('cancelled after a broadcast the relay moved back to held: "may already count", never re-sent', async () => {
    const v = vote({ status: 'held', refs: [{ relay: R1, id: 'ab'.repeat(16) }] });
    const r = fakeRelay();
    r.held.set(v.voteHash, state(v, { broadcastAt: NOW + 5, lastError: 'not-visible' }));
    const out = await withdrawVote(v, deps({ [R1]: r.port }));
    expect(out.result).toBe('maybe');
    const after = applyRelayState(v, R1, state(v, { status: 'cancelled', broadcastAt: NOW + 5 }));
    expect(after).toMatchObject({ status: 'broadcast', withdrawn: true });
    expect(describeVote(after, NOW, fmt).badge).toBe('May already count');
    expect(needsRebroadcast(after, NOW + 99_999)).toBe(false);
    // never broadcast: a plain cancel
    expect(applyRelayState(v, R1, state(v, { status: 'cancelled' })).status).toBe('cancelled');
  });
});

describe('D-016 / D-028: votes are tagged with their Core network; the backup keeps the newest', () => {
  const pv = (i: number, network?: 'mainnet' | 'testnet'): PendingVote => ({ ...toPending(vote({ status: 'held' }, 1, NOW - 10_000 + i)), ...(network ? { network } : {}) });
  it('a backup written on testnet keeps the mainnet (Dev) votes and drops its own old ones', () => {
    const ours = [vote({ status: 'held', network: 'testnet', signedAt: NOW }, 1, NOW), vote({ status: 'held', network: 'testnet', signedAt: NOW + 5 }, 2, NOW + 5)];
    const out = pendingBackup(ours, 'testnet', [pv(1, 'mainnet'), pv(2, 'testnet'), pv(3)], 60);
    expect(out.map((p) => p.network)).toEqual(['testnet', 'testnet', 'mainnet']);
    expect(out[0]!.time).toBe(NOW + 5); // newest first
    // votes signed for the other network in this list are not backed up as this network's
    expect(pendingBackup([vote({ status: 'held', network: 'mainnet' })], 'testnet', [], 60)).toEqual([]);
  });
  it('the cap keeps the NEWEST votes', () => {
    const many = Array.from({ length: 70 }, (_, i) => vote({ status: 'held', network: 'testnet', signedAt: NOW + i, collateralIndex: i }, 1, NOW + i));
    const out = pendingBackup(many, 'testnet', [], 60);
    expect(out.length).toBe(60);
    expect(Math.min(...out.map((p) => p.time))).toBe(NOW + 10);
  });
  it('the network survives the PENDING round trip', () => {
    const v = vote({ status: 'held', network: 'mainnet' });
    expect(fromPending(toPending(v), '', v.voteHash).network).toBe('mainnet');
  });
});

describe('D-027: signed votes are stored sealed to the keyring, never in plain text', () => {
  class Mem {
    m = new Map<string, string>();
    getItem = (k: string) => this.m.get(k) ?? null;
    setItem = (k: string, v: string) => void this.m.set(k, v);
    removeItem = (k: string) => void this.m.delete(k);
  }
  it('round-trips with the keyring key only; storage holds no vote fields', () => {
    const st = new Mem();
    const scope = 'votes|testnet|testnet|ID';
    const key = localRecordKey(new Uint8Array(16).fill(9), scope);
    const v = vote({ status: 'held', network: 'testnet' });
    saveWatchedSealed(st, 'testnet', 'ID', scope, key, [v, vote({ ephemeral: true }, 3), vote({ network: 'mainnet' }, 1)]);
    const raw = [...st.m.values()].join('');
    expect(raw).not.toContain(v.voteHash);
    expect(raw).not.toContain(v.sig);
    expect(raw).not.toContain(gov);
    expect(loadWatchedSealed(st, 'testnet', 'ID', scope, key).map((x) => x.voteHash)).toEqual([v.voteHash]);
    expect(loadWatchedSealed(st, 'testnet', 'ID', scope, localRecordKey(new Uint8Array(16).fill(8), scope))).toEqual([]);
  });
});

describe('D-022: "registration proves the rest" only after the ProRegTx was read', () => {
  const protx = JSON.parse(readFileSync(new URL('../../../../packages/verify/test/fixtures/protx.testnet.json', import.meta.url), 'utf8')).protx as Array<{ proTxHash: string; raw: string; collateralHash: string; collateralIndex: number; type: string; votingAddress: string }>;
  const self = protx.find((x) => x.collateralHash === x.proTxHash)!;
  const keyId = bytesToHex(decodeAddress(self.votingAddress, 'testnet')!.hash160);
  const bridge: BridgeMasternode[] = protx.map((x) => ({ proTxHash: x.proTxHash, collateralTxid: x.collateralHash, collateralIndex: x.collateralIndex, votingAddress: x.votingAddress, type: x.type === 'Evo' ? 'evo' : 'regular', valid: true }));
  const sml = new Map(protx.map((x) => [x.proTxHash, { votingAddress: x.votingAddress, isValid: true, nType: x.type === 'Evo' ? 1 : 0, typeProven: true }]));
  it('a self-collateral masternode is not "proved" by the bridge saying so', async () => {
    const m = matchMasternodes([{ index: 0, keyId }], bridge, sml, 'testnet').owned.find((x) => x.proTxHash === self.proTxHash)!;
    expect(m.provenance.collateral).toBe('bridge');
    const failed = await proveCollaterals([m], async () => Promise.reject(new Error('node down')), 'testnet', { pause: async () => {} });
    expect(failed.mns[0]!.provenance.collateral).toBe('bridge');
    const ok = await proveCollaterals([m], async (t) => hexToBytes(protx.find((x) => x.proTxHash === t)!.raw), 'testnet', { pause: async () => {} });
    expect(ok.mns[0]!.provenance.collateral).toBe('protx');
    // the bridge names another output of the self-collateral ProRegTx: caught
    const lying = await proveCollaterals([{ ...m, collateralIndex: m.collateralIndex + 1 }], async (t) => hexToBytes(protx.find((x) => x.proTxHash === t)!.raw), 'testnet', { pause: async () => {} });
    expect(lying.mismatch).toEqual([self.proTxHash]);
  });
});

describe('D-026: ProRegTx reads are mixed with decoys and not sent as one burst', () => {
  it('reads decoys too, in random order, a few at a time', async () => {
    const owned = ['01', '02', '03'].map((x, i) => ({ ...mn, proTxHash: x.repeat(32), collateralIndex: i, type: 'regular', valid: true, votingAddress: '', keyIndex: 0, provenance: { key: 'sml', collateral: 'bridge' } })) as OwnedMasternode[];
    const decoys = ['0a', '0b', '0c'].map((x) => x.repeat(32));
    let inFlight = 0;
    let peak = 0;
    const asked: string[] = [];
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    await proveCollaterals(
      owned,
      async (t) => {
        asked.push(t);
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        throw new Error('not needed');
      },
      'testnet',
      { decoys, pause: async () => {}, random },
    );
    expect(new Set(asked)).toEqual(new Set([...owned.map((m) => m.proTxHash), ...decoys]));
    expect(peak).toBeLessThanOrEqual(PROTX_FETCH.concurrency);
    expect(asked.slice(0, 3)).not.toEqual(owned.map((m) => m.proTxHash));
  });
});

describe('D-023: a key is checked against the masternode list before it is saved', () => {
  const list = [{ proTxHash: 'aa'.repeat(32), collateralAddress: 'yCollateral', payoutAddress: 'yPayout' }];
  it('refuses collateral and payout keys with a specific message; a key that votes for nothing needs confirmation', () => {
    expect(keyRole('yCollateral', list, [])).toMatchObject({ kind: 'collateral', message: expect.stringMatching(/collateral key of masternode aaaaaaaaaaaa…/) });
    expect(keyRole('yPayout', list, [])).toMatchObject({ kind: 'payout', message: expect.stringMatching(/payout key/) });
    // the ProRegTx payout of a masternode this key votes for (bridge without addresses)
    expect(keyRole('yP2', [], [{ proTxHash: 'bb'.repeat(32), payoutAddress: 'yP2' }])).toMatchObject({ kind: 'payout' });
    expect(keyRole('yNothing', list, [])).toMatchObject({ kind: 'none', message: expect.stringMatching(/not the voting key of any registered masternode/) });
    expect(keyRole('yVoting', list, [{ proTxHash: 'aa'.repeat(32) }])).toEqual({ kind: 'voting', count: 1 });
  });
});

describe('D-024: keyring writes check the balance first and say "top up"', () => {
  it('refuses a write the balance cannot pay, and words Platform’s refusal as a top-up hint', () => {
    expect(() => assertCanWrite(292_473_178n)).toThrow(TopUpError);
    expect(() => assertCanWrite(KEYRING_WRITE_CREDITS[1])).not.toThrow();
    expect(() => assertCanWrite(null)).not.toThrow();
    const e = topUpFromError(new Error('Failed to broadcast: Protocol error: Insufficient identity 8GqC balance 292473178 required 300631920'));
    expect(e).toBeInstanceOf(TopUpError);
    expect((e as Error).message).toMatch(/Top up the identity/);
    expect((e as Error).message).not.toMatch(/Protocol error/);
    const other = new Error('x');
    expect(topUpFromError(other)).toBe(other);
  });
});

describe('D-030: offline signing is timed when asked, with the hour rule, and works on testnet', () => {
  it('times the vote now, or after the current vote by Core’s one-change-per-hour rule', () => {
    expect(offlineVoteTime(NOW, undefined)).toEqual({ time: NOW, releaseAt: NOW, hourRule: false });
    const h = offlineVoteTime(NOW, { outcome: 1, time: NOW - 600 });
    expect(h.time).toBe(NOW - 600 + 3600 + 120);
    expect(h.hourRule).toBe(true);
    expect(h.releaseAt).toBe(h.time - 60);
  });
  it('testnet: the hash, a voteraw template, and a signature over the hash that the page verifies', () => {
    const p = { mn, govHash: gov, outcome: 3 as const, time: NOW };
    const req = offlineSigningRequest(p, 'testnet');
    expect(req.hashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(voterawCommand(p)).toBe(`voteraw ${mn.collateralTxid} ${mn.collateralIndex} ${gov} funding abstain ${NOW} <signature-base64>`);
    // a signature made by "custom tooling" over that hash
    const sig = signVote({ privKey: priv, vote: voteFields(p), network: 'testnet', compressed: true }).base64;
    expect(bytesToHex(voteSignatureHash(voteFields(p)))).toBe(req.hashHex);
    expect(recoverVoteSigner(sig, voteFields(p), 'testnet')).not.toBeNull();
    expect(mnId(mn)).toBe(`${mn.collateralTxid}-${mn.collateralIndex}`);
  });
});

describe('D-067: a WIF of the other network gets its own message', () => {
  it('names the network', () => {
    const k = hexToBytes('44'.repeat(32));
    expect(() => parseVotingKey(encodeWif(k, true, 'mainnet'), 'testnet')).toThrow(/That is a mainnet key, but this profile votes on testnet Core/);
    expect(() => parseVotingKey(encodeWif(k, true, 'testnet'), 'mainnet')).toThrow(/That is a testnet key/);
    expect(() => parseVotingKey('garbage', 'testnet')).toThrow(/Enter the voting key as a testnet WIF/);
    expect(bytesToHex(parseVotingKey(encodeWif(k, true, 'testnet'), 'testnet').privateKey)).toBe('44'.repeat(32));
  });
});

describe('D-070 / D-071: what "Vote now" says', () => {
  it('one relay, the others as fallbacks; warns when none answered; no "a minute or two"', () => {
    expect(relaySummary([R1, R2], {}).text).toBe('Signed in your browser and sent through relay-one.example (another relay takes over if it fails).');
    expect(relaySummary([R1, R2], { [R1]: { ok: false }, [R2]: { ok: true } }).text).toMatch(/through relay-two\.example/);
    expect(relaySummary([R1, R2], { [R1]: { ok: false }, [R2]: { ok: false } })).toMatchObject({ warn: true, text: expect.stringMatching(/No relay answered/) });
    expect(relaySummary([R1], {}).text).toBe('Signed in your browser and sent through relay-one.example.');
    expect(VOTE_NOW_DELAY_TEXT).not.toMatch(/minute or two/);
    expect(VOTE_NOW_DELAY_TEXT).toMatch(/few minutes/);
  });
});
