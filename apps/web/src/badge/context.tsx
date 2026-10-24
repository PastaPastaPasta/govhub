// Badge state shared by every page: the trust list, the reader (badges next to authors, the "MN owners" filter), and the badge
// client (requestBadge for the keyring or the key-paste form, and the scheduler that finishes requests and posts badges).
//
// The scheduler (review H1/N1, M3): one per identity across tabs (Web Locks), every change merged into the latest stored jobs under
// a store lock, and token requests kept COOLDOWN_MS away from any Platform write from this browser and from each other (visit.ts),
// so the issuer's view of a request and the public view of this identity's writes do not line up.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clientIssuanceWindow, clientPostingWindow, displayWindow, EPOCH_PARAMS, resumeDelayMs } from '@govhub/badge';
import { signMessageWif } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import type { AppAuthSession } from '../session/authSession.ts';
import { BADGE_NETWORKS, loadTrustList, resetTrustList, saveTrustList, type TrustedIssuer } from './config.ts';
import { createJob, isActive, renewal, step, type BadgeJob, type ClientDeps, type VotingSigner } from './client.ts';
import { badgeQuery, badgesOfAuthors } from './queries.ts';
import { createBadgeReader, type BadgeReader } from './reader.ts';
import { deriveStoreKey, encryptedJobStore, jobStorageKey, memoryJobStore, type JobStore } from './store.ts';
import { mayPost, mayRequest, noteRequestSent, onVisitChange, requestCooldownLeft } from './visit.ts';
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
   * scheduled; it is sent later, at a random height in the issuance window, in a visit without public writes of this identity.
   */
  requestBadge(voting: string | VotingSigner, proTxHash: string, opts?: { issuer?: TrustedIssuer; keepKey?: boolean }): Promise<BadgeJob>;
  /** The keyring registers a signer for an MN while it is unlocked; call the returned function to unregister. */
  registerVotingSigner(proTxHash: string, signer: VotingSigner): () => void;
  removeJob(id: string): void;
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

const TICK_MS = 60_000;
type Mutate = (jobs: BadgeJob[]) => BadgeJob[];

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
  // the note shows in every tab while a request's cooldown runs
  const [cooldown, setCooldown] = useState(() => requestCooldownLeft());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(t);
      const left = requestCooldownLeft();
      setCooldown(left);
      if (left > 0) t = setTimeout(update, Math.min(left, 60_000));
    };
    update();
    const off = onVisitChange(update);
    return () => (off(), clearTimeout(t));
  }, []);
  const signers = useRef(new Map<string, VotingSigner>());
  const jobsRef = useRef<BadgeJob[]>([]);
  /** the current effect run's merge-and-save (null while no identity is loaded) */
  const commitRef = useRef<((m: Mutate) => Promise<BadgeJob[]>) | null>(null);
  const authSession = session && 'auth' in session ? (session as AppAuthSession) : null;

  const deps = useMemo<ClientDeps | null>(() => {
    if (!reader || !session) return null;
    return {
      net,
      contractId,
      ownerId: session.identityId,
      issuerKey: (i, e) => reader.key(i, e),
      // anything that reaches an issuer marks this visit (visit.ts)
      worker: ((call) => {
        if (call.kind === 'challenge' || call.kind === 'token') noteRequestSent();
        return badgeWorker(call as never);
      }) as ClientDeps['worker'],
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
        ac.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
      });

    const notBefore = new Map<string, number>();
    let okTicks = 0;
    const tick = async (): Promise<number> => {
      const height = await reader!.coreHeight();
      if (!live || !store) return TICK_MS;
      setCoreHeight(height);
      const p = EPOCH_PARAMS[net];
      const snapshot = await store.load(); // other tabs may have added jobs
      if (!live) return TICK_MS;
      const updates = new Map<string, BadgeJob>();
      const added: BadgeJob[] = [];
      const run = async (j: BadgeJob) => {
        const after = await step(deps, j, height);
        if (JSON.stringify(after) !== JSON.stringify(j)) updates.set(j.id, after);
      };
      // windows that closed: no network involved
      for (const j of snapshot.filter(isActive)) {
        const closed = j.state === 'scheduled' ? height >= clientIssuanceWindow(p, j.epoch).to : height > displayWindow(p, j.epoch).to;
        if (closed) await run(j);
      }
      const due = snapshot.filter((j) => isActive(j) && !updates.has(j.id) && height >= (j.state === 'scheduled' ? j.requestAt : (j.postAt ?? clientPostingWindow(p, j.epoch).from)));
      // A due action found on the first tick of a visit waits a random 30 s - 10 min, so it is not tied to the page load (L1: the
      // first SUCCESSFUL tick).
      for (const j of due) {
        if (notBefore.has(j.id)) continue;
        const end = j.state === 'scheduled' ? clientIssuanceWindow(p, j.epoch).to : clientPostingWindow(p, j.epoch).to;
        const leftMs = Math.max(0, end - height) * 150_000;
        notBefore.set(j.id, Date.now() + (okTicks === 0 ? resumeDelayMs(Math.min(600_000, leftMs / 2)) : 0));
      }
      const ready = due.filter((j) => Date.now() >= notBefore.get(j.id)!);
      // only requests that can actually go out now (trusted issuer, a signer): one that would wait must not hold up posts (N2)
      const requests = ready
        .filter((j) => j.state === 'scheduled' && deps.trusted(j.issuer.identityId) && (j.signer.kind === 'wif' || signers.current.has(j.proTxHash)))
        .sort((a, b) => clientIssuanceWindow(p, a.epoch).to - clientIssuanceWindow(p, b.epoch).to);
      const posts = ready.filter((j) => j.state === 'token');
      // H1/N1: one token request (the one whose window closes first) only when no write and no other request happened in this
      // browser for the cooldown; posts only once the cooldown after the last request is over. The rest waits.
      if (requests.length && mayRequest()) await run(requests[0]!);
      else if (posts.length && mayPost()) for (const j of posts) await run(j);
      if (!live) return TICK_MS;
      // renewals: create the next epoch's job (no network to the issuer; blinding only)
      const current = () => snapshot.map((j) => updates.get(j.id) ?? j).concat(added);
      for (const j of current()) {
        const issuer = trustRef.current.find((t) => t.identityId === j.issuer.identityId && t.enabled);
        if (!issuer) continue;
        const r = await renewal(deps, current(), j, height, issuer);
        if (r) {
          updates.set(j.id, { ...j, signer: { kind: 'external' }, proTxHash: '' }); // the key and the MN move to the renewal job
          added.push(r);
        }
      }
      if (!live) return TICK_MS;
      const keepFrom = Math.floor(height / (p.superblockCycle * p.epochCycles)) - 2;
      await commit((latest) => {
        // a renewal made from an older snapshot must not duplicate a job added meanwhile for the same issuer and epoch (N11)
        const fresh = added.filter((a) => !latest.some((j) => j.id === a.id || (j.issuer.identityId === a.issuer.identityId && j.epoch === a.epoch && j.state !== 'failed' && j.state !== 'expired')));
        const merged = latest.map((j) => updates.get(j.id) ?? j).concat(fresh);
        return merged.filter((j) => isActive(j) || j.epoch >= keepFrom);
      });
      okTicks++;
      return due.some((j) => !updates.has(j.id)) ? 15_000 : TICK_MS;
    };

    (async () => {
      // one store per (identity, signing key): the store key comes from the key, so another key of the same identity has its own
      const s = authSession ? encryptedJobStore(`${ownerId}.${authSession.auth.keyId}`, ownerId, await deriveStoreKey(authSession.auth.privateKey, ownerId)) : memoryJobStore();
      const loaded = await s.load(); // throws when stored data does not decrypt: then nothing is ever saved over it (N5)
      if (!live) return;
      store = s;
      commitRef.current = commit;
      show(loaded);
      // one scheduler per identity in this browser: the other tabs wait for the lock
      await withLock(
        `${lockBase}-scheduler`,
        async () => {
          while (live) {
            let wait = TICK_MS;
            try {
              wait = await tick();
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
      globalThis.removeEventListener?.('storage', onStorage);
    };
  }, [deps, session, authSession, reader, net]);

  const requestBadge = useCallback<BadgeCtx['requestBadge']>(
    async (voting, proTxHash, opts = {}) => {
      const commit = commitRef.current;
      if (!deps || !reader || !commit) throw new Error(mode === 'live' ? 'Sign in to request a badge.' : 'Badges need live data (Settings).');
      const issuer = opts.issuer ?? trust.find((t) => t.enabled);
      if (!issuer) throw new Error('Your trust list has no enabled issuer.');
      const height = await reader.coreHeight();
      const job = await createJob(deps, jobsRef.current, voting, proTxHash, height, { issuer, ...(opts.keepKey !== undefined ? { keepKey: opts.keepKey } : {}) });
      await commit((latest) => {
        if (latest.some((j) => j.issuer.identityId === job.issuer.identityId && j.epoch === job.epoch && (j.state === 'scheduled' || j.state === 'token' || j.state === 'posted'))) throw new Error('Another tab already requested this badge.');
        return [...latest, job];
      });
      return job;
    },
    [deps, reader, trust, mode],
  );

  const registerVotingSigner = useCallback((proTxHash: string, signer: VotingSigner) => {
    const k = proTxHash.toLowerCase();
    signers.current.set(k, signer);
    return () => {
      if (signers.current.get(k) === signer) signers.current.delete(k);
    };
  }, []);

  const removeJob = useCallback((id: string) => void commitRef.current?.((latest) => latest.filter((j) => j.id !== id)).catch(() => undefined), []);

  const value = useMemo<BadgeCtx>(
    () => ({ contractId, trust, setTrust, resetTrust, reader, jobs, coreHeight, requestBadge, registerVotingSigner, removeJob }),
    [contractId, trust, setTrust, resetTrust, reader, jobs, coreHeight, requestBadge, registerVotingSigner, removeJob],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {cooldown > 0 && (
        <p className="badge-visit-note" role="status" data-testid="badge-visit-note">
          A masternode badge request went to an issuer from this browser in the last half hour. Posting, commenting or reacting from your identity now could let the issuer
          link the two; wait {Math.ceil(cooldown / 60_000)} min.
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
