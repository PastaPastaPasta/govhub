// Typed access to test/fixtures/recorded.json (recorded from live mainnet by scripts/record-fixtures.mjs).
import { readFileSync } from 'node:fs';
import { unhex } from '../src/bytes.ts';
import { parseBlock, parseChainLock, parseTx } from '../src/dash.ts';
import { parseSml } from '../src/sml.ts';

interface Recorded {
  tx: {
    txid: string; height: number; blockHash: string;
    claims: { rawHex: string; confirmations: number; isInstantLocked: boolean; isChainLocked: boolean };
    blockHex: string; headersHex: string[]; chainLockHex: string;
  };
  smlTrimmedCborHex: string;
  quorumBlocks: Record<string, string>;
  headerPairs: { height: number; headerHex: string; nextHeaderHex: string; hash: string }[];
  firehose: { txs: string[]; islocks: { hex: string; txid: string; rawTxHex: string }[] };
  merkleblock: { hex: string; hash160: string; tweak: number; txid: string; height: number };
}

const rec = JSON.parse(readFileSync(new URL('./fixtures/recorded.json', import.meta.url), 'utf8')) as Recorded;

export const fx = {
  rec,
  txid: rec.tx.txid,
  height: rec.tx.height,
  blockHash: rec.tx.blockHash,
  rawTx: unhex(rec.tx.claims.rawHex),
  block: unhex(rec.tx.blockHex),
  headers: rec.tx.headersHex.map(unhex),
  chainLockBytes: unhex(rec.tx.chainLockHex),
  chainLock: parseChainLock(unhex(rec.tx.chainLockHex)),
  smlBytes: unhex(rec.smlTrimmedCborHex),
  sml: parseSml(unhex(rec.smlTrimmedCborHex)),
  quorumBlocks: Object.fromEntries(Object.entries(rec.quorumBlocks).map(([k, v]) => [k, unhex(v)])),
  txParsed: parseTx(unhex(rec.tx.claims.rawHex)),
  blockParsed: parseBlock(unhex(rec.tx.blockHex)),
};

export const collateralRaw = unhex(readFileSync(new URL('./fixtures/collateral-tx.hex', import.meta.url), 'utf8').trim());
