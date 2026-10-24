// X11 block-header hashing (own entry point). Wraps @dashevo/x11-hash-js (MIT, maintained by the Dash org, pure JS, no WASM):
// it is the implementation dashcore-lib ships. ~0.5 ms per 80-byte header in Node; see README for the size and the evaluation.
import x11js from '@dashevo/x11-hash-js';
import { hashHex } from './bytes.ts';

/** X11 of an 80-byte block header: the 32-byte block hash in internal (wire) order. */
export function x11(header: Uint8Array): Uint8Array {
  if (header.length !== 80) throw new Error(`x11: expected an 80-byte header, got ${header.length}`);
  return Uint8Array.from(x11js.digest(Array.from(header), 1, 1));
}

/** Block hash of a header in display (RPC) order, as used by getBlock/getTransaction and CLSIGs after conversion. */
export const blockHashHex = (header: Uint8Array): string => hashHex(x11(header));
