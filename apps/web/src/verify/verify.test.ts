import { AllNodesFailedError, createDapi, VerificationError, type Dapi, type VerifiedTransaction } from '@govhub/dapi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installRecordedDapi, RECORDED_NODE } from '../data/dapiRecorded.ts';
import { lookupCollateral } from '../data/dapi.ts';
import { FixtureBridge, loadFixtures, type FixtureSnapshot } from '../data/fixtures.ts';
import type { Proposal, Tally } from '../data/types.ts';
import { BridgeError, type BridgeMasternode, type BridgeVote } from '../data/bridge.ts';
import { BRIDGE_TARGET, PLATFORM_TARGET, tallyProvenance, voteVerdict } from './verdict.ts';
import { checkContent, verifyCollateral, type TxLookup } from './collateral.ts';
import { collateralHeightProv, collateralStatus } from './facts.ts';
import { verifyVotes, type VoteRun } from './votes.ts';

let snap: FixtureSnapshot;
beforeAll(async () => {
  snap = await loadFixtures();
  await installRecordedDapi();
});

const byName = (n: string): Proposal => snap.proposals.find((p) => p.name === n)!;
/** What the recorded mainnet node says about a transaction (no proof: the recording has no blocks). */
const recorded = (txid: string): Promise<TxLookup> => lookupCollateral(createDapi({ network: 'mainnet', nodes: [RECORDED_NODE] }), txid, { verify: false });
const run = (result: ReturnType<typeof verifyVotes>, votesAsOf: number): VoteRun => ({ result, votesAsOf, mnlistHeight: votesAsOf, listMatches: null });

describe('collateral verification over recorded mainnet DAPI responses', () => {
  it('all 28 fixture proposals verify through the real DapiCore decoder', async () => {
    for (const p of snap.proposals) {
      const v = verifyCollateral(p, await recorded(p.collateralTxid), 'mainnet');
      expect(v.ok, `${p.name}: ${JSON.stringify(v.steps.filter((s) => s.status !== 'ok'))}`).toBe(true);
      expect(v.govHashComputed).toBe(p.govHash);
    }
  });

  it('a changed displayed name is caught even though the hash still matches', async () => {
    const p = { ...byName('OrchardPay'), name: 'OrchardPay-v2' };
    const v = verifyCollateral(p, await recorded(p.collateralTxid), 'mainnet');
    expect(v.ok).toBe(false);
    expect(v.steps.find((s) => s.id === 'hash')!.status).toBe('ok');
    expect(v.steps.find((s) => s.id === 'fields')!.status).toBe('fail');
  });

  it('tampered dataHex fails the hash and the OP_RETURN check', async () => {
    const orig = byName('OrchardPay');
    const p = { ...orig, dataHex: orig.dataHex.replace('4f7263686172645061', '4f7263686172645062') };
    const v = verifyCollateral(p, await recorded(p.collateralTxid), 'mainnet');
    expect(v.ok).toBe(false);
    expect(v.steps.find((s) => s.id === 'hash')!.status).toBe('fail');
    expect(v.steps.find((s) => s.id === 'collateral')!.status).toBe('fail');
  });

  it('collateral of another proposal fails (txid binding and OP_RETURN)', async () => {
    const a = byName('OrchardPay');
    const b = byName('dash-intents');
    const v = verifyCollateral({ ...a, collateralTxid: b.collateralTxid }, await recorded(b.collateralTxid), 'mainnet');
    expect(v.ok).toBe(false);
    expect(v.steps.find((s) => s.id === 'collateral')!.detail).toContain('no-matching-op-return');
  });

  it('fewer than 6 confirmations fails; missing ChainLock only warns', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const v = verifyCollateral(p, { ...tx, confirmations: 5, chainLocked: 'no' }, 'mainnet');
    expect(v.ok).toBe(false);
    expect(v.steps.find((s) => s.id === 'confirmations')!.status).toBe('fail');
    expect(v.steps.find((s) => s.id === 'chainlock')!.status).toBe('warn');
  });

  it('unknown txid: the recorded node answers NOT_FOUND like a real one', async () => {
    await expect(recorded('00'.repeat(32))).rejects.toThrow(/node attempts failed/);
    const v = verifyCollateral(byName('OrchardPay'), { error: 'Transaction not found' }, 'mainnet');
    expect(v.ok).toBe(false);
    expect(v.steps.find((s) => s.id === 'tx')!.status).toBe('fail');
  });

  it('content checks need no network', () => {
    const { steps } = checkContent(byName('kwvg-core-oct26'));
    expect(steps.map((s) => s.status)).toEqual(['ok', 'ok']);
  });
});

describe('what is verified and what is node-reported (ChainLock, confirmations, height)', () => {
  const stepOf = (v: ReturnType<typeof verifyCollateral>, id: string) => v.steps.find((s) => s.id === id)!;
  const proven = (tx: TxLookup, over: Partial<NonNullable<VerifiedTransaction['proof']['chainLock']>> = {}): TxLookup => ({
    ...tx,
    confirmations: 760,
    chainLocked: 'verified',
    proof: { merkle: true, blockHash: 'verified', chainLock: { height: tx.height + 758, blockHash: 'aa'.repeat(32), quorumHash: 'bb'.repeat(32), exact: true, verifiedConfirmations: 759, ...over }, anchor: null, notes: [] },
  });

  it('claims only (the recorded replay): ChainLock and confirmations are "reported", the second-node check stands in for the block proof', async () => {
    const p = byName('OrchardPay');
    const v = verifyCollateral(p, await recorded(p.collateralTxid), 'mainnet');
    expect(v.ok).toBe(true);
    for (const id of ['confirmations', 'chainlock']) expect(stepOf(v, id)).toMatchObject({ status: 'ok', basis: 'reported' });
    expect(stepOf(v, 'chainlock').detail).toContain('a node reports');
    expect(stepOf(v, 'crosscheck').status).toBe('warn');
    expect(v.steps.some((s) => s.id === 'block')).toBe(false);
    expect(v.chain).toMatchObject({ merkle: false, chainLocked: 'claimed', provenConfirmations: null });
  });

  it('the per-transaction ChainLock (chain not anchored) is consistent, not proven: every chain step "reported", even on mainnet', async () => {
    const p = byName('OrchardPay');
    const v = verifyCollateral(p, proven(await recorded(p.collateralTxid)), 'mainnet');
    expect(v.ok).toBe(true);
    expect(stepOf(v, 'block')).toMatchObject({ status: 'ok', basis: 'reported' });
    expect(v.steps.some((s) => s.id === 'crosscheck')).toBe(false);
    expect(stepOf(v, 'chainlock')).toMatchObject({ status: 'ok', basis: 'reported' });
    expect(stepOf(v, 'chainlock').detail).toContain('the chain could not be verified here');
    expect(stepOf(v, 'chainlock').more).toContain('masternode list DAPI nodes agree on');
    expect(stepOf(v, 'confirmations')).toMatchObject({ status: 'ok', basis: 'reported' });
    expect(stepOf(v, 'confirmations').detail).toContain('at least 759');
    expect(stepOf(v, 'height').basis).toBe('reported');
    expect(v.chain).toMatchObject({ merkle: true, chainLocked: 'verified', provenConfirmations: null, confirmations: 760 });
  });

  it('a block proof without a ChainLock proof keeps confirmations and the lock as node claims', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const v = verifyCollateral(p, { ...tx, proof: { merkle: true, blockHash: 'claimed', chainLock: null, anchor: null, notes: ['no BLS verifier: ChainLock signature not checked'] } }, 'mainnet');
    // a merkle proof alone does not tie the block to the chain (no proof-of-work): it stays "reported", and a second node weighs in
    expect(stepOf(v, 'block')).toMatchObject({ status: 'ok', basis: 'reported' });
    expect(stepOf(v, 'block').detail).toContain('nothing ties that block to the chain');
    expect(stepOf(v, 'crosscheck').status).toBe('warn');
    expect(stepOf(v, 'height').basis).toBe('reported');
    expect(stepOf(v, 'chainlock')).toMatchObject({ status: 'ok', basis: 'reported' });
    expect(stepOf(v, 'chainlock').more).toContain('no BLS verifier');
    expect(stepOf(v, 'confirmations').basis).toBe('reported');
    expect(v.chain).toMatchObject({ merkle: true, chainLocked: 'claimed', lockDepth: null });
  });

  it('a ChainLock proof that FAILED (as opposed to not attempted) is a warning, not a quiet "ok"', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const v = verifyCollateral(p, { ...tx, proof: { merkle: true, blockHash: 'verified', chainLock: null, anchor: null, notes: ['chainlock proof failed: header chain breaks at +3'] } }, 'mainnet');
    expect(stepOf(v, 'chainlock')).toMatchObject({ status: 'warn', basis: 'reported' });
    expect(stepOf(v, 'chainlock').detail).toContain('FAILED');
  });

  it('a verified ChainLock that is too shallow does not vouch for the 6 confirmations', async () => {
    const p = byName('OrchardPay');
    const v = verifyCollateral(p, proven(await recorded(p.collateralTxid), { verifiedConfirmations: 2 }), 'mainnet');
    expect(stepOf(v, 'chainlock').basis).toBe('reported');
    expect(stepOf(v, 'confirmations')).toMatchObject({ status: 'ok', basis: 'reported' });
    expect(v.chain).toMatchObject({ provenConfirmations: null, lockDepth: 2 });
  });

  it('anchored: the block is the verified one at its height; confirmations count from the verified tip; final only under the ChainLock', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const anchoredTx = (final: boolean): TxLookup => ({
      ...tx, confirmations: 760, chainLocked: final ? 'verified' : 'claimed',
      proof: {
        merkle: true, blockHash: 'verified', notes: [],
        anchor: { tip: tx.height + 999, confirmations: 1000, chainLockHeight: final ? tx.height + 998 : tx.height - 1, weak: null, trust: 'proof-of-work' },
        chainLock: final ? { height: tx.height + 998, blockHash: 'aa'.repeat(32), quorumHash: 'bb'.repeat(32), exact: true, verifiedConfirmations: 999 } : null,
      },
    });
    const v = verifyCollateral(p, anchoredTx(true), 'mainnet');
    expect(v.ok).toBe(true);
    expect(stepOf(v, 'block')).toMatchObject({ basis: 'verified' });
    expect(stepOf(v, 'block').detail).toContain('chain verified in this browser');
    expect(stepOf(v, 'confirmations')).toMatchObject({ status: 'ok', basis: 'verified', detail: 'at least 1,000 (Core needs 6)' });
    expect(stepOf(v, 'chainlock')).toMatchObject({ status: 'ok', basis: 'verified' });
    expect(stepOf(v, 'height').basis).toBe('verified');
    expect(v.steps.some((s) => s.id === 'crosscheck')).toBe(false); // no second node needed
    expect(v.chain!.anchored).toEqual({ tip: tx.height + 999, confirmations: 1000, chainLockHeight: tx.height + 998, final: true, weak: null, trust: 'proof-of-work' });
    // the same proof on a chain proof of work does not protect (testnet): every chain step stays "reported"
    const t = anchoredTx(true);
    const weak = verifyCollateral(p, { ...t, proof: { ...t.proof, anchor: { ...t.proof.anchor!, weak: 'testnet difficulty is too low' } } }, 'mainnet');
    for (const id of ['block', 'confirmations', 'chainlock', 'height']) expect(stepOf(weak, id).basis, id).toBe('reported');
    expect(stepOf(weak, 'chainlock').more).toContain('not secure');
    // a block above the newest ChainLock: inclusion and depth are still proven, finality is not
    const w = verifyCollateral(p, anchoredTx(false), 'mainnet');
    expect(stepOf(w, 'chainlock')).toMatchObject({ status: 'warn', basis: 'verified' });
    expect(stepOf(w, 'chainlock').detail).toContain('not final yet');
    expect(stepOf(w, 'confirmations').basis).toBe('verified');
    // nothing in any step mentions developer parameters
    expect([...v.steps, ...w.steps].map((s) => s.detail).join(' ')).not.toMatch(/maxHeaderSpan/);
  });

  it('testnet: a chain anchored on a quorum-proven ChainLock makes the chain facts "verified"; proof of work keeps them "reported"', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    const anchored = (trust: 'quorum-proof' | 'proof-of-work', weak: string | null): TxLookup => ({
      ...tx, confirmations: 760, chainLocked: 'verified',
      proof: {
        merkle: true, blockHash: 'verified', notes: [],
        anchor: { tip: tx.height + 999, confirmations: 1000, chainLockHeight: tx.height + 998, weak, trust },
        chainLock: { height: tx.height + 998, blockHash: 'aa'.repeat(32), quorumHash: 'bb'.repeat(32), exact: true, verifiedConfirmations: 999 },
      },
    });
    const proven = verifyCollateral(p, anchored('quorum-proof', null), 'testnet');
    for (const id of ['block', 'confirmations', 'chainlock', 'height']) expect(stepOf(proven, id).basis, id).toBe('verified');
    expect(proven.chain!.weak).toBeUndefined();
    const status = collateralStatus(proven.chain!);
    expect(status.prov.kind).toBe('verified');
    expect(status.prov.detail).toContain('quorum checkpoint (no proof of work)');
    expect(collateralHeightProv(proven.chain!, proven.chain!.height, { kind: 'fixture', source: 'x' }).kind).toBe('verified');
    const pow = verifyCollateral(p, anchored('proof-of-work', 'testnet difficulty is too low'), 'testnet');
    for (const id of ['block', 'confirmations', 'chainlock', 'height']) expect(stepOf(pow, id).basis, id).toBe('reported');
    expect(collateralStatus(pow.chain!).prov.kind).toBe('reported');
  });

  it('testnet: the fallback ChainLock proof (chain not anchored) is never "verified"; every chain fact is "reported (not secure)"', async () => {
    const p = byName('OrchardPay');
    const fallback = proven(await recorded(p.collateralTxid)); // per-transaction proof, no anchor
    expect(fallback.proof.anchor).toBeNull();
    const test = verifyCollateral(p, fallback, 'testnet');
    for (const id of ['block', 'confirmations', 'chainlock', 'height']) {
      expect(stepOf(test, id).basis, id).toBe('reported');
      expect(stepOf(test, id).more, id).toContain('not secure');
    }
    expect(test.chain!.weak).toContain('testnet');
    const status = collateralStatus(test.chain!);
    expect(status.prov.kind).toBe('reported');
    expect(status.prov.detail).toContain('not secure');
    expect(collateralHeightProv(test.chain!, test.chain!.height, { kind: 'fixture', source: 'x' }).kind).toBe('reported');
    // D-010: the same proof on mainnet is no better (its masternode list is only node-agreed): reported there too
    const main = verifyCollateral(p, fallback, 'mainnet');
    for (const id of ['block', 'confirmations', 'chainlock', 'height']) expect(stepOf(main, id).basis, id).toBe('reported');
    expect(main.chain!.weak).toBeUndefined();
    expect(collateralStatus(main.chain!).prov.kind).toBe('reported');
    expect(collateralHeightProv(main.chain!, main.chain!.height, { kind: 'fixture', source: 'x' }).kind).toBe('reported');
  });

  it('lookupCollateral keeps the helper\'s proof, and falls back to the node\'s claim (saying why) when the proof fails', async () => {
    const tx = await recorded(byName('OrchardPay').collateralTxid);
    const claims = { raw: tx.raw, blockHash: '', height: tx.height, confirmations: tx.confirmations, isChainLocked: true, isInstantLocked: false };
    const good: VerifiedTransaction = { ...(proven(tx) as TxLookup), txid: 'x'.repeat(64), tx: {} as VerifiedTransaction['tx'], blockHash: 'cc'.repeat(32) };
    const dapi = (verified: () => Promise<VerifiedTransaction>) =>
      ({
        getVerifiedTransaction: vi.fn(verified),
        call: vi.fn(async (fn: (core: unknown) => Promise<unknown>) => ({ value: await fn({ getTransaction: async () => claims }), node: 'n:443' })),
        pool: { pick: () => [] },
      }) as unknown as Dapi;
    const ok = await lookupCollateral(dapi(async () => good), 'ab'.repeat(32), { verify: true });
    expect(ok.chainLocked).toBe('verified');
    expect(ok.proof.merkle).toBe(true);
    const progress: string[] = [];
    const fell = await lookupCollateral(dapi(() => Promise.reject(new Error('merkle root does not match'))), 'ab'.repeat(32), { verify: true, onProgress: (m) => progress.push(m) });
    expect(fell.chainLocked).toBe('claimed');
    expect(fell.proof).toMatchObject({ merkle: false, chainLock: null });
    expect(fell.proof.notes[0]).toContain('merkle root does not match');
    expect(verifyCollateral(byName('OrchardPay'), fell, 'mainnet').steps.find((s) => s.id === 'chainlock')!.more).toContain('merkle root does not match');
    // a node that contradicted itself is a lie, not a flaky node: the lookup fails instead of asking the next node for its claim
    const lie = new AllNodesFailedError([{ node: 'a:443', error: new VerificationError('merkle', 'transaction is not in the claimed block') }]);
    await expect(lookupCollateral(dapi(() => Promise.reject(lie)), 'ab'.repeat(32), { verify: true })).rejects.toBe(lie);
    // an aborted lookup is not downgraded to a claim
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(lookupCollateral(dapi(() => Promise.reject(abort)), 'ab'.repeat(32), { verify: true })).rejects.toBe(abort);
  });
});

describe('vote verification against the fixture bridge (synthetic voters)', () => {
  const bridge = new FixtureBridge();
  let votes: BridgeVote[];
  let mns: BridgeMasternode[];
  let p: Proposal;
  let tally: Tally;
  beforeAll(async () => {
    p = byName('dash-intents'); // 95 yes, 64 no, 23 abstain; no recorded votes, so synthetic voters
    tally = snap.tallies.get(p.govHash)!;
    votes = (await bridge.votes(p.govHash, { height: tally.asOfHeight })).votes;
    mns = (await bridge.mnlist(tally.asOfHeight)).masternodes;
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
    expect(voteVerdict([run(r, tally.asOfHeight)]).level).toBe('keys-reported');
  });

  /** ProRegTx facts matching the list (what the worker proves per voter). */
  const proRegOf = (list: typeof mns) => new Map(list.map((m) => [m.proTxHash.toLowerCase(), { type: m.type === 'evo' ? 1 : 0, collateral: { txid: m.collateralTxid, index: m.collateralIndex } }]));

  it('is verified only with keys confirmed by the proven SML and collateral and type proven by the ProRegTxs', () => {
    const sml = new Map(mns.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: true, nType: 0, typeProven: true }]));
    expect(check({ sml }).keysFrom).toBe('bridge'); // keys alone: the outpoint -> masternode mapping is still the bridge's
    const r = check({ sml, proReg: proRegOf(mns) });
    expect(r.keysFrom).toBe('sml');
    expect(r.collateralProven).toBe(r.verified);
    expect(voteVerdict([run(r, tally.asOfHeight)]).level).toBe('verified');
    const prov = tallyProvenance({ name: PLATFORM_TARGET, prov: { kind: 'proof', source: 'Platform' }, tally }, [run(r, tally.asOfHeight)]);
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
    expect(voteVerdict([run(r, tally.asOfHeight)]).level).toBe('mismatch');
    expect(tallyProvenance({ name: PLATFORM_TARGET, prov: { kind: 'proof', source: 'Platform' }, tally }, [run(r, tally.asOfHeight)]).kind).toBe('mismatch');
  });

  it('a recount of a newer vote set than the tally is "different height", not a mismatch', () => {
    const r = check({ votes: votes.slice(0, -5) });
    expect(voteVerdict([run(r, tally.asOfHeight + 12)]).level).toBe('different-height');
    const prov = tallyProvenance({ name: PLATFORM_TARGET, prov: { kind: 'proof', source: 'Platform' }, tally }, [run(r, tally.asOfHeight + 12)]);
    expect(prov.kind).toBe('proof');
    expect(prov.detail).toContain('votes are as of block');
  });

  it('compares with every published tally and labels only the one that matched', () => {
    const live = { ...tally, asOfHeight: tally.asOfHeight + 3, yesWeighted: tally.yesWeighted + 1 };
    const r = check({ targets: [{ name: PLATFORM_TARGET, tally }, { name: BRIDGE_TARGET, tally: live }] });
    expect(r.targets.map((t) => t.matches)).toEqual([true, false]);
    const runs = [run(r, tally.asOfHeight)];
    expect(voteVerdict(runs).matched?.name).toBe(PLATFORM_TARGET);
    // The bridge tally (shown, because it is newer) must not inherit the Platform match.
    const bridgeProv = tallyProvenance({ name: BRIDGE_TARGET, prov: { kind: 'reported', source: 'bridge' }, tally: live }, runs);
    expect(bridgeProv.kind).toBe('reported');
  });

  it('a tally contradicted by the recount of its own height is a mismatch even when another tally matched', () => {
    const ok = check();
    const forged = check({ votes: votes.map((v, i) => (i === 3 ? { ...v, sig: votes[4]!.sig } : v)), targets: [{ name: BRIDGE_TARGET, tally: { ...tally, asOfHeight: tally.asOfHeight + 3 } }] });
    const verdict = voteVerdict([run(ok, tally.asOfHeight), run(forged, tally.asOfHeight + 3)]);
    expect(verdict.level).toBe('mismatch');
  });

  it('a recount is only credited to the tally it was made for', () => {
    const r = check();
    const newer = { ...tally, asOfHeight: tally.asOfHeight + 5 };
    const prov = tallyProvenance({ name: PLATFORM_TARGET, prov: { kind: 'proof', source: 'Platform' }, tally: newer }, [run(r, tally.asOfHeight)]);
    expect(prov.kind).toBe('proof');
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
    // a vote dropped this way never counts as a proven recount, even with every remaining key proven
    const sml = new Map(dupProTx.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: true, nType: 0, typeProven: true }]));
    const reg = new Map(dupProTx.map((m) => [m.proTxHash.toLowerCase(), { type: m.type === 'evo' ? 1 : 0, collateral: { txid: m.collateralTxid, index: m.collateralIndex } }]));
    expect(check({ masternodes: dupProTx, sml, proReg: reg }).keysFrom).toBe('bridge');
  });

  it('votes on other signals are skipped, not counted as problems', () => {
    const r = check({ votes: [...votes, { ...votes[0]!, signal: 2 }] });
    expect(r.otherSignal).toBe(1);
    expect(r.targets[0]!.matches).toBe(true);
  });

  it('SML cross-check flags a voting address the DAPI list disagrees with', () => {
    const sml = new Map(mns.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: true, nType: 0, typeProven: true }]));
    sml.set(mns[1]!.proTxHash, { votingAddress: mns[2]!.votingAddress, isValid: true, nType: 0, typeProven: true });
    const r = check({ sml, targets: [] });
    expect(r.problems['sml-mismatch']).toBe(1);
    expect(r.smlChecked).toBe(votes.length);
    expect(voteVerdict([run(r, 0)]).level).toBe('no-tally');
  });

  it('a masternode the (current) DAPI list no longer has keeps its vote in the recount but blocks "verified"', () => {
    // The SML is today's list, the tally is older: a masternode that left or re-keyed since must not turn an honest tally into a mismatch.
    const sml = new Map(mns.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: true, nType: 0, typeProven: true }]));
    sml.delete(mns[1]!.proTxHash);
    const r = check({ sml });
    expect(r.smlUnconfirmed).toBe(1);
    expect(r.verified).toBe(votes.length);
    expect(r.targets[0]!.matches).toBe(true);
    expect(r.keysFrom).toBe('bridge');
    expect(voteVerdict([run(r, tally.asOfHeight)]).level).toBe('keys-reported');
  });

  it('a bridge that maps an outpoint to another masternode, or misstates a type, is caught by the ProRegTx', () => {
    const sml = new Map(mns.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: true, nType: 0, typeProven: false }]));
    const reg = proRegOf(mns);
    reg.set(mns[1]!.proTxHash.toLowerCase(), { type: 0, collateral: { txid: 'ab'.repeat(32), index: 0 } });
    const r = check({ sml, proReg: reg });
    expect(r.smlUnconfirmed).toBe(1);
    expect(r.keysFrom).toBe('bridge');
    const typed = proRegOf(mns);
    typed.set(mns[2]!.proTxHash.toLowerCase(), { ...typed.get(mns[2]!.proTxHash.toLowerCase())!, type: 1 });
    expect(check({ sml, proReg: typed }).smlUnconfirmed).toBe(1);
    // a version-1 entry's type is not in the list's hash: without a ProRegTx it cannot count as proven
    expect(check({ sml }).smlUnconfirmed).toBe(r.verified);
  });
});

describe('recount of recorded mainnet votes (services/bridge/test/fixtures: real signed votes, real masternodes)', () => {
  const bridge = new FixtureBridge();

  it('reproduces the recorded tally and its voteSetHash for all three proposals, with evonode weights', async () => {
    const recordedHashes = [...snap.recorded.proposals.keys()];
    expect(recordedHashes).toHaveLength(3);
    for (const hash of recordedHashes) {
      const tally = snap.tallies.get(hash)!;
      const set = await bridge.votes(hash, { height: tally.asOfHeight });
      expect(set.origin).toBe('recorded');
      expect(set.asOfHeight).toBe(tally.asOfHeight);
      const list = await bridge.mnlist(set.tallyHeight);
      expect(list.listHash).toBe(set.mnListHash);
      const r = verifyVotes({ govHash: hash, votes: set.votes, masternodes: list.masternodes, network: 'mainnet', now: snap.now, targets: [{ name: PLATFORM_TARGET, tally }] });
      // every real signature recovers to the masternode's voting key
      expect(r.verified, hash).toBe(set.votes.length);
      expect(Object.values(r.problems).every((n) => n === 0)).toBe(true);
      expect(r.targets[0]!.compare.filter((c) => !c.ok), hash).toEqual([]);
      expect(r.voteSetHash).toBe(tally.voteSetHash);
      expect(r.weighted).toEqual({ yes: tally.yesWeighted, no: tally.noWeighted, abstain: tally.abstainWeighted });
      expect(voteVerdict([run(r, set.asOfHeight)]).level).toBe('keys-reported');
    }
    // dash-growth-q4-2026: 298 yes-MNs weigh 673 because evonodes count 4
    const growth = snap.tallies.get(byName('dash-growth-q4-2026').govHash)!;
    expect([growth.yesWeighted, growth.yesCount]).toEqual([673, 298]);
  });

  it('a tampered recorded vote breaks its signature and the recount', async () => {
    const hash = byName('DASH-MULTILINGUAL-EXPANSION_Q4').govHash;
    const tally = snap.tallies.get(hash)!;
    const set = await bridge.votes(hash, { height: tally.asOfHeight });
    const list = await bridge.mnlist(set.tallyHeight);
    const flipped = set.votes.map((v, i) => (i === 0 ? { ...v, outcome: v.outcome === 1 ? 2 : 1 } : v));
    const r = verifyVotes({ govHash: hash, votes: flipped, masternodes: list.masternodes, network: 'mainnet', now: snap.now, targets: [{ name: PLATFORM_TARGET, tally }] });
    expect(r.problems['bad-signature']).toBe(1);
    expect(r.targets[0]!.matches).toBe(false);
    expect(voteVerdict([run(r, set.asOfHeight)]).level).toBe('mismatch');
  });

  it('a masternode that is PoSe-banned in the list keeps its vote in the recount (only the threshold ignores bans)', async () => {
    const hash = byName('dash-growth-q4-2026').govHash;
    const tally = snap.tallies.get(hash)!;
    const set = await bridge.votes(hash, { height: tally.asOfHeight });
    const list = await bridge.mnlist(set.tallyHeight);
    const banned = list.masternodes.map((m) => ({ ...m, valid: false }));
    const r = verifyVotes({ govHash: hash, votes: set.votes, masternodes: banned, network: 'mainnet', now: snap.now, targets: [{ name: PLATFORM_TARGET, tally }] });
    expect(r.targets[0]!.matches).toBe(true);
  });

  it('serves the set at the tally\'s height or above, and refuses a height below the recording (like the real API)', async () => {
    const hash = byName('dash-growth-q4-2026').govHash;
    const tally = snap.tallies.get(hash)!;
    expect((await bridge.votes(hash, { height: tally.asOfHeight + 50 })).tallyHeight).toBe(tally.asOfHeight);
    await expect(bridge.votes(hash, { height: tally.asOfHeight - 1 })).rejects.toBeInstanceOf(BridgeError);
  });
});

describe('collateral second-node cross-check', () => {
  it('a disagreeing second node fails the verdict; a missing one only warns', async () => {
    const p = byName('OrchardPay');
    const tx = await recorded(p.collateralTxid);
    expect(verifyCollateral(p, { ...tx, second: { node: 'b:443', height: tx.height, sameBytes: true } }, 'mainnet').ok).toBe(true);
    expect(verifyCollateral(p, { ...tx, second: null }, 'mainnet').steps.find((s) => s.id === 'crosscheck')!.status).toBe('warn');
    const bad = verifyCollateral(p, { ...tx, second: { node: 'b:443', height: tx.height + 1, sameBytes: true } }, 'mainnet');
    expect(bad.ok).toBe(false);
    expect(bad.steps.find((s) => s.id === 'crosscheck')!.status).toBe('fail');
  });
});

describe('TxLookup is what @govhub/dapi returns', () => {
  it('has the fields the verdict reads', async () => {
    const t = await recorded(byName('OrchardPay').collateralTxid);
    expect(t.node).toBe(RECORDED_NODE);
    expect(t.chainLocked).toBe('claimed');
    expect(t.instantLocked).toMatch(/^(claimed|no)$/);
    expect(t.proof.merkle).toBe(false);
    expect(t.confirmations).toBeGreaterThan(6);
  });
});
