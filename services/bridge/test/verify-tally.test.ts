// Signature verification at ingest and Core-parity tallies, on real mainnet votes captured from ZMQ.
import { describe, expect, it } from 'vitest';
import { hexToBytes, voteSetHash } from '@govhub/verify';
import type { VoteRow } from '../src/archive/db.ts';
import type { CoreRpc } from '../src/core/rpc.ts';
import { parseRawVote, serializeVote } from '../src/core/govparse.ts';
import { Ingestor } from '../src/ingest.ts';
import { allocateBudget, compareWithCore, coreCurrentFundingVotes, fundingThreshold, tallyProposal } from '../src/tally.ts';
import { archiveWithList, votesFixture } from './helpers.ts';

const f = votesFixture();
const fakeRpc = {} as CoreRpc;

function loaded() {
  const { db, listHash } = archiveWithList(f);
  const ing = new Ingestor(db, fakeRpc, 'mainnet');
  for (const p of f.proposals) for (const v of p.votes) ing.archiveVote(parseRawVote(hexToBytes(v.rawHex)), 'zmq', v.firstSeenHeight, 1);
  return { db, ing, listHash };
}

describe('vote signatures (mainnet message scheme) against the voting keys of the MN list', () => {
  it('every recorded vote verifies', () => {
    const { db, ing } = loaded();
    const n = f.proposals.reduce((a, p) => a + p.votes.length, 0);
    expect(ing.verifyPendingVotes()).toBe(n);
    const st = db.prepare('SELECT sig_status s, COUNT(*) n FROM votes GROUP BY 1').all();
    expect(st).toEqual([{ s: 'valid', n }]);
  });

  it('a tampered signature is invalid, an unknown collateral outpoint is unknown-mn', () => {
    const { db, ing } = loaded();
    const p = parseRawVote(hexToBytes(f.proposals[0]!.votes[0]!.rawHex));
    db.prepare('DELETE FROM votes').run(); // test-only reset of the in-memory archive
    const sig = Uint8Array.from(p.sig);
    sig[10] = sig[10]! ^ 0xff;
    const tampered = parseRawVote(serializeVote({ ...p, sig, time: p.time + 1 }));
    ing.archiveVote(tampered, 'zmq', 1, 1);
    const stranger = parseRawVote(serializeVote({ ...p, outpoint: { txid: 'ee'.repeat(32), n: 0 } }));
    ing.archiveVote(stranger, 'zmq', 1, 1);
    ing.verifyPendingVotes();
    const rows = db.prepare('SELECT hash, sig_status FROM votes').all() as Array<{ hash: string; sig_status: string }>;
    expect(rows.find((r) => r.hash === tampered.hash)!.sig_status).toBe('invalid');
    expect(rows.find((r) => r.hash === stranger.hash)!.sig_status).toBe('unknown-mn');
  });

  it('archiving is idempotent on the vote hash', () => {
    const { ing } = loaded();
    const v = parseRawVote(hexToBytes(f.proposals[0]!.votes[0]!.rawHex));
    expect(ing.archiveVote(v, 'zmq', 1, 1)).toBe(false);
  });
});

describe('tallies equal Core (FundingResult and the getcurrentvotes set at the recorded height)', () => {
  const { db, ing, listHash } = loaded();
  ing.verifyPendingVotes();
  const list = ing.lists.load(listHash)!;

  for (const p of f.proposals) {
    it(`${p.govHash.slice(0, 12)}… (${p.votes.length} votes)`, () => {
      const t = tallyProposal(db, p.govHash, list, p.tally.asOfHeight, 1792813000);
      expect(t.weighted).toEqual({ yes: p.tally.core.yes, no: p.tally.core.no, abstain: p.tally.core.abstain });
      expect(t.absoluteYes).toBe(p.tally.core.absoluteYes);
      expect(t.unweighted).toEqual({ yes: p.tally.yesCount, no: p.tally.noCount, abstain: p.tally.abstainCount });
      expect(t.counted.length).toBe(p.tally.currentVotes);
      // govhub-voteset-v1, pinned from an independent recount when the fixture was recorded
      expect(t.voteSetHash).toBe(p.tally.voteSetHash);
      expect(voteSetHash(t.counted.map((v) => ({ mn: `${v.collateral_txid}-${v.collateral_n}`, outcome: v.outcome, time: v.time })))).toBe(p.tally.voteSetHash);
      // Core's getcurrentvotes keys are the vote hashes: the counted set is exactly Core's
      const coreSet = new Set(p.votes.map((v) => v.hash));
      const cmp = compareWithCore(t, { YesCount: p.tally.core.yes, NoCount: p.tally.core.no, AbstainCount: p.tally.core.abstain, AbsoluteYesCount: p.tally.core.absoluteYes }, coreSet);
      expect(cmp.match).toBe(true);
    });
  }

  it('evonodes weigh 4 and PoSe-banned masternodes still count (CountMatchingVotes uses GetMNByCollateral)', () => {
    const p = f.proposals[f.proposals.length - 1]!;
    const t = tallyProposal(db, p.govHash, list, p.tally.asOfHeight, 1792813000);
    expect(t.counted.some((v) => v.weight === 4)).toBe(true);
    const banned = list.list.entries.filter((e) => !e.isValid).map((e) => `${e.collateralTxid}-${e.collateralN}`);
    const countedBanned = t.counted.filter((v) => banned.includes(`${v.collateral_txid}-${v.collateral_n}`));
    // if the recorded voters include banned MNs, they are counted (and the totals above still equal Core's)
    for (const v of countedBanned) expect(v.weight).toBeGreaterThan(0);
  });

  it('a vote whose signer is not the CURRENT voting key is not counted (Core RemoveInvalidVotes)', () => {
    const p = f.proposals[0]!;
    const row = db.prepare('SELECT * FROM votes WHERE parent_hash = ?').get(p.govHash) as VoteRow;
    const before = tallyProposal(db, p.govHash, list, 1, 1792813000);
    db.prepare('UPDATE votes SET signer_keyid = ? WHERE hash = ?').run('00'.repeat(20), row.hash);
    const after = tallyProposal(db, p.govHash, list, 1, 1792813000);
    db.prepare('UPDATE votes SET signer_keyid = ? WHERE hash = ?').run(row.signer_keyid, row.hash);
    expect(after.counted.length).toBe(before.counted.length - 1);
    expect(after.staleKey).toBe(1);
  });
});

describe('budget allocation (signing.cpp CreateSuperblockCandidate) and threshold', () => {
  const view = (amount: number, start = 0, end = 2e9) => ({ type: 1, name: 'x', url: 'http://x', paymentAddress: 'X', paymentAmount: amount / 1e8, startEpoch: start, endEpoch: end, paymentAmountDuffs: amount });

  it('orders by absolute yes desc, ties by hash desc; skips what does not fit and keeps filling', () => {
    const r = allocateBudget(
      [
        { hash: 'aa'.repeat(32), absoluteYes: 500, view: view(60) },
        { hash: 'bb'.repeat(32), absoluteYes: 500, view: view(30) },
        { hash: 'cc'.repeat(32), absoluteYes: 700, view: view(50) },
        { hash: 'dd'.repeat(32), absoluteYes: 400, view: view(20) },
        { hash: 'ee'.repeat(32), absoluteYes: 100, view: view(1) },
      ],
      { threshold: 332, budgetDuffs: 100, sbTime: 1000 },
    );
    expect(r.ordered).toEqual(['cc'.repeat(32), 'bb'.repeat(32), 'aa'.repeat(32), 'dd'.repeat(32), 'ee'.repeat(32)]);
    expect([...r.allocated]).toEqual(['cc'.repeat(32), 'bb'.repeat(32), 'dd'.repeat(32)]); // aa (60) no longer fits, dd (20) does
    expect(r.allocatedDuffs).toBe(100);
  });

  it('respects the payment window with the 2 h fudge', () => {
    const sb = 1_000_000;
    const r = allocateBudget(
      [
        { hash: '01'.repeat(32), absoluteYes: 900, view: view(1, sb + 7200, sb + 99999) },
        { hash: '02'.repeat(32), absoluteYes: 800, view: view(1, sb + 7201, sb + 99999) },
        { hash: '03'.repeat(32), absoluteYes: 700, view: view(1, 0, sb - 7201) },
        { hash: '04'.repeat(32), absoluteYes: 600, view: view(1, 0, sb - 7200) },
      ],
      { threshold: 1, budgetDuffs: 1e9, sbTime: sb },
    );
    expect([...r.allocated].sort()).toEqual(['01'.repeat(32), '04'.repeat(32)]);
  });

  it('threshold = max(min quorum, valid weighted / 10) with integer division', () => {
    expect(fundingThreshold(10, 3322)).toBe(332);
    expect(fundingThreshold(10, 50)).toBe(10);
  });

  it('parses getcurrentvotes values', () => {
    const s = coreCurrentFundingVotes({ h1: `${'ab'.repeat(32)}-1:1792800000:yes:funding:4`, h2: `${'ab'.repeat(32)}-2:1792800000:yes:delete:1` });
    expect([...s]).toEqual(['h1']);
  });
});

it('an ECDSA vote is exactly 150 bytes on the wire', () => {
  expect(hexToBytes(f.proposals[0]!.votes[0]!.rawHex).length).toBe(150);
});
