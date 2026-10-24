// X11 block-header hashing (own entry point). The implementation is @dashevo/x11-hash-js (MIT, maintained by the Dash org, pure JS,
// the one dashcore-lib ships), vendored as ES modules in ./vendor/x11 with a one-line strict-mode fix: see scripts/vendor-x11.mjs.
// ~0.5 ms per 80-byte header in Node; see the README for the evaluation and the bundle cost.
import { hashHex } from './bytes.ts';
import { digest } from './vendor/x11/x11.js';

/** X11 of an 80-byte block header: the 32-byte block hash in internal (wire) order. */
export function x11(header: Uint8Array): Uint8Array {
  if (header.length !== 80) throw new Error(`x11: expected an 80-byte header, got ${header.length}`);
  return Uint8Array.from(digest(Array.from(header)));
}

/** Block hash of a header in display (RPC) order, as used by getBlock/getTransaction and CLSIGs after conversion. */
export const blockHashHex = (header: Uint8Array): string => hashHex(x11(header));
