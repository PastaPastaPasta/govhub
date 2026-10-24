// DIP 175 quorum proof chains (own entry point, `@govhub/dapi/coreproof`): Dash Core's `getquorumproofchain` output verified from a
// trusted checkpoint by `dash-core-proof`, the Core-parity Rust verifier of dashpay/platform PR #5521, compiled unmodified to a
// ~267 KB WebAssembly module with no imports (core-proof-wasm/, rebuilt by core-proof-wasm/build.sh into ./vendor/core-proof-wasm.ts).
// Instantiated synchronously on first use, like the X11 module.
import { hashBytes, hashHex } from './bytes.ts';
import type { Network } from './chainlock.ts';
import { MAX_PROOF_BYTES, type ProofState, type VerifiedQuorumProof, QuorumProofError } from './quorumproof.ts';
import { CORE_PROOF_WASM_BASE64 } from './vendor/core-proof-wasm.ts';

interface CoreProofExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  out_ptr(): number;
  out_len(): number;
  verify(proof: number, proofLen: number, trusted: number, minimum: number): number;
}

let wasm: CoreProofExports | undefined;
function api(): CoreProofExports {
  if (wasm) return wasm;
  const bin = atob(CORE_PROOF_WASM_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return (wasm = new WebAssembly.Instance(new WebAssembly.Module(bytes as BufferSource), {}).exports as unknown as CoreProofExports);
}

const STATE_BYTES = 101;
const NETWORK_WIRE: Record<Network, number> = { mainnet: 0, testnet: 1 };

function encodeState(s: ProofState): Uint8Array {
  const out = new Uint8Array(STATE_BYTES);
  out[0] = NETWORK_WIRE[s.network];
  new DataView(out.buffer).setUint32(1, s.height, true);
  out.set(hashBytes(s.blockHash), 5);
  out.set(hashBytes(s.masternodeRoot), 37);
  out.set(hashBytes(s.quorumRoot), 69);
  return out;
}

function decodeState(b: Uint8Array): ProofState {
  const network: Network = b[0] === 0 ? 'mainnet' : 'testnet';
  return {
    network,
    height: new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(1, true),
    blockHash: hashHex(b.subarray(5, 37)),
    masternodeRoot: hashHex(b.subarray(37, 69)),
    quorumRoot: hashHex(b.subarray(69, 101)),
  };
}

/**
 * Verify a `DASHNC02` proof chain (Core's `proof_hex`) or a bootstrap envelope (`bootstrap_hex`, records included) from `trusted`,
 * requiring a target at or above `minimumHeight`. Returns the authenticated target state and the target block's ChainLock
 * (its header and signature, which the chain verified). Throws QuorumProofError otherwise.
 */
export function verifyQuorumProof(proof: Uint8Array, trusted: ProofState, minimumHeight = 0): VerifiedQuorumProof {
  if (!Number.isInteger(minimumHeight) || minimumHeight < 0 || minimumHeight > 0xffffffff) throw new RangeError('minimumHeight must be a u32');
  if (proof.length > MAX_PROOF_BYTES) throw new QuorumProofError('invalid', 'proof size limit');
  const w = api();
  const t = encodeState(trusted);
  let pp = 0, tp = 0;
  try {
    let status: number;
    try {
      pp = w.alloc(proof.length);
      tp = w.alloc(STATE_BYTES);
      new Uint8Array(w.memory.buffer, pp, proof.length).set(proof);
      new Uint8Array(w.memory.buffer, tp, STATE_BYTES).set(t);
      status = w.verify(pp, proof.length, tp, minimumHeight);
    } catch (e) {
      // a trap (panic = abort, out of memory) leaves the instance's allocator in an unknown state: start a fresh one next time
      wasm = undefined;
      throw new QuorumProofError('invalid', `verifier trapped: ${(e as Error).message}`);
    }
    const out = new Uint8Array(w.memory.buffer, w.out_ptr(), w.out_len()).slice();
    if (status !== 0) {
      const reason = new TextDecoder().decode(out);
      throw new QuorumProofError(status === 2 ? 'stale' : status === 3 ? 'untrusted-checkpoint' : 'invalid', reason);
    }
    if (out.length !== STATE_BYTES + 4 + 80 + 96 + 2) throw new QuorumProofError('invalid', 'verifier output size');
    const state = decodeState(out.subarray(0, STATE_BYTES));
    if (state.network !== trusted.network) throw new QuorumProofError('invalid', 'network changed');
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const header = out.slice(STATE_BYTES + 4, STATE_BYTES + 84);
    return {
      state,
      chainLock: { height: dv.getUint32(STATE_BYTES, true), header, signature: out.slice(STATE_BYTES + 84, STATE_BYTES + 180) },
      links: dv.getUint16(STATE_BYTES + 180, true),
      from: trusted,
    };
  } finally {
    if (wasm === w) {
      w.dealloc(pp, proof.length);
      w.dealloc(tp, STATE_BYTES);
    }
  }
}
