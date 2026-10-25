// Sign-out (and identity switch) hooks that must run SYNCHRONOUSLY with the sign-out click or `pagehide`, before React re-renders:
// key material held outside the session itself (the masternode keyring's voting keys, voting/KeyringContext.tsx) is wiped here, so
// it is gone even when the page is frozen into the back/forward cache right after.
const hooks = new Set<(next: string | null) => void>();

/**
 * Registers `fn` to run when the signed-in session ends or is replaced; it gets the identity signing in next (null: signed out).
 * Returns the unregister function.
 */
export function onSessionEnd(fn: (next: string | null) => void): () => void {
  hooks.add(fn);
  return () => void hooks.delete(fn);
}

/** Runs every hook (each one even when another throws). `next`: the identity signing in instead, if any. */
export function endSession(next: string | null = null): void {
  for (const h of [...hooks]) {
    try {
      h(next);
    } catch {
      /* a failing hook must not keep the others from wiping */
    }
  }
}
