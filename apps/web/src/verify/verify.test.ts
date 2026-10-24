import { beforeAll, describe, expect, it } from 'vitest';
import { installRecordedDapi, RECORDED_NODE } from '../data/dapiRecorded.ts';
import { fetchTransaction } from '../data/dapi.ts';
import { FixtureBridge, loadFixtures, type FixtureSnapshot } from '../data/fixtures.ts';
import type { Proposal } from '../data/types.ts';
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
  const run = async (name: string, mutate?: (v: Awaited<ReturnType<FixtureBridge['votes']>>) => void) => {
    const p = byName(name);
    const votes = await bridge.votes(p.govHash);
    mutate?.(votes);
    const mn = await bridge.mnlist();
    return verifyVotes({ govHash: p.govHash, votes: votes.votes, masternodes: mn.masternodes, network: 'mainnet', now: snap.now, expected: snap.tallies.get(p.govHash)! });
  };

  it('recomputes the tally and voteSetHash exactly', async () => {
    const r = await run('dash-intents'); // 95 yes, 64 no, 23 abstain
    expect(r.matches).toBe(true);
    expect(r.weighted).toEqual({ yes: 95, no: 64, abstain: 23 });
    expect(r.total).toBe(95 + 64 + 23 + 1); // + one superseded vote
    expect(r.verified).toBe(r.total);
    expect(Object.values(r.problems).every((n) => n === 0)).toBe(true);
  }, 30_000);

  it('a forged signature is rejected and the tally no longer matches', async () => {
    const r = await run('dash-intents', (v) => {
      const s = v.votes[3]!.sig;
      v.votes[3]!.sig = v.votes[4]!.sig === s ? s : v.votes[4]!.sig; // MN 3's vote carrying MN 4's signature
    });
    expect(r.problems['bad-signature']).toBe(1);
    expect(r.matches).toBe(false);
    expect(r.compare.find((c) => c.field === 'Yes (weighted)')!.ok).toBe(false);
    expect(r.compare.find((c) => c.field === 'voteSetHash')!.ok).toBe(false);
  }, 30_000);

  it('votes replayed as votes for another proposal do not verify', async () => {
    const other = byName('OrchardPay');
    const p = byName('dash-intents');
    const votes = await bridge.votes(p.govHash);
    const mn = await bridge.mnlist();
    const r2 = verifyVotes({ govHash: other.govHash, votes: votes.votes, masternodes: mn.masternodes, network: 'mainnet', now: snap.now, expected: snap.tallies.get(other.govHash)! });
    expect(r2.verified).toBe(0);
    expect(r2.problems['bad-signature']).toBe(votes.votes.length);
  }, 30_000);

  it('votes from masternodes missing in the list are not counted', async () => {
    const p = byName('dash-intents');
    const votes = await bridge.votes(p.govHash);
    const mn = (await bridge.mnlist()).masternodes.slice(10);
    const r = verifyVotes({ govHash: p.govHash, votes: votes.votes, masternodes: mn, network: 'mainnet', now: snap.now, expected: snap.tallies.get(p.govHash)! });
    expect(r.problems['unknown-masternode']).toBe(11); // MNs 0..9, MN 0 twice
    expect(r.matches).toBe(false);
  }, 30_000);

  it('SML cross-check flags a voting address the DAPI list disagrees with', async () => {
    const p = byName('dash-intents');
    const votes = await bridge.votes(p.govHash);
    const mn = (await bridge.mnlist()).masternodes;
    const sml = new Map(mn.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: true, nType: 0 }]));
    sml.set(mn[1]!.proTxHash, { votingAddress: mn[2]!.votingAddress, isValid: true, nType: 0 });
    const r = verifyVotes({ govHash: p.govHash, votes: votes.votes, masternodes: mn, network: 'mainnet', now: snap.now, expected: null, sml });
    expect(r.problems['sml-mismatch']).toBe(1);
    expect(r.smlChecked).toBe(votes.votes.length);
    expect(r.matches).toBeNull();
  }, 30_000);
});

describe('TxLookup type is what DapiCore returns', () => {
  it('has the fields the verdict reads', async () => {
    const t: TxLookup = await fetchTransaction([RECORDED_NODE], byName('OrchardPay').collateralTxid);
    expect(t.node).toBe(RECORDED_NODE);
    expect(t.isChainLocked).toBe(true);
    expect(t.confirmations).toBeGreaterThan(6);
  });
});
