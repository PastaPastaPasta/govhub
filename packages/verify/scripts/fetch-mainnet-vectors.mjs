#!/usr/bin/env node
// Read-only: fetches every mainnet proposal Core currently knows (`gobject list all proposals`) plus its collateral tx
// from a public JSON-RPC endpoint and writes test/fixtures/mainnet-proposals.json.
//   RPC_URL=https://rpc.digitalcash.dev/ node scripts/fetch-mainnet-vectors.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.RPC_URL ?? 'https://rpc.digitalcash.dev/';
const outFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'mainnet-proposals.json');

async function rpc(method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 'x', method, params }), signal: AbortSignal.timeout(60000) });
  const t = await r.json();
  if (t.error) throw new Error(JSON.stringify(t.error));
  return t.result;
}

const list = await rpc('gobject', ['list', 'all', 'proposals']);
const out = [];
for (const [hash, e] of Object.entries(list)) {
  const item = { hash, collateralHash: e.CollateralHash, creationTime: e.CreationTime, dataHex: e.DataHex, dataString: e.DataString, objectType: e.ObjectType, yes: e.YesCount, no: e.NoCount, abstain: e.AbstainCount, absoluteYes: e.AbsoluteYesCount, fCachedValid: e.fCachedValid, isValidReason: e.IsValidReason };
  try {
    item.rawTx = await rpc('getrawtransaction', [e.CollateralHash]);
    const dec = await rpc('getrawtransaction', [e.CollateralHash, true]);
    item.confirmations = dec.confirmations;
    item.blockhash = dec.blockhash;
    item.chainlock = dec.chainlock;
  } catch (err) {
    item.rawTxError = String(err.message);
  }
  out.push(item);
}
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ source: url, fetchedAt: Math.floor(Date.now() / 1000), blockHeight: await rpc('getblockcount', []), proposals: out }, null, 2) + '\n');
console.log(`wrote ${out.length} proposals (${out.filter((o) => o.rawTx).length} with raw collateral tx) to ${outFile}`);
