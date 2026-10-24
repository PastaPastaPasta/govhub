// Badge state shared by every page: the trust list, the reader (badges next to authors, the "MN owners" filter), and the badge
// client (requestBadge for the keyring or the key-paste form, and the scheduler that finishes requests and posts badges).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clientIssuanceWindow, clientPostingWindow, EPOCH_PARAMS, resumeDelayMs } from '@govhub/badge';
import { signMessageWif } from '@govhub/verify';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import type { AppAuthSession } from '../session/authSession.ts';
import { BADGE_NETWORKS, loadTrustList, resetTrustList, saveTrustList, type TrustedIssuer } from './config.ts';
import { createJob, isActive, renewal, step, type BadgeJob, type ClientDeps, type VotingSigner } from './client.ts';
import { badgeQuery, badgesOfAuthors } from './queries.ts';
import { createBadgeReader, type BadgeReader } from './reader.ts';
import { deriveStoreKey, encryptedJobStore, memoryJobStore, type JobStore } from './store.ts';
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
   * Starts a badge request for the signed-in identity: `voting` is the MN voting key as WIF (kept encrypted with the job), or a
   * signer (the keyring), which must be registered with registerVotingSigner when the request runs. Resolves once the request is
   * scheduled; it is sent later, at a random height in the issuance window.
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

export function BadgeProvider({ children }: { children: ReactNode }) {
  const { registry, mode } = useApp();
  const { session } = useForum();
  const net = registry.platformNetwork;
  const contractId = BADGE_NETWORKS[net].contractId;
  const [trust, setTrustState] = useState<TrustedIssuer[]>(() => loadTrustList(net));
  useEffect(() => setTrustState(loadTrustList(net)), [net]);
  const setTrust = useCallback((list: TrustedIssuer[]) => (saveTrustList(net, list), setTrustState(list)), [net]);
  const resetTrust = useCallback(() => setTrustState(resetTrustList(net)), [net]);

  const reader = useMemo(() => (mode === 'live' && contractId ? createBadgeReader(registry, contractId, trust) : null), [mode, contractId, registry, trust]);

  const [jobs, setJobs] = useState<BadgeJob[]>([]);
  const [coreHeight, setCoreHeight] = useState<number | null>(null);
  const signers = useRef(new Map<string, VotingSigner>());
  const storeRef = useRef<JobStore | null>(null);
  const jobsRef = useRef<BadgeJob[]>([]);
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
    };
  }, [reader, session, net, contractId, registry]);

  const commit = useCallback(async (next: BadgeJob[]) => {
    jobsRef.current = next;
    setJobs(next);
    await storeRef.current?.save(next);
  }, []);

  // Load this identity's jobs (decrypting with a key derived from its signing key), then run the scheduler.
  useEffect(() => {
    let live = true;
    jobsRef.current = [];
    setJobs([]);
    storeRef.current = null;
    if (!deps || !session) return;
    const notBefore = new Map<string, number>();
    let ticks = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      storeRef.current = authSession ? encryptedJobStore(session.identityId, await deriveStoreKey(authSession.auth.privateKey, session.identityId)) : memoryJobStore();
      const loaded = await storeRef.current.load();
      if (!live) return;
      jobsRef.current = loaded;
      setJobs(loaded);
      const tick = async () => {
        if (!live) return;
        try {
          const height = await reader!.coreHeight();
          setCoreHeight(height);
          const p = EPOCH_PARAMS[net];
          let next = [...jobsRef.current];
          let changed = false;
          for (let i = 0; i < next.length; i++) {
            const j = next[i]!;
            if (!isActive(j)) continue;
            const dueAt = j.state === 'scheduled' ? j.requestAt : (j.postAt ?? clientPostingWindow(p, j.epoch).from);
            if (height < dueAt) continue;
            // A due action found right after the app opened waits a random 30 s - 10 min, so it is not tied to the page load.
            if (!notBefore.has(j.id)) {
              const end = j.state === 'scheduled' ? clientIssuanceWindow(p, j.epoch).to : clientPostingWindow(p, j.epoch).to;
              const leftMs = Math.max(0, end - height) * 150_000;
              notBefore.set(j.id, Date.now() + (ticks === 0 ? resumeDelayMs(Math.min(600_000, leftMs / 2)) : 0));
            }
            if (Date.now() < notBefore.get(j.id)!) continue;
            const after = await step(deps, j, height);
            if (JSON.stringify(after) !== JSON.stringify(j)) {
              next[i] = after;
              changed = true;
            }
          }
          for (const j of [...next]) {
            const issuer = trust.find((t) => t.identityId === j.issuer.identityId && t.enabled);
            if (!issuer) continue;
            const r = await renewal(deps, next, j, height, issuer);
            if (r) {
              next = next.map((x) => (x.id === j.id ? { ...x, signer: { kind: 'external' as const } } : x)).concat(r);
              changed = true;
            }
          }
          // keep finished jobs of the last few epochs for the status list, drop older ones
          const keepFrom = Math.floor(height / (p.superblockCycle * p.epochCycles)) - 2;
          const pruned = next.filter((j) => isActive(j) || j.epoch >= keepFrom);
          if (changed || pruned.length !== next.length) await commit(pruned);
        } catch {
          /* Platform not reachable: next tick */
        } finally {
          ticks++;
          if (live) timer = setTimeout(tick, notBefore.size ? 15_000 : TICK_MS);
        }
      };
      void tick();
    })().catch(() => undefined);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [deps, session, authSession, reader, net, trust, commit]);

  const requestBadge = useCallback<BadgeCtx['requestBadge']>(
    async (voting, proTxHash, opts = {}) => {
      if (!deps || !reader) throw new Error(mode === 'live' ? 'Sign in to request a badge.' : 'Badges need live data (Settings).');
      const issuer = opts.issuer ?? trust.find((t) => t.enabled);
      if (!issuer) throw new Error('Your trust list has no enabled issuer.');
      const height = await reader.coreHeight();
      const job = await createJob(deps, jobsRef.current, voting, proTxHash, height, { issuer, ...(opts.keepKey !== undefined ? { keepKey: opts.keepKey } : {}) });
      await commit([...jobsRef.current, job]);
      return job;
    },
    [deps, reader, trust, mode, commit],
  );

  const registerVotingSigner = useCallback((proTxHash: string, signer: VotingSigner) => {
    const k = proTxHash.toLowerCase();
    signers.current.set(k, signer);
    return () => {
      if (signers.current.get(k) === signer) signers.current.delete(k);
    };
  }, []);

  const removeJob = useCallback((id: string) => void commit(jobsRef.current.filter((j) => j.id !== id)), [commit]);

  const value = useMemo<BadgeCtx>(
    () => ({ contractId, trust, setTrust, resetTrust, reader, jobs, coreHeight, requestBadge, registerVotingSigner, removeJob }),
    [contractId, trust, setTrust, resetTrust, reader, jobs, coreHeight, requestBadge, registerVotingSigner, removeJob],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
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
