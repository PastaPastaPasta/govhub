// Activity separation (review H1, N1; PLAN §8.10). The issuer sees when a masternode's token request arrives and from where;
// everyone sees when an identity changes Platform state. If the two happen close together, the times line up and link the
// masternode to the identity. So, across every tab and identity in this browser (localStorage, not per page load):
//   - a token request (Standard or Private) goes out only if nothing was written to Platform from this browser for COOLDOWN_MS
//     plus the job's own random extra (drawQuietExtraMs), and no other request went out in that time (two identities'
//     masternodes are not linked by one session either);
//   - a badge is posted (an identity write) only COOLDOWN_MS after the last request: a Private one at its random height, a held
//     Standard one with the identity's next write after that (onIdentityWrite), unless the user asks for it at once (Register now).
// A user's own write right after a request cannot be prevented; while it would undo something (a held token or a Private job),
// every tab shows a short note during the cooldown.
const REQUEST_KEY = 'govhub.badge.lastRequestMs';
const WRITE_KEY = 'govhub.badge.lastWriteMs';
export const COOLDOWN_MS = 30 * 60_000;

type Store = (Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>) | undefined;
/** `localStorage` itself throws (SecurityError) when site data is blocked: resolve it inside a try. */
function local(): Store {
  try {
    const s = globalThis.localStorage;
    if (s) return s;
  } catch {
    /* blocked: fall through */
  }
  // blocked (throws) or disabled (null): reads fail closed
  return { getItem: () => { throw new Error('storage blocked'); }, setItem: () => undefined };
}
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** A stored time in the future (the clock was ahead) counts as now; unreadable storage counts as "just now" (fail closed). */
function read(s: Store, k: string, now: number): number {
  try {
    const v = Number(s?.getItem(k) ?? 0) || 0;
    return Math.min(v, now);
  } catch {
    return now;
  }
}
function write(s: Store, k: string, now: number): void {
  try {
    s?.setItem(k, String(now));
  } catch {
    /* storage blocked: the read side fails closed */
  }
}

/** Marks a Platform state transition of a signed-in identity (documents, identity create/top-up/update), at its start and end. */
export function noteIdentityWrite(storage: Store = local(), now = Date.now()): void {
  write(storage, WRITE_KEY, now);
  emit();
}

/** Who is about to write: the identity, or null for a write that must not carry a held badge (a badge post, a new identity). */
type WriteListener = (ownerId: string | null) => void;
const writeListeners = new Set<WriteListener>();

/**
 * Called just before a Platform write is sent (auth/runtime.ts): marks it, then tells the badge provider, which may send a held
 * Standard badge alongside it. Listeners must not block: the user's write never waits for a badge.
 */
export function beforeIdentityWrite(ownerId: string | null, storage: Store = local(), now = Date.now()): void {
  noteIdentityWrite(storage, now);
  for (const l of writeListeners) {
    try {
      l(ownerId);
    } catch {
      /* a listener's failure is never the write's */
    }
  }
}

/** Subscribes to beforeIdentityWrite (in this tab: the write happens here). */
export function onIdentityWrite(l: WriteListener): () => void {
  writeListeners.add(l);
  return () => void writeListeners.delete(l);
}

/**
 * Called before a token request (the one that names the masternode) is sent to an issuer. A challenge alone names nothing, so a
 * request that failed at the challenge (issuer unreachable) starts no cooldown.
 */
export function noteRequestSent(storage: Store = local(), now = Date.now()): void {
  write(storage, REQUEST_KEY, now);
  emit();
}

/**
 * A request attempt (either mode), marked before it starts, under the activity lock, so two tabs cannot both pass mayRequest.
 * Returns an undo for an attempt that sent no token request (the issuer was unreachable): it restores the previous mark, unless
 * something newer was marked meanwhile.
 */
export function noteRequestAttempt(storage: Store = local(), now = Date.now()): () => void {
  let prev: string | null = null;
  try {
    prev = storage?.getItem(REQUEST_KEY) ?? null;
  } catch {
    /* blocked */
  }
  write(storage, REQUEST_KEY, now);
  emit();
  return () => {
    try {
      if (storage?.getItem(REQUEST_KEY) !== String(now)) return; // newer mark: keep it
      if (prev === null) storage?.removeItem?.(REQUEST_KEY);
      else storage?.setItem(REQUEST_KEY, prev);
    } catch {
      /* blocked storage: the read side fails closed */
    }
    emit();
  };
}

export function mayRequest(storage: Store = local(), now = Date.now()): boolean {
  return requestWaitLeft(storage, now) === 0;
}

export function mayPost(storage: Store = local(), now = Date.now()): boolean {
  return now - read(storage, REQUEST_KEY, now) >= COOLDOWN_MS;
}

/**
 * A request does not go out the moment the quiet half hour ends. Platform writes are public and timestamped (the unified flow's
 * keyring save among them), so "30 minutes after this identity's last write" would point at the identity. Each job draws its
 * own extra quiet time once, when it is created (stored with it, so a reload cannot draw again and shorten it): exponential
 * with mean QUIET_EXTRA_MEAN_MS, capped at QUIET_EXTRA_MAX_MS. Memoryless, so the time already waited says nothing about when it
 * goes. A browser that has been quiet for longer than that sends at once.
 */
export const QUIET_EXTRA_MEAN_MS = 60 * 60_000;
export const QUIET_EXTRA_MAX_MS = 4 * 60 * 60_000;
export function drawQuietExtraMs(random32: () => number): number {
  const u = (random32() + 1) / 2 ** 32; // (0, 1]
  return Math.min(QUIET_EXTRA_MAX_MS, Math.round(-QUIET_EXTRA_MEAN_MS * Math.log(u)));
}

/** When this browser last wrote to Platform or sent a token request (ms; 0: never). Unreadable storage counts as now. */
export function lastActivityAt(storage: Store = local(), now = Date.now()): number {
  return Math.max(read(storage, REQUEST_KEY, now), read(storage, WRITE_KEY, now));
}

/** Milliseconds since the last write or request from this browser. Fails closed (0) on unreadable storage. */
export function quietForMs(storage: Store = local(), now = Date.now()): number {
  return now - lastActivityAt(storage, now);
}

/** Milliseconds until a token request may go out (0: now): the later of the write and the request cooldowns. Fails closed. */
export function requestWaitLeft(storage: Store = local(), now = Date.now()): number {
  return Math.max(0, read(storage, REQUEST_KEY, now) + COOLDOWN_MS - now, read(storage, WRITE_KEY, now) + COOLDOWN_MS - now);
}

/**
 * Milliseconds left of the cooldown after the last request (0 when none is running): no badge is posted before it ends, and the
 * note may show while it runs. Unreadable storage gives 0 (no request can have been recorded, so there is nothing to tell the
 * user; mayPost still fails closed).
 */
export function requestCooldownLeft(storage: Store = local(), now = Date.now()): number {
  try {
    const at = Math.min(Number(storage?.getItem(REQUEST_KEY) ?? 0) || 0, now);
    return Math.max(0, at + COOLDOWN_MS - now);
  } catch {
    return 0;
  }
}

/** Changes in this tab, and in other tabs (storage events). */
export function onVisitChange(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => (e.key === REQUEST_KEY || e.key === WRITE_KEY) && l();
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners.delete(l);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}
