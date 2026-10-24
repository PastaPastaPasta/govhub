// Signs one testnet funding vote with a testnet.yml masternode voting key and prints ONLY the public voteraw arguments
// (the signature is public once broadcast). For the first manual `voteraw` check of the binary vote-hash scheme.
//   npx vite-node scripts/sign-test-vote.ts <masternode-N> <collateralTxid> <index> <govHash> <yes|no|abstain>
import { decodeWif, voteRawParams } from '@govhub/verify';
import { signPlanned, voteFields } from '../src/voting/plan.ts';
import { votingAddressOf } from '../src/voting/masternodes.ts';
import { testnetMnKeys } from './testnet-mn-keys.ts';

const [name, txid, index, gov, outcome] = process.argv.slice(2);
const k = testnetMnKeys().find((x) => x.name === name);
if (!k) throw new Error(`no key for ${name}`);
const { privKey, compressed } = decodeWif(k.wif, 'testnet');
if (votingAddressOf(privKey, compressed, 'testnet') !== k.address) throw new Error('key/address mismatch');
const o = ({ yes: 1, no: 2, abstain: 3 } as const)[outcome as 'yes' | 'no' | 'abstain'];
const time = Math.floor(Date.now() / 1000);
const p = { mn: { proTxHash: '', collateralTxid: txid!, collateralIndex: Number(index) }, govHash: gov!, outcome: o, time, releaseAt: time, notes: [] };
const s = signPlanned(p, privKey, compressed, 'testnet');
privKey.fill(0);
console.log(JSON.stringify({ args: voteRawParams(voteFields(p), s.sig), voteHash: s.voteHash }));
