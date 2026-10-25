// The key -> masternode lookup always ends: every step has a deadline, DAPI trouble falls back to the bridge's list (labelled), and
// only an unreadable bridge is an error.
import { describe, expect, it } from 'vitest';
import type { AgreedSml } from '@govhub/dapi';
import type { BridgeMnList } from '../data/bridge.ts';
import { LookupTimeout, lookupMasternodes, type LookupDeps } from './lookup.ts';

// masternode-27 on testnet (public data, see the live repro in the PR)
const PRO = 'c87218fb9d031f4926c22430c69b4edf1f0fb80c331c1a79e3b1b3873407c0ac';
const ADDR = 'yUi9YLkmErtbsrkbyCBFkwN4ic31GbCtB3';
const KEY_ID = '5c0c201c793d6cb7265b6897058b0b1e75fdf528';
const LIST: BridgeMnList = {
  height: 1578728,
  listHash: 'x',
  masternodes: [
    { proTxHash: PRO, collateralTxid: '4ee3ff5074723d995f4cb957a954587c6c637a42655ada8f4054037b28d1e7a8', collateralIndex: 62, votingAddress: ADDR, type: 'regular', valid: true },
    { proTxHash: 'ab'.repeat(32), collateralTxid: 'cd'.repeat(32), collateralIndex: 0, votingAddress: 'yd5tNnzyjwYXXisbuv4ScDMzBLuDtr49gQ', type: 'regular', valid: true },
  ],
};
const SML = { masternodes: [{ proTxHash: PRO, votingAddress: ADDR, isValid: true, nType: 0, nVersion: 1 }], agreedBy: ['n1', 'n2'] } as unknown as AgreedSml;
const never = <T,>(signal: AbortSignal) => new Promise<T>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
const keys = [{ index: 0, keyId: KEY_ID }];
const T = { bridgeMs: 50, smlMs: 50, protxMs: 50 };

describe('lookupMasternodes', () => {
  it('finds masternode-27 for its voting key (SML decides, ProRegTx unreachable keeps the bridge outpoint, labelled)', async () => {
    const deps: LookupDeps = { mnlist: async () => LIST, sml: async () => SML, rawTx: async () => Promise.reject(new Error('down')), network: 'testnet' };
    const steps: string[] = [];
    // the ProRegTx step paces its reads (with decoys, D-026): give it room to see every read fail
    const r = await lookupMasternodes(keys, deps, { signal: new AbortController().signal, onStep: (s) => steps.push(s), timeouts: { ...T, protxMs: 3000 } });
    expect(steps).toEqual(['bridge', 'sml', 'protx']);
    expect(r.owned).toHaveLength(1);
    expect(r.owned[0]).toMatchObject({ proTxHash: PRO, collateralIndex: 62, type: 'regular', valid: true, provenance: { key: 'sml', collateral: 'bridge' } });
    expect(r.smlNodes).toBe(2);
    expect(r.warning).toMatch(/could not be proved/);
  });
  it('a DAPI SML that never answers times out and falls back to the bridge list, with a warning', async () => {
    const deps: LookupDeps = { mnlist: async () => LIST, sml: never, rawTx: (_txid, signal) => never(signal), network: 'testnet' };
    const t0 = Date.now();
    const r = await lookupMasternodes(keys, deps, { signal: new AbortController().signal, timeouts: T });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.owned.map((m) => m.proTxHash)).toEqual([PRO]);
    expect(r.owned[0]!.provenance.key).toBe('bridge');
    expect(r.warning).toMatch(/Could not confirm with DAPI evonodes \(checking the masternode list with DAPI evonodes took longer than 0 s\)/);
  });
  it('a bridge that never answers is an error that names the step', async () => {
    const deps: LookupDeps = { mnlist: never, sml: async () => SML, rawTx: null, network: 'testnet' };
    await expect(lookupMasternodes(keys, deps, { signal: new AbortController().signal, timeouts: T })).rejects.toBeInstanceOf(LookupTimeout);
  });
  it('stops when aborted (the keys changed, or the page went away)', async () => {
    const ctrl = new AbortController();
    const deps: LookupDeps = { mnlist: async () => LIST, sml: never, rawTx: null, network: 'testnet' };
    const p = lookupMasternodes(keys, deps, { signal: ctrl.signal, timeouts: { ...T, smlMs: 10_000 } });
    setTimeout(() => ctrl.abort(new Error('gone')), 20);
    await expect(p).rejects.toThrow('gone');
  });
  it('no DAPI (fixtures): the bridge list, labelled as such, and keys with no masternode find none', async () => {
    const deps: LookupDeps = { mnlist: async () => LIST, sml: null, rawTx: null, network: 'testnet' };
    const r = await lookupMasternodes([{ index: 0, keyId: '00'.repeat(20) }], deps, { signal: new AbortController().signal, timeouts: T });
    expect(r).toMatchObject({ owned: [], missing: [], smlNodes: 0 });
  });
});
