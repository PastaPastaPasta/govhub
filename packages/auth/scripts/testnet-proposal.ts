// TESTNET tooling for the phase-3 live vote test: a cheap test proposal (1 tDASH collateral from the EvoVote QA wallet).
//
//   npx vite-node scripts/testnet-proposal.ts collateral        builds the proposal data, pays the collateral, saves the params
//   npx vite-node scripts/testnet-proposal.ts status            confirmations of the collateral (DAPI)
//
// Submission (`gobject submit`, after 6 confirmations) goes through the relay's POST /v1/proposals/submit, or dash-cli by hand.
// Public data only; the params file is scripts/results/testnet-proposal.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDapi } from '@govhub/dapi';
import { buildProposalDataHex, governanceObjectHash, validateProposalData } from '@govhub/verify';
import { qaFunder } from './qa-funder.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, 'results/testnet-proposal.json');
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const cmd = process.argv[2] ?? 'status';
const dapi = createDapi({ network: 'testnet' });

if (cmd === 'collateral') {
  if (existsSync(FILE) && JSON.parse(readFileSync(FILE, 'utf8')).collateralTxid) throw new Error('a test proposal exists already; delete the results file to make another');
  const funder = qaFunder(dapi);
  const now = Math.floor(Date.now() / 1000);
  const fields = {
    type: 1,
    name: `govhub-mn-voting-test-${new Date().toISOString().slice(0, 10)}`,
    paymentAddress: funder.address,
    paymentAmount: 1,
    startEpoch: now,
    endEpoch: now + 30 * 86400,
    url: 'https://github.com/PastaPastaPasta/govhub',
  };
  const dataHex = buildProposalDataHex(fields);
  const v = validateProposalData(dataHex, 'testnet', { now });
  if (!v.valid) throw new Error(`proposal data invalid: ${JSON.stringify(v)}`);
  const time = now;
  const hash = governanceObjectHash({ parentHash: '0', revision: 1, time, dataHex });
  const txid = await funder.payCollateral(hash.raw);
  const out = { network: 'testnet', fields, dataHex, parentHash: '0', revision: 1, time, govHash: hash.display, collateralTxid: txid, paidAt: new Date().toISOString() };
  writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n');
  log(`collateral ${txid} for proposal ${hash.display}`);
  log(`submit after 6 confirmations: gobject submit 0 1 ${time} <dataHex> ${txid}`);
} else {
  const p = JSON.parse(readFileSync(FILE, 'utf8'));
  const { value } = await dapi.call((core, s) => core.getTransaction(p.collateralTxid, { signal: s }));
  log(`collateral ${p.collateralTxid}: height ${value.height}, confirmations ${value.confirmations}, chainlocked ${value.isChainLocked}`);
}
process.exit(0);
