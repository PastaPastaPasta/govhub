// A wallet (App Connect) session ends when its key is disabled on Platform: the wallet revoked it, or retired it for a newer one.
// Platform then refuses every transition the key signs ("Identity key 6 is disabled"); the document writer refuses it before
// broadcasting when its identity read already shows the key disabled (same wording). Both are recognised here by their shape, never
// by the key number.

export const WALLET_SESSION_ENDED_TEXT = 'Your wallet session has ended. Reconnect with App Connect to continue.';

/** Thrown in place of Platform's refusal once a wallet session's key turned out disabled; the session is already signed out. */
export class WalletSessionEndedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(WALLET_SESSION_ENDED_TEXT, options);
    this.name = 'WalletSessionEndedError';
  }
}

const DISABLED_KEY = [
  // "Identity key 6 is disabled", "Identity Public Key #12 has been disabled", "public key with id 3 disabled"
  /\b(?:identity\s+(?:public\s+)?|public\s+)key\s+(?:with\s+)?(?:id\s+)?#?\d+\s+(?:(?:is|was|has\s+been)\s+)?disabled\b/i,
  // consensus error class names, as Rust or JS errors name them
  /\b(?:IdentityPublicKeyIsDisabled|PublicKeyIsDisabled|DisabledIdentityPublicKey|IdentityKeyDisabled)(?:Error)?\b/,
];

/** The text an error carries: its name and message, its `cause` chain, and nested `errors` (WASM errors are not Error instances). */
function texts(e: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || e === null || e === undefined) return out;
  if (typeof e === 'string') {
    out.push(e);
    return out;
  }
  if (typeof e !== 'object') return out;
  const o = e as { name?: unknown; message?: unknown; cause?: unknown; errors?: unknown; toString?: () => string };
  for (const v of [o.name, o.message]) if (typeof v === 'string') out.push(v);
  // an error object without a message may still say it in its toString (Error's own repeats name and message)
  if (typeof o.message !== 'string' && typeof o.toString === 'function' && o.toString !== Object.prototype.toString) {
    try {
      out.push(String(o.toString()));
    } catch {
      /* a throwing toString tells nothing */
    }
  }
  texts(o.cause, depth + 1, out);
  if (Array.isArray(o.errors)) for (const x of o.errors.slice(0, 8)) texts(x, depth + 1, out);
  return out;
}

/** True when `e` says the signing key is disabled on the identity (whatever its id). */
export function isDisabledKeyError(e: unknown): boolean {
  return texts(e).some((t) => DISABLED_KEY.some((r) => r.test(t)));
}
