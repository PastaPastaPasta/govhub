// Badge state shared by every page: the trust list, the reader (badges next to authors, the "MN owners" filter), and the badge
// client (requestBadge for the keyring or the key-paste form, and the scheduler that finishes requests and posts badges).
//
// The scheduler (review H1/N1, M3): one per identity across tabs (Web Locks), every change merged into the latest stored jobs under
// a store lock, and token requests kept COOLDOWN_MS away from any Platform write from this browser and from each other (visit.ts),
// so the issuer's view of a request and the public view of this identity's writes do not line up.
// A held Standard token (PLAN §8.10) is never posted by the scheduler: it goes out with this identity's next Platform write in
// this browser once the request's cooldown is over (onIdentityWrite, in whichever tab writes), or at once on Register now.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parsePrivacyMode, type PrivacyMode } from '@govhub/badge';
import { signMessageWif } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import type { AppAuthSession } from '../session/authSession.ts';
import { BADGE_NETWORKS, loadTrustList, resetTrustList, saveTrustList, type TrustedIssuer } from './config.ts';
import { createJob, isActive, type BadgeJob, type ClientDeps, type VotingSigner } from './client.ts';
import { badgeQuery, badgesOfAuthors } from './queries.ts';
import { createBadgeReader, type BadgeReader } from './reader.ts';
import { deriveStoreKey, encryptedJobStore, jobStorageKey, memoryJobStore, type JobStore } from './store.ts';
import { cooldownNote, createScheduler, separationAtStake, TICK_MS, type Mutate, type Scheduler } from './scheduler.ts';
import { onIdentityWrite, onVisitChange, requestCooldownLeft, requestWaitLeft } from './visit.ts';
import { badgeWorker } from './workerClient.ts';

export interface BadgeCtx {
  /** the `badge` contract of the Platform network, '' when badges are not deployed there */
  contractId: string;
  trust: TrustedIssuer[];
  setTrust(list: TrustedIssuer[]): void;
  resetTrust(): void;
  /** null in fixture mode or where badges are not deployed */
  reader: BadgeReader | null;
  jobs: BadgeJob[];
  /** Platform's core height at the last scheduler tick */
  coreHeight: number | null;
  /**
   * Starts a badge request for the signed-in identity: `voting` is the MN voting key as WIF (stored encrypted with the job), or a
   * signer (the keyring), which must be registered with registerVotingSigner when the request runs. Resolves once the request is
   * scheduled; it is sent later, without public writes from this browser in the half hour before (Standard: as soon as that
   * holds; Private: at a random height in the issuance window).
   * `epoch`: a later epoch, when the issuer's first key is for that one (RequestOptions.epoch).
   */
  requestBadge(voting: string | VotingSigner, proTxHash: string, opts?: { issuer?: TrustedIssuer; keepKey?: boolean; mode?: PrivacyMode; epoch?: number }): Promise<BadgeJob>;
  /** the user's privacy mode for new requests (remembered per identity in this browser); default 'standard' */
  privacy: PrivacyMode;
  setPrivacy(mode: PrivacyMode): void;
  /** The keyring registers a signer for an MN while it is unlocked; call the returned function to unregister. */
  registerVotingSigner(proTxHash: string, signer: VotingSigner): () => void;
  /** Deletes a job and everything stored with it (blinding state, an encrypted voting key): Remove, and Cancel for pending ones. Resolves once saved. */
  removeJob(id: string): Promise<void>;
  /** Clears a job's backoff and wakes the scheduler (Retry now). Requests still wait for their quiet half hour. */
  retryJob(id: string): void;
  /** Register now: posts a held Standard token at once, whatever the cooldown (the user accepts the timing link). */
  registerNow(id: string): Promise<void>;
  /** ms until a token request may go out from this browser (0: now) */
  requestWait: number;
  /** ms left of the cooldown after the last token request (0: none running): a held badge goes with a write only after it */
  postWait: number;
}

const Ctx = createContext<BadgeCtx | null>(null);

export function useBadgeCtx(): BadgeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useBadgeCtx outside BadgeProvider');
  return c;
}

/** The badge client API (for the keyring UI): requestBadge and registerVotingSigner. */
export function useBadgeClient(): Pick<BadgeCtx, 'requestBadge' | 'registerVotingSigner' | 'jobs'> {
  const { requestBadge, registerVotingSigner, jobs } = useBadgeCtx();
  return { requestBadge, registerVotingSigner, jobs };
}

/** Runs `fn` under a Web Lock when the browser has them (all current ones), else directly. */
function withLock<T>(name: string, fn: () => Promise<T>, opts: { signal?: AbortSignal } = {}): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  return locks ? (locks.request(name, opts, fn) as Promise<T>) : fn();
}

export function BadgeProvider({ children }: { children: ReactNode }) {
  const { registry, mode } = useApp();
  const { session } = useForum();
  const net = registry.platformNetwork;
  const cfg = BADGE_NETWORKS[net];
  const contractId = cfg.contractId;
  const [trust, setTrustState] = useState<TrustedIssuer[]>(() => loadTrustList(net));
  useEffect(() => setTrustState(loadTrustList(net)), [net]);
  const setTrust = useCallback((list: TrustedIssuer[]) => (saveTrustList(net, list), setTrustState(list)), [net]);
  const resetTrust = useCallback(() => setTrustState(resetTrustList(net)), [net]);
  const trustRef = useRef(trust);
  trustRef.current = trust;

  const reader = useMemo(() => (mode === 'live' && contractId ? createBadgeReader(registry, contractId, trust) : null), [mode, contractId, registry, trust]);

  const [jobs, setJobs] = useState<BadgeJob[]>([]);
  const [coreHeight, setCoreHeight] = useState<number | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  // the spacing as it stands, in every tab: when a request may go out, and the cooldown after the last one (for the note)
  const [visit, setVisit] = useState(() => ({ requestWait: requestWaitLeft(), postWait: requestCooldownLeft() }));
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(t);
      const v = { requestWait: requestWaitLeft(), postWait: requestCooldownLeft() };
      setVisit((old) => (old.requestWait === v.requestWait && old.postWait === v.postWait ? old : v));
      const next = Math.min(...[v.requestWait, v.postWait].filter((x) => x > 0));
      if (Number.isFinite(next)) t = setTimeout(update, Math.min(next, 60_000));
    };
    update();
    const off = onVisitChange(update);
    return () => (off(), clearTimeout(t));
  }, []);
  const signers = useRef(new Map<string, VotingSigner>());
  const jobsRef = useRef<BadgeJob[]>([]);
  /** the current effect run's merge-and-save (null while no identity is loaded) */
  const commitRef = useRef<((m: Mutate) => Promise<BadgeJob[]>) | null>(null);
  /** the current effect run's poster of held Standard tokens (null while no identity is loaded) */
  const postHeldRef = useRef<((o: { id?: string; force: boolean }) => Promise<void>) | null>(null);
  const wakeRef = useRef<() => void>(() => undefined);
  // the privacy mode, remembered per identity in this browser (not on Platform: it says something about the user)
  const modeKey = `govhub.badge.mode.v1.${session?.identityId ?? '-'}`;
  const readMode = (k: string): PrivacyMode => {
    try {
      return parsePrivacyMode(globalThis.localStorage?.getItem(k), 'standard'); // a remembered Extra private reads as Private
    } catch {
      return 'standard';
    }
  };
  const [privacy, setPrivacyState] = useState<PrivacyMode>(() => readMode(modeKey));
  useEffect(() => setPrivacyState(readMode(modeKey)), [modeKey]);
  const setPrivacy = useCallback(
    (m: PrivacyMode) => {
      try {
        globalThis.localStorage?.setItem(modeKey, m);
      } catch {
        /* not remembered */
      }
      setPrivacyState(m);
    },
    [modeKey],
  );
  const authSession = session && 'auth' in session ? (session as AppAuthSession) : null;

  const deps = useMemo<ClientDeps | null>(() => {
    if (!reader || !session) return null;
    return {
      net,
      contractId,
      ownerId: session.identityId,
      issuerKey: (i, e) => reader.key(i, e),
      worker: badgeWorker,
      signWithWif: (wif, m) => signMessageWif(wif, m, net),
      externalSigner: (p) => signers.current.get(p),
      async postBadge(data) {
        const height = await reader.coreHeight();
        const r = await session.signAndBroadcastDocument({ action: 'create', contractId, type: 'mnBadge', data: { ...data, $createdAtCoreBlockHeight: height } });
        return r.id;
      },
      async hasBadge(issuerId, epoch) {
        return (await badgeQuery(registry, contractId, badgesOfAuthors(issuerId, epoch, [session.identityId]))).docs.length > 0;
      },
      trusted: (id) => trustRef.current.some((t) => t.identityId === id && t.enabled),
      reportedTokens: (i, e) => reader.reportedTokens(i, e),
      issuerFlagged: async (i, e) => (await reader.audit({ ...i, enabled: true }, e, await reader.coreHeight())).flagged,
      minAnonymitySet: cfg.minAnonymitySet,
    };
  }, [reader, session, net, contractId, registry, cfg.minAnonymitySet]);

  // Load this identity's jobs (decrypting with a key derived from its signing key) and run the scheduler.
  useEffect(() => {
    let live = true;
    const ac = new AbortController();
    jobsRef.current = [];
    setJobs([]);
    commitRef.current = null;
    postHeldRef.current = null;
    if (!deps || !session) return;
    const ownerId = session.identityId;
    const lockBase = `govhub-badge-${net}-${ownerId}`;
    let store: JobStore | null = null;
    const show = (j: BadgeJob[]) => {
      if (!live) return;
      jobsRef.current = j;
      setJobs(j);
    };
    const commit = (mutate: Mutate) =>
      withLock(`${lockBase}-store`, async () => {
        if (!live || !store) throw new Error('signed out');
        const next = mutate(await store.load());
        await store.save(next);
        show(next);
        return next;
      });
    const sleep = (ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        const done = () => (clearTimeout(t), r());
        wakeRef.current = done; // a Standard request wakes the scheduler at once
        ac.signal.addEventListener('abort', done, { once: true });
      });

    let sched: Scheduler | null = null;
    // this identity is about to write in this tab: its held badge goes along (never delaying the write: not awaited)
    const offWrite = onIdentityWrite((writer) => {
      if (writer === ownerId) void sched?.postHeld({ force: false }).catch(() => undefined);
    });
    (async () => {
      // one store per (identity, signing key): the store key comes from the key, so another key of the same identity has its own
      const s = authSession ? encryptedJobStore(`${ownerId}.${authSession.auth.keyId}`, ownerId, await deriveStoreKey(authSession.auth.privateKey, ownerId)) : memoryJobStore();
      let loaded: BadgeJob[];
      try {
        loaded = await s.load(); // throws when stored data does not decrypt: then nothing is ever saved over it (N5)
      } catch {
        if (live) setStoreError('Your saved badge requests could not be decrypted with this sign-in key. Sign in with the key you used for them.');
        return;
      }
      setStoreError(null);
      if (!live) return;
      store = s;
      commitRef.current = commit;
      const current = createScheduler({
        net,
        deps,
        store: s,
        commit,
        coreHeight: () => reader!.coreHeight(),
        onHeight: (h) => live && setCoreHeight(h),
        trust: () => trustRef.current,
        hasSigner: (pro) => signers.current.has(pro),
        lock: (name, fn) => withLock(name, fn, { signal: ac.signal }),
        live: () => live,
      });
      sched = current;
      postHeldRef.current = current.postHeld;
      show(loaded);
      // one scheduler per identity in this browser: the other tabs wait for the lock
      await withLock(
        `${lockBase}-scheduler`,
        async () => {
          while (live) {
            let wait = TICK_MS;
            try {
              wait = await current.tick();
            } catch {
              /* Platform not reachable or signed out: next tick */
            }
            await sleep(wait);
          }
        },
        { signal: ac.signal },
      );
    })().catch(() => undefined);
    // another tab saved: show its jobs
    const onStorage = (e: StorageEvent) => {
      if (authSession && e.key === jobStorageKey(`${ownerId}.${authSession.auth.keyId}`)) void store?.load().then(show, () => undefined);
    };
    globalThis.addEventListener?.('storage', onStorage);
    return () => {
      live = false;
      ac.abort();
      offWrite();
      globalThis.removeEventListener?.('storage', onStorage);
    };
  }, [deps, session, authSession, reader, net]);

  const requestBadge = useCallback<BadgeCtx['requestBadge']>(
    async (voting, proTxHash, opts = {}) => {
      const commit = commitRef.current;
      if (storeError) throw new Error(storeError);
      if (!deps || !reader || !commit) throw new Error(mode === 'live' ? 'Sign in to request a badge.' : 'Badges need live data (Settings).');
      const issuer = opts.issuer ?? trust.find((t) => t.enabled);
      if (!issuer) throw new Error('Your trust list has no enabled issuer.');
      const height = await reader.coreHeight();
      const job = await createJob(deps, jobsRef.current, voting, proTxHash, height, { issuer, mode: opts.mode ?? privacy, ...(opts.keepKey !== undefined ? { keepKey: opts.keepKey } : {}), ...(opts.epoch !== undefined ? { epoch: opts.epoch } : {}) });
      await commit((latest) => {
        if (latest.some((j) => j.issuer.identityId === job.issuer.identityId && j.epoch === job.epoch && (j.state === 'scheduled' || j.state === 'token' || j.state === 'posted'))) throw new Error('Another tab already requested this badge.');
        return [...latest, job];
      });
      if (job.mode === 'standard') wakeRef.current();
      return job;
    },
    [deps, reader, trust, mode, storeError, privacy],
  );

  const registerVotingSigner = useCallback((proTxHash: string, signer: VotingSigner) => {
    const k = proTxHash.toLowerCase();
    signers.current.set(k, signer);
    return () => {
      if (signers.current.get(k) === signer) signers.current.delete(k);
    };
  }, []);

  const removeJob = useCallback(async (id: string) => {
    const commit = commitRef.current;
    if (!commit) throw new Error('Your badge requests are not loaded in this tab (sign in again).');
    await commit((latest) => latest.filter((j) => j.id !== id));
  }, []);
  const registerNow = useCallback(async (id: string) => {
    const post = postHeldRef.current;
    if (!post) throw new Error('Your badge requests are not loaded in this tab (sign in again).');
    await post({ id, force: true });
  }, []);
  const retryJob = useCallback(
    (id: string) =>
      void commitRef.current?.((latest) => latest.map((j) => (j.id === id && isActive(j) ? { ...j, retryAt: undefined } : j))).then(
        () => wakeRef.current(),
        () => undefined,
      ),
    [],
  );

  const { requestWait, postWait } = visit;
  const value = useMemo<BadgeCtx>(
    () => ({ contractId, trust, setTrust, resetTrust, reader, jobs, coreHeight, requestBadge, registerVotingSigner, removeJob, retryJob, registerNow, requestWait, postWait, privacy, setPrivacy }),
    [contractId, trust, setTrust, resetTrust, reader, jobs, coreHeight, requestBadge, registerVotingSigner, removeJob, retryJob, registerNow, requestWait, postWait, privacy, setPrivacy],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {/* only while a request's cooldown runs AND a write now would undo something: rare, and a nudge */}
      {postWait > 0 && separationAtStake(jobs) && (
        <p className="badge-visit-note" role="status" data-testid="badge-visit-note">
          {cooldownNote(postWait)}
        </p>
      )}
    </Ctx.Provider>
  );
}

/** Verified badges of `authors` from the trusted issuers, and whether any badge is live (the "MN owners" filter means something). */
export function useBadges(authors: readonly string[]): { byOwner: Map<string, string[]>; live: boolean; loading: boolean } {
  const ctx = useContext(Ctx);
  const reader = ctx?.reader ?? null;
  const key = useMemo(() => [...new Set(authors)].sort().join(','), [authors]);
  const [state, setState] = useState<{ byOwner: Map<string, string[]>; live: boolean; loading: boolean }>({ byOwner: new Map(), live: false, loading: !!reader });
  useEffect(() => {
    if (!reader) return setState({ byOwner: new Map(), live: false, loading: false });
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    (async () => {
      const height = await reader.coreHeight();
      const [view, isLive] = await Promise.all([key ? reader.badgesFor(key.split(','), height) : Promise.resolve({ byOwner: new Map<string, string[]>() }), reader.live(height)]);
      if (live) setState({ byOwner: view.byOwner, live: isLive, loading: false });
    })().catch(() => live && setState({ byOwner: new Map(), live: false, loading: false }));
    return () => {
      live = false;
    };
  }, [reader, key]);
  return state;
}
