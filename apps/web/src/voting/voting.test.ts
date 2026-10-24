import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bytesToHex, decodeAddress, governanceVoteHash, hexToBytes, recoverMessageSigner, recoverVoteSigner, relayCancelMessage, VOTE_SIGNAL } from '@govhub/verify';
import type { BridgeMasternode } from '../data/bridge.ts';
import { matchMasternodes, proveCollaterals, votingAddressOf, votingKeyId } from './masternodes.ts';
import { bridgeVerdict, fromPending, mergeWatched, needsRebroadcast, pickRebroadcastRelay, pruneWatched, toPending, type WatchedVote } from './pending.ts';
import { currentKey, deferredWindow, offlineSigningRequest, planDeferred, planImmediate, signPlanned, submitDelays, uniform, voteFields, type Intent } from './plan.ts';
import { cancelSignature, parseRelayState } from './relay.ts';

const protx = JSON.parse(readFileSync(new URL('../../../../packages/verify/test/fixtures/protx.testnet.json', import.meta.url), 'utf8')).protx as Array<{ proTxHash: string; raw: string; collateralHash: string; collateralIndex: number; type: string; votingAddress: string }>;

const priv = hexToBytes('11'.repeat(32));
const mn = { proTxHash: 'aa'.repeat(32), collateralTxid: 'bb'.repeat(32), collateralIndex: 1 };
const gov = 'cc'.repeat(32);
const NOW = 1_800_000_000;
let seq = 0;
const rand = () => (seq = (seq * 1103515245 + 12345) >>> 0);

describe('planImmediate', () => {
  const i: Intent = { mn, govHash: gov, outcome: 1 };
  it('votes now when there is no current vote', () => {
    const r = planImmediate([i], new Map(), NOW);
    expect(r.ok[0]).toMatchObject({ time: NOW, releaseAt: NOW, notes: [] });
  });
  it('skips a vote that changes nothing', () => {
    const r = planImmediate([i], new Map([[currentKey(mn, gov), { outcome: 1, time: NOW - 9999 }]]), NOW);
    expect(r.ok).toEqual([]);
    expect(r.skipped[0]!.reason).toMatch(/already voted yes/);
  });
  it("respects Core's one change per hour (receive clock) and never signs an obsolete time", () => {
    const r = planImmediate([{ ...i, outcome: 2 }], new Map([[currentKey(mn, gov), { outcome: 1, time: NOW - 600 }]]), NOW);
    expect(r.ok[0]!.time).toBe(NOW - 600 + 3600 + 120);
    expect(r.ok[0]!.releaseAt).toBe(r.ok[0]!.time - 60);
    expect(r.ok[0]!.notes[0]).toMatch(/one change per hour/);
  });
});

describe('planDeferred', () => {
  it('samples an independent time per masternode inside the window', () => {
    const w = deferredWindow(NOW, NOW + 30 * 86400, 'mainnet')!;
    expect(w.latest).toBe(NOW + 30 * 86400 - 12 * 3600);
    const intents = Array.from({ length: 50 }, (_, k) => ({ mn: { ...mn, collateralIndex: k }, govHash: gov, outcome: 3 as const }));
    const r = planDeferred(intents, new Map(), NOW, w, rand);
    expect(r.ok.length).toBe(50);
    for (const p of r.ok) {
      expect(p.time).toBe(p.releaseAt);
      expect(p.time).toBeGreaterThanOrEqual(w.earliest);
      expect(p.time).toBeLessThanOrEqual(w.latest);
    }
    expect(new Set(r.ok.map((p) => p.time)).size).toBeGreaterThan(45);
  });
  it('testnet leaves a 10 minute margin; no window when the deadline is too close', () => {
    expect(deferredWindow(NOW, NOW + 3600, 'testnet')).toEqual({ earliest: NOW + 60, latest: NOW + 3000 });
    expect(deferredWindow(NOW, NOW + 600, 'testnet')).toBeNull();
    expect(deferredWindow(NOW, NOW + 3600, 'mainnet')).toBeNull();
  });
  it('skips a masternode whose 1-hour rule leaves no time', () => {
    const w = { earliest: NOW + 60, latest: NOW + 1800 };
    const r = planDeferred([{ mn, govHash: gov, outcome: 1 }], new Map([[currentKey(mn, gov), { outcome: 2, time: NOW }]]), NOW, w, rand);
    expect(r.skipped.length).toBe(1);
  });
  it('uniform() is unbiased in range and submitDelays stay within bounds', () => {
    for (let k = 0; k < 1000; k++) {
      const u = uniform(5, 9, rand);
      expect(u >= 5 && u <= 9).toBe(true);
    }
    expect(submitDelays(20, 5000, rand).every((d) => d >= 0 && d <= 5000)).toBe(true);
  });
});

describe('signing', () => {
  const p = { mn, govHash: gov, outcome: 3 as const, time: NOW, releaseAt: NOW, notes: [] };
  it('testnet signs the binary vote hash, mainnet the message; both recover to the voting key', () => {
    for (const net of ['testnet', 'mainnet'] as const) {
      const s = signPlanned(p, priv, true, net);
      const signer = recoverVoteSigner(s.sig, voteFields(p), net)!;
      expect(bytesToHex(signer.keyId)).toBe(votingKeyId(priv, true));
      expect(s.voteHash).toBe(governanceVoteHash(voteFields(p)));
      // the other network's scheme does not verify
      const other = recoverVoteSigner(s.sig, voteFields(p), net === 'testnet' ? 'mainnet' : 'testnet')!;
      expect(bytesToHex(other.keyId)).not.toBe(votingKeyId(priv, true));
    }
  });
  it('offline signing shows the signmessage text on mainnet and only the hash on testnet', () => {
    const m = offlineSigningRequest(p, 'mainnet');
    expect(m.scheme).toBe('message');
    expect(m.message).toBe(`${mn.collateralTxid}-1|${gov}|${VOTE_SIGNAL.FUNDING}|3|${NOW}`);
    const t = offlineSigningRequest(p, 'testnet');
    expect(t.scheme).toBe('hash');
    expect(t.message).toBeUndefined();
    expect(t.hashHex).toMatch(/^[0-9a-f]{64}$/);
  });
  it('cancel signatures are signmessage over the cancel text on both networks', () => {
    for (const net of ['testnet', 'mainnet'] as const) {
      const sig = cancelSignature(priv, true, net, 'dd'.repeat(32));
      expect(recoverMessageSigner(sig, relayCancelMessage(net, 'dd'.repeat(32)), net)!.address).toBe(votingAddressOf(priv, true, net));
    }
  });
});

describe('masternode discovery', () => {
  const e = protx[0]!;
  const keyId = bytesToHex(decodeAddress(e.votingAddress, 'testnet')!.hash160);
  const bridge: BridgeMasternode[] = protx.map((x) => ({ proTxHash: x.proTxHash, collateralTxid: x.collateralHash, collateralIndex: x.collateralIndex, votingAddress: x.votingAddress, type: x.type === 'Evo' ? 'evo' : 'regular', valid: true }));
  it('matches by the SML when there is one, and labels the bridge-only path', () => {
    const sml = new Map(protx.map((x) => [x.proTxHash, { votingAddress: x.votingAddress, isValid: true, nType: x.type === 'Evo' ? 1 : 0, typeProven: true }]));
    const a = matchMasternodes([{ index: 0, keyId }], bridge, sml, 'testnet');
    expect(a.owned.map((m) => m.proTxHash)).toEqual([e.proTxHash]);
    expect(a.owned[0]!.provenance.key).toBe('sml');
    const b = matchMasternodes([{ index: 0, keyId }], bridge, null, 'testnet');
    expect(b.owned[0]!.provenance.key).toBe('bridge');
    // a bridge entry claiming our key for a masternode whose SML key differs is ignored
    const lying = bridge.map((x, i) => (i === 1 ? { ...x, votingAddress: e.votingAddress } : x));
    expect(matchMasternodes([{ index: 0, keyId }], lying, sml, 'testnet').owned.length).toBe(1);
    // the SML lists it but the bridge does not: no outpoint, reported missing
    expect(matchMasternodes([{ index: 0, keyId }], [], sml, 'testnet')).toEqual({ owned: [], missing: [e.proTxHash] });
  });
  it('proves the outpoint with the real ProRegTx and drops a lying bridge entry', async () => {
    const raw = new Map(protx.map((x) => [x.proTxHash, hexToBytes(x.raw)]));
    const fetchRaw = async (t: string) => raw.get(t)!;
    const owned = matchMasternodes([{ index: 0, keyId }], bridge, null, 'testnet').owned;
    const ok = await proveCollaterals(owned, fetchRaw, 'testnet');
    expect(ok.mns[0]!.provenance.collateral).toBe('protx');
    expect(ok.mns[0]!.payoutAddress).toMatch(/^y/);
    const bad = await proveCollaterals([{ ...owned[0]!, collateralIndex: owned[0]!.collateralIndex + 1 }], fetchRaw, 'testnet');
    expect(bad).toEqual({ mns: [], mismatch: [e.proTxHash] });
  });
});

describe('watched votes', () => {
  const base = (over: Partial<WatchedVote> = {}): WatchedVote => ({
    ...signPlanned({ mn, govHash: gov, outcome: 1, time: NOW, releaseAt: NOW, notes: [] }, priv, true, 'testnet'),
    refs: [{ relay: 'https://r1', id: 'ab'.repeat(16) }],
    status: 'held',
    rebroadcasts: 0,
    ...over,
  });
  it('a newer vote drops an older one that never left this browser; one a relay took waits for the bridge', () => {
    const a = base();
    const b = { ...base(), ...signPlanned({ mn, govHash: gov, outcome: 2, time: NOW + 10, releaseAt: NOW + 10, notes: [] }, priv, true, 'testnet') };
    const m = mergeWatched([a], [b]);
    expect(m.find((x) => x.voteHash === a.voteHash)!.status).toBe('held');
    expect(m.find((x) => x.voteHash === b.voteHash)!.status).toBe('held');
    const queued = { ...a, refs: [], status: 'queued' as const };
    const d = mergeWatched([queued], [b]).find((x) => x.voteHash === a.voteHash)!;
    expect(d).toMatchObject({ status: 'dropped', replacedBy: b.voteHash });
  });
  it('bridge verdicts, rebroadcast timing and relay choice', () => {
    const v = base();
    expect(bridgeVerdict(v, { outcome: 1, time: NOW })).toEqual({ status: 'confirmed' });
    expect(bridgeVerdict(v, { outcome: 2, time: NOW + 5 })).toEqual({ status: 'replaced', replacedBy: '' });
    expect(bridgeVerdict(v, undefined)).toBeNull();
    expect(needsRebroadcast(v, NOW + 599)).toBe(false);
    expect(needsRebroadcast(v, NOW + 600)).toBe(true);
    expect(needsRebroadcast({ ...v, rebroadcasts: 3 }, NOW + 99999)).toBe(false);
    // restored from another device's PENDING backup: never re-sent from here (it may have been cancelled since)
    expect(needsRebroadcast({ ...v, restored: true }, NOW + 99999)).toBe(false);
    expect(pickRebroadcastRelay(v, ['https://r1', 'https://r2'])).toBe('https://r2');
    expect(pruneWatched([{ ...v, status: 'confirmed' }], NOW + 8 * 86400)).toEqual([]);
  });
  it('round-trips through the keyring PENDING record', () => {
    const v = base();
    const back = fromPending(toPending(v), v.proTxHash, v.voteHash);
    expect(back).toMatchObject({ sig: v.sig, time: v.time, outcome: v.outcome, refs: v.refs, collateralTxid: v.collateralTxid });
  });
  it('parses relay answers strictly', () => {
    expect(parseRelayState({ id: 'ab'.repeat(16), voteHash: 'cd'.repeat(32), status: 'held', releaseAt: 5 }).status).toBe('held');
    expect(() => parseRelayState({ id: 'x', voteHash: 'cd'.repeat(32), status: 'held' })).toThrow();
    expect(() => parseRelayState({ id: 'ab'.repeat(16), voteHash: 'cd'.repeat(32), status: 'pwned' })).toThrow();
  });
});
