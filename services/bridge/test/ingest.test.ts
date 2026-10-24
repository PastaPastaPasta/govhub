// Ingest timing rules (votes judged only against a list read after they arrived; re-checks after list changes) and
// superblock bookkeeping (only a trigger fully contained in the coinbase is recorded).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@govhub/verify';
import { openArchive } from '../src/archive/db.ts';
import { parseGovernanceDat } from '../src/core/govdat.ts';
import { parseRawVote } from '../src/core/govparse.ts';
import type { CoreRpc } from '../src/core/rpc.ts';
import { Ingestor } from '../src/ingest.ts';
import { finishList, storeMnList } from '../src/mnlist.ts';
import { triggerView } from '../src/proposal.ts';
import { FIXTURES, fixtureEntries, votesFixture } from './helpers.ts';

const f = votesFixture();
const vote = parseRawVote(hexToBytes(f.proposals[0]!.votes[0]!.rawHex));
const now = Math.floor(Date.now() / 1000);

describe('vote verification timing', () => {
  it('a vote stays pending until an MN list read after its arrival exists', () => {
    const db = openArchive(':memory:');
    storeMnList(db, finishList(fixtureEntries(f)), 100, '00'.repeat(32)); // taken "now"
    const ing = new Ingestor(db, {} as CoreRpc, 'mainnet');
    ing.archiveVote(vote, 'zmq', 100, now + 3600); // arrived after the only snapshot
    expect(ing.verifyPendingVotes()).toBe(0);
    expect((db.prepare('SELECT sig_status s FROM votes').get() as { s: string }).s).toBe('pending');
  });

  it('a vote judged against a list with an old voting key becomes valid after the list changes', () => {
    const db = openArchive(':memory:');
    const entries = fixtureEntries(f);
    const mine = `${vote.outpoint.txid}-${vote.outpoint.n}`;
    const oldKey = entries.map((e) => (`${e.collateralTxid}-${e.collateralN}` === mine ? { ...e, votingKeyId: '11'.repeat(20), votingAddress: 'old' } : e));
    storeMnList(db, finishList(oldKey), 100, '00'.repeat(32));
    const ing = new Ingestor(db, {} as CoreRpc, 'mainnet');
    ing.archiveVote(vote, 'zmq', 100, 1);
    ing.verifyPendingVotes();
    expect((db.prepare('SELECT sig_status s FROM votes').get() as { s: string }).s).toBe('invalid');
    storeMnList(db, finishList(entries), 101, '01'.repeat(32));
    expect(ing.recheckAfterListChange()).toBe(1);
    ing.verifyPendingVotes();
    expect((db.prepare('SELECT sig_status s, checked_height h FROM votes').get() as { s: string; h: number })).toEqual({ s: 'valid', h: 101 });
  });

  it('a second copy with a valid signature replaces a stored copy whose signature failed (old copy kept in events)', () => {
    const db = openArchive(':memory:');
    storeMnList(db, finishList(fixtureEntries(f)), 100, '00'.repeat(32));
    const ing = new Ingestor(db, {} as CoreRpc, 'mainnet');
    const sig = Uint8Array.from(vote.sig);
    sig[20] = sig[20]! ^ 1;
    ing.archiveVote({ ...vote, sig, raw: vote.raw }, 'govdat', 100, 1);
    ing.verifyPendingVotes();
    expect((db.prepare('SELECT sig_status s FROM votes').get() as { s: string }).s).toBe('invalid');
    expect(ing.archiveVote(vote, 'zmq', 100, 2)).toBe(false);
    ing.verifyPendingVotes();
    expect((db.prepare('SELECT sig_status s, source FROM votes').get() as { s: string; source: string })).toEqual({ s: 'valid', source: 'zmq' });
    expect((db.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'vote-copy-replaced'").get() as { n: number }).n).toBe(1);
  });
});

describe('superblock bookkeeping', () => {
  const g = parseGovernanceDat(readFileSync(join(FIXTURES, 'governance-trimmed.dat')));
  const trig = g.objects[0]!.object;
  const tv = triggerView(trig.dataHex)!;
  const rpcWith = (vout: Array<{ address: string; valueSat: number }>) =>
    ({
      getBlockHash: async () => 'cc'.repeat(32),
      getBlock: async () => ({ time: 1792000000, tx: [{ vout: vout.map((o) => ({ valueSat: o.valueSat, scriptPubKey: { address: o.address } })) }] }),
      getSuperblockBudget: async () => 6828.2637816,
    }) as unknown as CoreRpc;

  function ingestor(rpc: CoreRpc) {
    const db = openArchive(':memory:');
    const ing = new Ingestor(db, rpc, 'mainnet');
    ing.height = tv.eventBlockHeight + 10;
    ing.archiveObject(trig, 'govdat', 1);
    return { db, ing };
  }

  it('records what the coinbase paid when it contains every trigger payment', async () => {
    const miner = { address: 'XminerXXXXXXXXXXXXXXXXXXXXXXXXXXXX', valueSat: 1 };
    const { db, ing } = ingestor(rpcWith([miner, ...tv.payments.map((p) => ({ address: p.address, valueSat: p.amountDuffs }))]));
    await ing.recordSuperblock(tv.eventBlockHeight);
    const row = db.prepare('SELECT * FROM superblocks').get() as any;
    expect(row.paid_duffs).toBe(tv.payments.reduce((a, p) => a + p.amountDuffs, 0));
    expect(row.trigger_hash).toBe(trig.hash);
    expect(row.budget_duffs).toBe(682826378160);
  });

  it('records nothing when no archived trigger is fully in the coinbase (the winner is not archived)', async () => {
    const { db, ing } = ingestor(rpcWith(tv.payments.slice(1).map((p) => ({ address: p.address, valueSat: p.amountDuffs }))));
    await ing.recordSuperblock(tv.eventBlockHeight);
    expect(db.prepare('SELECT COUNT(*) n FROM superblocks').get()).toEqual({ n: 0 });
  });
});
