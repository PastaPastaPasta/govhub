import { beforeAll, describe, expect, it } from 'vitest';
import { installRecordedDapi, RECORDED_NODE } from '../data/dapiRecorded.ts';
import { fetchTransaction } from '../data/dapi.ts';
import { FixtureBridge, loadFixtures, type FixtureSnapshot } from '../data/fixtures.ts';
import type { Proposal, Tally } from '../data/types.ts';
import type { BridgeMasternode, BridgeVote } from '../data/bridge.ts';
import { BRIDGE_TARGET, PLATFORM_TARGET, tallyProvenance, voteVerdict } from './verdict.ts';
import { checkContent, verifyCollateral, type TxLookup } from './collateral.ts';
import { verifyVotes } from './votes.ts';

let snap: FixtureSnapshot;
beforeAll(async () => {
  snap = await loadFixtures();
  await installRecordedDapi();
});

const byName = (n: string): Proposal => snap.proposals.find((p) => p.name === n)!;

describe('collateral verification over recorded mainnet DAPI responses', () => {
  it('all 28 fixture proposals verify through the real DapiCore decoder', async () => {
    for (const p of snap.proposals) {
      const tx = await fetchTransaction([RECORDED_NODE], p.collateralTxid);
      const v = verifyCollateral(p, tx);
      expect(v.ok, `${p.name}: ${JSON.stringify(v.steps.filter((s) => s.status !== 'ok'))}`).toBe(true);
      expect(v.govHashComputed).toBe(p.govHash);
    }
  });

  it('a changed displayed name is caught even though the hash still matches', async () => {
    const p = { ...byName('OrchardPay'), name: 'OrchardPay-v2' };
    const v = verifyCollateral(p, await fetchTransaction([RECORDED_NODE], p.collateralTxid));
    expect(v.ok).toBe(false);
    expect(v.steps.find((s) => s.id === 'hash')!.status).toBe('ok');
    expect(v.steps.find((s) => s.id === 'fields')!.status).toBe('fail');
  });

  it('tampered dataHex fails the hash and the OP_RETURN check', async () => {
    const orig = byName('OrchardPay');
    const p = { ...orig, dataHex: orig.dataHex.replace('4f7263686172645061', '4f7263686172645062') };
    const v = verifyCollateral(p, await fetchTransaction([RECORDED_NODE], p.collateralTxid));
    expect(v.ok).toBe(false);
    expect(v.steps.find((s) => s.id === 'hash')!.status).toBe('fail');
    expect(v.steps.find((s) => s.id === 'collateral')!.status).toBe('fail');
  });

  it('collateral of another proposal fails (txid binding and OP_RETURN)', async () => {
    const a = byName('OrchardPay');
    const b = byName('dash-intents');
    const v = verifyCollateral({ ...a, collateralTxid: b.collateralTxid }, await fetchTransaction([RECORDED_NODE], b.collateralTxid));
    expect(v.ok).toBe(false);
    expect(v.steps.find((s) => s.id === 'collateral')!.detail).toContain('no-matching-op-return');
  });

  it('fewer than 6 confirmations fails; missing ChainLock only warns', async () => {
    const p = byName('OrchardPay');
    const tx = await fetchTransaction([RECORDED_NODE], p.collateralTxid);
    const v = verifyCollateral(p, { ...tx, confirmations: 5, isChainLocked: false });
    expect(v.ok).toBe(false);
    expect(v.steps.find((s) => s.id === 'confirmations')!.status).toBe('fail');
    expect(v.steps.find((s) => s.id === 'chainlock')!.status).toBe('warn');
  });

  it('unknown txid: the recorded node answers NOT_FOUND like a real one', async () => {
    await expect(fetchTransaction([RECORDED_NODE], '00'.repeat(32))).rejects.toThrow(/all nodes failed/);
    const v = verifyCollateral(byName('OrchardPay'), { error: 'Transaction not found' });
    expect(v.ok).toBe(false);
    expect(v.steps.find((s) => s.id === 'tx')!.status).toBe('fail');
  });

  it('content checks need no network', () => {
    const { steps } = checkContent(byName('kwvg-core-oct26'));
    expect(steps.map((s) => s.status)).toEqual(['ok', 'ok']);
  });
});

describe('vote verification against the fixture bridge', () => {
  const bridge = new FixtureBridge();
  let votes: BridgeVote[];
  let mns: BridgeMasternode[];
  let p: Proposal;
  let tally: Tally;
  beforeAll(async () => {
    p = byName('dash-intents'); // 95 yes, 64 no, 23 abstain
    votes = (await bridge.votes(p.govHash)).votes;
    mns = (await bridge.mnlist()).masternodes;
    tally = snap.tallies.get(p.govHash)!;
  }, 30_000);
  const check = (over: Partial<Parameters<typeof verifyVotes>[0]> = {}) =>
    verifyVotes({ govHash: p.govHash, votes, masternodes: mns, network: 'mainnet', now: snap.now, targets: [{ name: PLATFORM_TARGET, tally }], ...over });

  it('recomputes the tally and voteSetHash exactly', () => {
    const r = check();
    expect(r.targets[0]!.matches).toBe(true);
    expect(r.weighted).toEqual({ yes: 95, no: 64, abstain: 23 });
    expect(r.total).toBe(95 + 64 + 23 + 1); // + one superseded vote
    expect(r.verified).toBe(r.total);
    expect(Object.values(r.problems).every((n) => n === 0)).toBe(true);
    expect(r.keysFrom).toBe('bridge');
    // A match on bridge-supplied keys is not "verified".
    expect(voteVerdict(r, tally.asOfHeight).level).toBe('keys-reported');
  });

  it('is verified only with keys confirmed by the SML', () => {
    const sml = new Map(mns.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: true, nType: 0 }]));
    const r = check({ sml });
    expect(r.keysFrom).toBe('sml');
    expect(voteVerdict(r, tally.asOfHeight).level).toBe('verified');
    const prov = tallyProvenance({ name: PLATFORM_TARGET, prov: { kind: 'proof', source: 'Platform' }, tally }, r, tally.asOfHeight);
    expect(prov.kind).toBe('verified');
  });

  it('a forged signature is rejected and the tally no longer matches', () => {
    const forged = votes.map((v, i) => (i === 3 ? { ...v, sig: votes[4]!.sig } : v)); // MN 3's vote carrying MN 4's signature
    const r = check({ votes: forged });
    expect(r.problems['bad-signature']).toBe(1);
    const t = r.targets[0]!;
    expect(t.matches).toBe(false);
    expect(t.compare.find((c) => c.field === 'Yes (weighted)')!.ok).toBe(false);
    expect(t.compare.find((c) => c.field === 'voteSetHash')!.ok).toBe(false);
    expect(voteVerdict(r, tally.asOfHeight).level).toBe('mismatch');
    expect(tallyProvenance({ name: PLATFORM_TARGET, prov: { kind: 'proof', source: 'Platform' }, tally }, r, tally.asOfHeight).kind).toBe('mismatch');
  });

  it('a recount at a newer height than the tally is "different height", not a mismatch', () => {
    const r = check({ votes: votes.slice(0, -5) });
    expect(voteVerdict(r, tally.asOfHeight + 12).level).toBe('different-height');
    const prov = tallyProvenance({ name: PLATFORM_TARGET, prov: { kind: 'proof', source: 'Platform' }, tally }, r, tally.asOfHeight + 12);
    expect(prov.kind).toBe('proof');
    expect(prov.detail).toContain('votes are as of block');
  });

  it('compares with every published tally and labels only the one that matched', () => {
    const live = { ...tally, asOfHeight: tally.asOfHeight + 3, yesWeighted: tally.yesWeighted + 1 };
    const r = check({ targets: [{ name: PLATFORM_TARGET, tally }, { name: BRIDGE_TARGET, tally: live }] });
    expect(r.targets.map((t) => t.matches)).toEqual([true, false]);
    expect(voteVerdict(r, tally.asOfHeight).matched?.name).toBe(PLATFORM_TARGET);
    // The bridge tally (shown, because it is newer) must not inherit the Platform match.
    const bridgeProv = tallyProvenance({ name: BRIDGE_TARGET, prov: { kind: 'reported', source: 'bridge' }, tally: live }, r, tally.asOfHeight);
    expect(bridgeProv.kind).toBe('reported');
  });

  it('votes replayed as votes for another proposal do not verify', () => {
    const other = byName('OrchardPay');
    const r = check({ govHash: other.govHash, targets: [{ name: PLATFORM_TARGET, tally: snap.tallies.get(other.govHash)! }] });
    expect(r.verified).toBe(0);
    expect(r.problems['bad-signature']).toBe(votes.length);
  });

  it('votes from masternodes missing in the list are not counted', () => {
    const r = check({ masternodes: mns.slice(10) });
    expect(r.problems['unknown-masternode']).toBe(11); // MNs 0..9, MN 0 twice
    expect(r.targets[0]!.matches).toBe(false);
  });

  it('PoSe-banned masternodes still count, like Core (GetMNByCollateral)', () => {
    const banned = mns.map((m, i) => (i < 5 ? { ...m, valid: false } : m));
    expect(check({ masternodes: banned }).targets[0]!.matches).toBe(true);
  });

  it('a duplicated proTxHash or outpoint in the MN list is refused', () => {
    const dupProTx = mns.map((m, i) => (i === 7 ? { ...m, proTxHash: mns[8]!.proTxHash } : m));
    const r = check({ masternodes: dupProTx });
    expect(r.problems['duplicate-masternode']).toBe(2);
    const dupOutpoint = [...mns, { ...mns[2]!, proTxHash: 'ee'.repeat(32) }];
    expect(check({ masternodes: dupOutpoint }).problems['duplicate-masternode']).toBe(1);
  });

  it('votes on other signals are skipped, not counted as problems', () => {
    const r = check({ votes: [...votes, { ...votes[0]!, signal: 2 }] });
    expect(r.otherSignal).toBe(1);
    expect(r.targets[0]!.matches).toBe(true);
  });

  it('SML cross-check flags a voting address the DAPI list disagrees with', () => {
    const sml = new Map(mns.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: true, nType: 0 }]));
    sml.set(mns[1]!.proTxHash, { votingAddress: mns[2]!.votingAddress, isValid: true, nType: 0 });
    const r = check({ sml, targets: [] });
    expect(r.problems['sml-mismatch']).toBe(1);
    expect(r.smlChecked).toBe(votes.length);
    expect(voteVerdict(r, 0).level).toBe('no-tally');
  });
});

describe('collateral second-node cross-check', () => {
  it('a disagreeing second node fails the verdict; a missing one only warns', async () => {
    const p = byName('OrchardPay');
    const tx = await fetchTransaction([RECORDED_NODE], p.collateralTxid);
    expect(verifyCollateral(p, { ...tx, second: { node: 'b:443', height: tx.height, sameBytes: true } }).ok).toBe(true);
    expect(verifyCollateral(p, { ...tx, second: null }).steps.find((s) => s.id === 'crosscheck')!.status).toBe('warn');
    const bad = verifyCollateral(p, { ...tx, second: { node: 'b:443', height: tx.height + 1, sameBytes: true } });
    expect(bad.ok).toBe(false);
    expect(bad.steps.find((s) => s.id === 'crosscheck')!.status).toBe('fail');
  });
});

describe('TxLookup type is what DapiCore returns', () => {
  it('has the fields the verdict reads', async () => {
    const t: TxLookup = await fetchTransaction([RECORDED_NODE], byName('OrchardPay').collateralTxid);
    expect(t.node).toBe(RECORDED_NODE);
    expect(t.isChainLocked).toBe(true);
    expect(t.confirmations).toBeGreaterThan(6);
  });
});
