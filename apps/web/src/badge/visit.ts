// Visit separation (review H1). The issuer sees when a masternode's token request arrives and from where; everyone sees when an
// identity writes to Platform. If both happen in the same visit (page load), the times line up and link the masternode to the
// identity. So within one visit the app does EITHER issuer-facing work (one token request) OR identity writes (posting a badge),
// never both, and a token request waits for a visit in which this identity has not written anything. Across tabs and identities
// in one browser, token requests are at least COOLDOWN_MS apart, so two identities' masternodes are not linked by one visit either.
const COOLDOWN_KEY = 'govhub.badge.lastRequestMs';
export const COOLDOWN_MS = 30 * 60_000;

const state = { requestSent: false, identityWrote: false };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Called by the document writer for every Platform write of the signed-in identity. */
export function noteIdentityWrite(): void {
  if (state.identityWrote) return;
  state.identityWrote = true;
  emit();
}

export function noteRequestSent(storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  state.requestSent = true;
  storage?.setItem(COOLDOWN_KEY, String(Date.now()));
  emit();
}

export function mayRequest(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage, now = Date.now()): boolean {
  const last = Number(storage?.getItem(COOLDOWN_KEY) ?? 0);
  return !state.requestSent && !state.identityWrote && !(now - last < COOLDOWN_MS);
}

export const mayPost = (): boolean => !state.requestSent;

export const visitState = (): Readonly<typeof state> => ({ ...state });

export function onVisitChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Tests only. */
export function resetVisit(): void {
  state.requestSent = false;
  state.identityWrote = false;
}
