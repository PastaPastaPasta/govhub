import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openArchive, type DB } from '../src/archive/db.ts';
import { finishList, mnWeight, storeMnList, type MnEntry } from '../src/mnlist.ts';
import { decodeAddress, bytesToHex } from '@govhub/verify';

export const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
export const fixture = <T = any>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

export interface VotesFixture {
  network: 'mainnet';
  mnList: {
    height: number;
    listHash: string;
    validWeighted: number;
    entries: Array<{ proTxHash: string; collateralTxid: string; collateralIndex: number; type: string; votingAddress: string; isValid: boolean; poseBanHeight: number; registeredHeight: number }>;
  };
  proposals: Array<{
    govHash: string;
    tally: {
      asOfHeight: number;
      yesWeighted: number;
      noWeighted: number;
      abstainWeighted: number;
      yesCount: number;
      noCount: number;
      abstainCount: number;
      core: { yes: number; no: number; abstain: number; absoluteYes: number };
      currentVotes: number;
      voteSetHash: string;
    };
    votes: Array<{ hash: string; rawHex: string; firstSeenHeight: number }>;
  }>;
  blsVote: { hash: string; rawHex: string } | null;
}

export interface ObjectsFixture {
  objects: Array<{ hash: string; type: number; rawHex: string; collateralTxid: string; collateralHeight: number; collateralRawTxHex: string }>;
}

export const votesFixture = () => fixture<VotesFixture>('mainnet-votes.json');
export const objectsFixture = () => fixture<ObjectsFixture>('mainnet-objects.json');

/** The fixture's MN subset as a stored list (its hash differs from the full list's; fine for tests). */
export function fixtureEntries(f: VotesFixture): MnEntry[] {
  return f.mnList.entries.map((e) => {
    const dec = decodeAddress(e.votingAddress, 'mainnet');
    return {
      proTxHash: e.proTxHash,
      collateralTxid: e.collateralTxid,
      collateralN: e.collateralIndex,
      type: e.type,
      weight: mnWeight(e.type),
      votingAddress: e.votingAddress,
      votingKeyId: dec ? bytesToHex(dec.hash160) : null,
      isValid: e.isValid,
      poseBanHeight: e.poseBanHeight,
      registeredHeight: e.registeredHeight,
    };
  });
}

export function archiveWithList(f: VotesFixture, height = f.mnList.height): { db: DB; listHash: string } {
  const db = openArchive(':memory:');
  const list = finishList(fixtureEntries(f));
  storeMnList(db, list, height, '00'.repeat(32));
  return { db, listHash: list.listHash };
}
