// Records a coherent, read-only snapshot for the offline quorum-proof anchoring tests: the full SML at the tip S, a DIP 175 proof from
// the pinned quorum checkpoint to a ChainLock at T >= S, and the headers from below the ChainLock quorums' base blocks up to T.
// Needs network.
//   node --experimental-strip-types scripts/record-proof-fixtures.mjs testnet [proof URL]
// The proof URL is a bridge base (https://gov-bridge-testnet.dashhq.org, GET /v1/quorum-proof) or a quorum list server /proofs URL
// (default for testnet: https://quorums.testnet.networks.dash.org/proofs).
// Writes test/fixtures/proof-anchor-<network>.json.gz.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { CHAINLOCK_PARAMS, DapiCore, QUORUM_CHECKPOINTS, SIGN_HEIGHT_OFFSET, bridgeProofSource, createDapi, decodeCbor, hex, parseSmlDecoded, quorumListProofSource } from '../src/index.ts';
import { fetchHeaders } from '../src/anchor.ts';
import { verifyQuorumProof } from '../src/coreproof.ts';
import { x11Many } from '../src/x11.ts';

const network = process.argv[2] ?? 'testnet';
const url = process.argv[3] ?? (network === 'testnet' ? 'https://quorums.testnet.networks.dash.org/proofs' : null);
if (!url) throw new Error('give a proof URL for mainnet');
const source = url.endsWith('/proofs') ? quorumListProofSource(url) : bridgeProofSource(url);
const dapi = createDapi({ network });
const nodes = await dapi.ready();
const node = nodes[0];
const core = new DapiCore(node);

const smlRaw = await new Promise((resolve, reject) => {
  const h = core.subscribeToMasternodeList((b) => { h.cancel(); resolve(b); });
  h.closed.then((r) => r.reason === 'error' && reject(r.error));
});
const sml = parseSmlDecoded(decodeCbor(smlRaw));
console.log(network, 'node', node, 'sml height', sml.height);
const platform = sml.quorums.filter((q) => q.llmqType === (network === 'mainnet' ? 4 : 6)).map((q) => q.quorumHash).sort();
const root = QUORUM_CHECKPOINTS[network];
let bytes;
for (let i = 0; ; i++) {
  try {
    bytes = await source.fetch({ checkpoint: root.blockHash, height: sml.height, platformQuorum: async () => ({ quorumHash: platform[platform.length >> 1], llmqType: network === 'mainnet' ? 4 : 6 }) });
    break;
  } catch (e) {
    if (i >= 6) throw e;
    console.log('waiting for a ChainLock at', sml.height, e.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
const proof = verifyQuorumProof(bytes, root, sml.height);
const T = proof.state.height;
const p = CHAINLOCK_PARAMS[network];
const from = Math.min(sml.height, T - (p.activeCount * p.dkgInterval + p.miningWindowEnd + SIGN_HEIGHT_OFFSET)) - 10;
const run = await fetchHeaders(dapi, from, T, x11Many);
const out = {
  network, recordedAt: new Date().toISOString(), now: Math.floor(Date.now() / 1000), node, proofSource: source.name,
  from, headersB64: Buffer.from(run.headers).toString('base64'), smlB64: Buffer.from(smlRaw).toString('base64'),
  checkpoint: root, proofHex: hex(bytes), target: proof.state, links: proof.links,
};
writeFileSync(new URL(`../test/fixtures/proof-anchor-${network}.json.gz`, import.meta.url), gzipSync(JSON.stringify(out), { level: 9 }));
console.log('headers', from, T, 'proof', bytes.length, 'bytes', proof.links, 'links', 'target', T, proof.state.blockHash);
process.exit(0);
