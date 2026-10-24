// The DIP 175 verifier (dash-core-proof compiled to WebAssembly) on real getquorumproofchain output, and on proofs tampered with.
// quorum-proof-<network>.json: recorded 2026-10-24 from the pinned checkpoints (testnet: the govhub dashd 24.0.0-rc.4 on CT 185;
// mainnet: the CT 164 relay's Core build), with a "delta" proof from the first proof's target and, for testnet, a bootstrap envelope
// that opens one Platform quorum.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hashHex, unhex } from '../src/bytes.ts';
import { verifyQuorumProof } from '../src/coreproof.ts';
import { type ProofState, QUORUM_CHECKPOINTS, QuorumProofError } from '../src/quorumproof.ts';
import { x11 } from '../src/x11.ts';

interface RpcState { network: number; height: number; block_hash: string; masternode_root: string; quorum_root: string }
interface Recorded { checkpoint: RpcState; proof_hex: string; target: RpcState; targetHeaderHex: string }
interface Fixture extends Recorded { delta: Recorded; bootstrap?: { bootstrap_hex: string; target: RpcState } }

const state = (s: RpcState): ProofState => ({
  network: s.network === 0 ? 'mainnet' : 'testnet', height: s.height, blockHash: s.block_hash, masternodeRoot: s.masternode_root, quorumRoot: s.quorum_root,
});
const load = (network: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/quorum-proof-${network}.json`, import.meta.url), 'utf8')) as Fixture;

/** Byte offsets of the parts of a DASHNC02 chain (the encoding in core-proof-wasm/vendor/dash-core-proof/src/chain.rs). */
function layout(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 8 + 101;
  const path = () => { const depth = b[o + 8]!; o += 9 + 32 * depth; };
  const seed = o + 4;
  o += 4 + dv.getUint32(o, true);
  path();
  const count = dv.getUint16(o, true);
  o += 2;
  const links: Array<{ cert: number; mining: number; ancestors: number; ancestorCount: number }> = [];
  for (let i = 0; i < count; i++) {
    const cert = o;
    o += 180;
    const mining = o + 4;
    o += 4 + dv.getUint32(o, true);
    path();
    const ancestorCount = dv.getUint16(o, true);
    links.push({ cert, mining, ancestors: o + 2, ancestorCount });
    o += 2 + 80 * ancestorCount;
  }
  return { seed, links, target: o };
}

const flip = (b: Uint8Array, at: number, mask = 1): Uint8Array => { const c = Uint8Array.from(b); c[at]! ^= mask; return c; };
const rejects = (proof: Uint8Array, trusted: ProofState, kind?: QuorumProofError['kind']) => {
  let err: unknown;
  try { verifyQuorumProof(proof, trusted); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(QuorumProofError);
  if (kind) expect((err as QuorumProofError).kind).toBe(kind);
  return (err as QuorumProofError).message;
};

describe.each(['testnet', 'mainnet'] as const)('%s real proofs', (network) => {
  const f = load(network);
  const proof = unhex(f.proof_hex), root = state(f.checkpoint);

  it('the recorded checkpoint is the pinned one', () => {
    expect(root).toEqual(QUORUM_CHECKPOINTS[network]);
  });

  it('verifies from the pin to the target Core reported, with the target block ChainLock', () => {
    const v = verifyQuorumProof(proof, root);
    expect(v.state).toEqual(state(f.target));
    expect(v.from).toEqual(root);
    expect(v.links).toBeGreaterThan(network === 'testnet' ? 20 : 5);
    expect(v.chainLock.height).toBe(f.target.height);
    expect(Buffer.from(v.chainLock.header).toString('hex')).toBe(f.targetHeaderHex);
    expect(hashHex(x11(v.chainLock.header))).toBe(f.target.block_hash);
    expect(v.chainLock.signature.length).toBe(96);
  });

  it('verifies the delta proof from the previous target (a saved state as the anchor)', () => {
    const v = verifyQuorumProof(unhex(f.delta.proof_hex), state(f.delta.checkpoint));
    expect(state(f.delta.checkpoint)).toEqual(state(f.target));
    expect(v.state).toEqual(state(f.delta.target));
  });

  it('refuses a proof from any other trusted state', () => {
    const otherRoot = { ...root, quorumRoot: root.masternodeRoot };
    rejects(proof, otherRoot, 'untrusted-checkpoint');
    rejects(proof, state(f.delta.checkpoint), 'untrusted-checkpoint');
    rejects(proof, QUORUM_CHECKPOINTS[network === 'testnet' ? 'mainnet' : 'testnet'], 'untrusted-checkpoint');
  });

  it('enforces the minimum height before any signature work', () => {
    expect(() => verifyQuorumProof(proof, root, f.target.height + 1)).toThrow(QuorumProofError);
    expect(verifyQuorumProof(proof, root, f.target.height).state.height).toBe(f.target.height);
    let kind;
    try { verifyQuorumProof(proof, root, f.target.height + 1); } catch (e) { kind = (e as QuorumProofError).kind; }
    expect(kind).toBe('stale');
  });

  it('rejects forged links: a changed signature, header or mined commitment, or a reused certificate', () => {
    const l = layout(proof);
    expect(l.links.length).toBeGreaterThan(1);
    for (const k of [0, l.links.length >> 1, l.links.length - 1]) {
      const { cert, mining } = l.links[k]!;
      rejects(flip(proof, cert + 4 + 84 + 10), root);   // signature
      rejects(flip(proof, cert + 4 + 40), root);        // header (merkle root)
      rejects(flip(proof, cert, 1), root);              // height
      rejects(flip(proof, mining + 50), root);          // the next quorum's commitment transaction
    }
    // the second certificate replaced by the first: a real ChainLock, but not by the signer that link needs
    const a = l.links[0]!, b = l.links[1]!;
    const swapped = Uint8Array.from(proof);
    swapped.set(proof.subarray(a.cert, a.cert + 180), b.cert);
    rejects(swapped, root);
    // ancestor headers between a mining block and its certified block
    const withAncestors = l.links.find((x) => x.ancestorCount > 0);
    if (withAncestors) rejects(flip(proof, withAncestors.ancestors + 30), root);
  });

  it('rejects infinity and null signatures', () => {
    const l = layout(proof);
    for (const at of [l.target + 84, l.links[0]!.cert + 84]) {
      const inf = Uint8Array.from(proof);
      inf.fill(0, at, at + 96);
      inf[at] = 0xc0;
      rejects(inf, root);
      const zero = Uint8Array.from(proof);
      zero.fill(0, at, at + 96);
      rejects(zero, root);
    }
  });

  it('rejects truncated and extended proofs', () => {
    for (const n of [0, 8, 109, proof.length >> 1, proof.length - 1]) rejects(proof.subarray(0, n), root);
    const longer = new Uint8Array(proof.length + 1);
    longer.set(proof);
    rejects(longer, root);
  });
});

describe('a ChainLock quorum outside the trusted set', () => {
  it('rejects a real chain re-anchored on a checkpoint its seed quorum is not committed under', () => {
    const f = load('testnet');
    // the delta proof is genuine from the first target, signed by a quorum active there; claim it starts from the pin instead
    const delta = Uint8Array.from(unhex(f.delta.proof_hex));
    const root = QUORUM_CHECKPOINTS.testnet;
    const head = unhex(f.proof_hex).subarray(8, 109); // the pin's encoded state, as the main proof carries it
    delta.set(head, 8);
    expect(rejects(delta, root)).toMatch(/Merkle/);
  });
});

describe('bootstrap envelopes', () => {
  const f = load('testnet');
  const bootstrap = unhex(f.bootstrap!.bootstrap_hex), root = state(f.checkpoint);

  it('verifies the envelope, records included, to the same target', () => {
    expect(verifyQuorumProof(bootstrap, root).state).toEqual(state(f.bootstrap!.target));
  });

  it('rejects a changed record or a truncated envelope', () => {
    rejects(flip(bootstrap, bootstrap.length - 40), root);
    rejects(bootstrap.subarray(0, bootstrap.length - 1), root);
  });
});

describe('single-bit flips', () => {
  // A leaf away from a tree's right edge has the same path for neighbouring leaf counts of the same depth, so a flipped bit in a Merkle
  // path's `count` can still verify: to the identical state (the leaf is proven at the same index under the same root). That is the
  // only freedom the encoding leaves; it can never change what is verified.
  it('never verifies a flipped proof to anything but the original state, and only flips inside a Merkle leaf count are accepted', () => {
    const f = load('testnet');
    const proof = unhex(f.delta.proof_hex), trusted = state(f.delta.checkpoint), want = state(f.delta.target);
    const l = layout(proof);
    const pathAt = (start: number, dataLen: number) => start + dataLen;      // a path follows its blob
    const seedCount = pathAt(l.seed, new DataView(proof.buffer, proof.byteOffset).getUint32(l.seed - 4, true)) + 4;
    const coinbaseBlob = l.target + 180;
    const coinbaseCount = coinbaseBlob + 4 + new DataView(proof.buffer, proof.byteOffset).getUint32(coinbaseBlob, true) + 4;
    const counts = [seedCount, coinbaseCount];
    let checked = 0;
    for (let at = 0; at < proof.length; at += 3) {
      for (const mask of [0x01, 0x80]) {
        let accepted: ProofState | null = null;
        try { accepted = verifyQuorumProof(flip(proof, at, mask), trusted).state; } catch (e) { expect(e).toBeInstanceOf(QuorumProofError); }
        if (accepted) {
          expect(accepted).toEqual(want);
          expect(counts.some((c) => at >= c && at < c + 4), `bit ${mask} of byte ${at} flipped`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(800);
  });
});
