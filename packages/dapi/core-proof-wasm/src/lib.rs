//! A no-import WebAssembly module around `dash-core-proof`.
//!
//! ABI (all integers little-endian, hashes in wire order):
//! - `alloc(len) -> ptr`, `dealloc(ptr, len)`: buffers the host writes inputs into.
//! - `verify(proof_ptr, proof_len, trusted_ptr, minimum_height) -> status`, with `trusted_ptr` pointing at 101 bytes
//!   (network u8 (0 mainnet, 1 testnet), height u32, block hash, masternode root, quorum root). The proof is either a
//!   `DASHNC02` chain (`proof_hex`) or a bootstrap envelope (`bootstrap_hex`); the envelope is verified whole, records included.
//! - `out_ptr()`, `out_len()`: the result of the last call.
//!   status 0: 101-byte target state, target height u32, its 80-byte header, its 96-byte signature, link count u16.
//!   status 1: invalid; 2: stale target (below `minimum_height`); 3: untrusted checkpoint. The output is the UTF-8 reason.
use dash_core_proof::{bootstrap, ErrorKind, ProofNetwork, QuorumProofChain, State, PROOF_MAGIC};
use std::cell::RefCell;

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` and `len` must come from one `alloc` call.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

fn hash(bytes: &[u8]) -> [u8; 32] {
    let mut h = [0; 32];
    h.copy_from_slice(bytes);
    h
}

fn decode_state(b: &[u8]) -> Option<State> {
    if b.len() != 101 {
        return None;
    }
    let network = match b[0] {
        0 => ProofNetwork::Mainnet,
        1 => ProofNetwork::Testnet,
        _ => return None,
    };
    Some(State {
        network,
        height: u32::from_le_bytes([b[1], b[2], b[3], b[4]]),
        block_hash: hash(&b[5..37]),
        masternode_root: hash(&b[37..69]),
        quorum_root: hash(&b[69..101]),
    })
}

fn encode_state(s: &State, out: &mut Vec<u8>) {
    out.push(match s.network {
        ProofNetwork::Mainnet => 0,
        ProofNetwork::Testnet => 1,
    });
    out.extend(s.height.to_le_bytes());
    out.extend(s.block_hash);
    out.extend(s.masternode_root);
    out.extend(s.quorum_root);
}

/// The chain inside a bootstrap envelope: a u32 length, then the chain's bytes (the crate's blob encoding). Only read after
/// the whole envelope verified, so a malformed prefix has already been rejected.
fn envelope_chain(bytes: &[u8]) -> Option<&[u8]> {
    let len = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    bytes.get(4..4usize.checked_add(len)?)
}

/// A rejection: the status code the host sees and the reason.
type Rejection = (u32, &'static str);

fn rejection(e: dash_core_proof::Error) -> Rejection {
    let status = match e.kind() {
        ErrorKind::StaleTarget => 2,
        ErrorKind::UntrustedCheckpoint => 3,
        _ => 1,
    };
    (status, e.message())
}

fn run(proof: &[u8], trusted: &State, minimum: u32) -> Result<Vec<u8>, Rejection> {
    let (state, chain) = if proof.starts_with(PROOF_MAGIC) {
        let chain = QuorumProofChain::decode(proof).map_err(rejection)?;
        // Decided before any signature work, as bootstrap::verify does.
        if chain.target.height < minimum {
            return Err((2, "stale target"));
        }
        (chain.verify(trusted).map_err(rejection)?, chain)
    } else {
        let state = bootstrap::verify(proof, trusted, minimum).map_err(rejection)?.state().clone();
        let inner = envelope_chain(proof).ok_or((1, "bootstrap envelope"))?;
        (state, QuorumProofChain::decode(inner).map_err(rejection)?)
    };
    let mut out = Vec::with_capacity(101 + 4 + 80 + 96 + 2);
    encode_state(&state, &mut out);
    out.extend(chain.target.height.to_le_bytes());
    out.extend(chain.target.header);
    out.extend(chain.target.signature);
    out.extend((chain.links.len() as u16).to_le_bytes());
    Ok(out)
}

/// # Safety
/// The pointers must point at `proof_len` and 101 readable bytes.
#[no_mangle]
pub unsafe extern "C" fn verify(proof_ptr: *const u8, proof_len: usize, trusted_ptr: *const u8, minimum: u32) -> u32 {
    let proof = std::slice::from_raw_parts(proof_ptr, proof_len);
    let trusted = std::slice::from_raw_parts(trusted_ptr, 101);
    let (status, bytes) = match decode_state(trusted) {
        None => (1, b"malformed trusted state".to_vec()),
        Some(trusted) => match run(proof, &trusted, minimum) {
            Ok(bytes) => (0, bytes),
            Err((status, reason)) => (status, reason.as_bytes().to_vec()),
        },
    };
    OUT.with(|o| *o.borrow_mut() = bytes);
    status
}
