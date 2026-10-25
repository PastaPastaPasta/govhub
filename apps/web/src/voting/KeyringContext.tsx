// Masternode keyring and voting state (PLAN §5.1-5.2): "add my masternodes" once, sign in again later and they are back.
//
// Keys live in this tab's memory while the keyring is open. Saved keyrings are encrypted in the browser (@govhub/auth keyring) to
// the recovery phrase and the user's passkeys and stored in `forum.keyring`; the operator only ever sees ciphertext. A seed sign-in
// opens it at once, a passkey sign-in with the same ceremony; a pasted-key session cannot open it (memory-only keys still work).
// After the idle timeout the keys are wiped and the keyring has to be unlocked again (passkey or phrase).
//
// Session safety: every async path captures `sessionToken()` (session generation, identity, Core network, mode) and checks it before
// it opens, writes or keeps anything; sign-out wipes the keys synchronously (session/end.ts), before React re-renders.
//
// Fixture mode opens a memory-only demo keyring on sign-in and talks to the pretend relays and bridge of voting/sim.ts.
import {
  addUnlocker,
  DEFAULT_IDLE_LOCK_MINUTES,
  emptyKeyring,
  hexToBytes,
  identifierBytes,
  KeyringLockedError,
  KEYS_CAPS,
  loadKeyring,
  localRecordKey,
  passkeyUnlockKey,
  PENDING_CAPS,
  prfInput,
  removeUnlocker,
  savePending,
  saveKeys,
  seedUnlockKey,
  seedUnlockKeyFromEntropy,
  SeedWallet,
  type KeyringContext as StoreCtx,
  type OpenedKeyring,
  type UnlockKey,
} from '@govhub/auth';
import { getPasskeyPrf } from '@govhub/auth/webauthn';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { useAuth } from '../auth/context.tsx';
import { errorText, getPlatformPort, rpId } from '../auth/runtime.ts';
import { enabledBridges } from '../config/registry.ts';
import { BridgeError, HttpBridge, type Bridge, type BridgeVotes } from '../data/bridge.ts';
import { createWebDapi, dapiConfig } from '../data/dapi.ts';
import { fixtureMnKey } from '../data/fixtureVotes.ts';
import { getSdk } from '../data/platform.ts';
import { onSessionEnd } from '../session/end.ts';
import { assertCanWrite, topUpFromError, TopUpError } from './funds.ts';
import { castKeys, KeyringLock, ownerOf } from './gate.ts';
import { lookupMasternodes, type LookupDeps, type LookupResult, type LookupStep } from './lookup.ts';
import { keyRole, parseVotingKey, proveCollaterals, votingAddressOf, votingKeyId, type OwnedMasternode } from './masternodes.ts';
import {
  bridgeVerdict,
  fromPending,
  isOpen,
  isTracked,
  loadWatched,
  loadWatchedSealed,
  mergeWatched,
  needsRebroadcast,
  pendingBackup,
  pickRebroadcastRelay,
  pruneWatched,
  removePlainWatched,
  saveWatchedSealed,
  sendDue,
  sendRetryDelay,
  watchedScope,
  type WatchedVote,
} from './pending.ts';
import { currentKey, deferredWindow, mnId, planDeferred, planImmediate, signPlanned, submitDelays, voteFields, type CurrentVote, type Intent, type PlanResult } from './plan.ts';
import { cancelSignature, normalizeRelayUrl, RelayClient, RelayError, type RelayHealth, type RelayVoteState } from './relay.ts';
import { withdrawVote, WithdrawError, type WithdrawResult } from './withdraw.ts';
import { DEMO_KEYS, SIM_RELAYS, simScenario, VoteSim, type RelayPort } from './sim.ts';
import { applyRelayState, classifySubmitError } from './status.ts';
import { clearStash, KEYRING_STASH_EVENT, takeStash } from './stash.ts';
import { bytesEqual, bytesToHex, countVotes, governanceVoteHash, normalizeMnId, p2pkhAddress, recoverVoteSigner, verifyVoteSignature, VOTE_MAX_FUTURE_S, type OutcomeCounts } from '@govhub/verify';

export type KeyringStatus = 'signed-out' | 'checking' | 'absent' | 'locked' | 'open' | 'error';

export interface MnState extends LookupResult {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  step?: LookupStep;
  error?: string;
  /** unix ms the current lookup started */
  startedAt?: number;
  /** the voting key ids this result is for */
  forKeys: string;
}

export interface CastOptions {
  mode: 'now' | 'deferred';
  /** deferred: unix seconds; the window ends at min(this, deadline - margin) */
  latest?: number;
  /** backup of held votes in the encrypted PENDING document (deferred only) */
  backupOnPlatform?: boolean;
  /** the user confirmed re-sending votes equal to the current ones (it only moves the timestamp) */
  resend?: boolean;
}

/** "Check it yourself": one vote re-verified here, step by step. */
export interface VoteProof {
  checks: Array<{ label: string; ok: boolean | null; detail: string }>;
}

interface Ctx {
  status: KeyringStatus;
  error: string | null;
  /** the error is "not enough credits for a keyring write": offer a top-up */
  needsTopUp: boolean;
  /** fixture mode: a demo keyring with synthetic masternodes, pretend relays */
  demo: boolean;
  /** the session can open a Platform keyring (seed or passkey); a pasted key cannot */
  canUsePlatform: boolean;
  memoryOnly: boolean;
  keyring: OpenedKeyring | null;
  busy: string | null;
  mns: MnState;
  watched: WatchedVote[];
  coreNetwork: 'mainnet' | 'testnet';
  relays: string[];
  relayHealth: Record<string, RelayHealth>;
  /** votes that reached the network while this page was open, newest last (the success card) */
  celebrations: string[];
  dismissCelebration(voteHash: string): void;
  bridgeBase: string | null;
  /** unlock / create */
  unlockWithPasskey(): Promise<void>;
  unlockWithPhrase(phrase: string): Promise<void>;
  createKeyring(memoryOnly: boolean): Promise<void>;
  lock(): void;
  /**
   * keys and labels; addKey resolves with the new key's id. The key is checked against the masternode list first: collateral and
   * payout keys are refused; a key that votes for no masternode only with `force` (KeyCheckError.canForce).
   */
  addKey(input: string, label: string, opts?: { force?: boolean }): Promise<string>;
  removeKey(index: number): Promise<void>;
  setNodeLabel(proTxHash: string, label: string): Promise<void>;
  setIdleMinutes(m: number): Promise<void>;
  addPasskeyUnlocker(): Promise<void>;
  removeUnlockerKey(recipientKey: Uint8Array): Promise<void>;
  saveToPlatform(): Promise<void>;
  /** the opened keyring could be planted or replayed: saving waits until the user confirms its unlockers */
  needsConfirm: boolean;
  confirmUnlockers(): void;
  refreshMasternodes(): void;
  /** voting */
  currentVotes(govHashes: string[]): Promise<Map<string, CurrentVote>>;
  cast(intents: Intent[], opts: CastOptions, deadline: number | null, current: Map<string, CurrentVote>): Promise<PlanResult>;
  cancel(voteHash: string): Promise<void>;
  /** sends queued votes now and re-checks the relays (no backoff wait) */
  retryNow(): void;
  /** offline: submit a signature made elsewhere for a planned vote */
  submitSigned(v: Omit<WatchedVote, 'refs' | 'status' | 'rebroadcasts'>): Promise<void>;
  verifyVote(voteHash: string): Promise<VoteProof>;
}

const C = createContext<Ctx | null>(null);

export function useKeyring(): Ctx {
  const c = useContext(C);
  if (!c) throw new Error('useKeyring outside KeyringProvider');
  return c;
}

const nowS = () => Math.floor(Date.now() / 1000);
/** Spacing of immediate votes after the first ten: stays under a relay's default 30 requests per minute per IP. */
const IMMEDIATE_PACE_MS = 2500;
/** A relay health check is reused this long. */
const HEALTH_TTL_MS = 60_000;
/** Watchdog: fast while something is about to change, slower otherwise; each quiet tick stretches the wait (up to x4). */
const TICK_FAST_MS = 4000;
const TICK_SLOW_MS = 20_000;
/**
 * Deferred batches: random delays (so a relay does not see the batch as one burst) that still respect the same pacing: after the
 * first ten requests, at least IMMEDIATE_PACE_MS apart. Returned in submission order's terms (index i = vote i).
 */
export function pacedRandomDelays(n: number): number[] {
  // spread: up to 30 s for small batches; larger ones only a little longer than the pacing itself needs
  const raw = submitDelays(n, n <= 10 ? Math.min(30_000, 2000 * n) : Math.round((n - 10) * IMMEDIATE_PACE_MS * 1.2) + 20_000);
  const order = raw.map((_, i) => i).sort((a, b) => raw[a]! - raw[b]!);
  const out = raw.slice();
  order.forEach((idx, k) => {
    if (k >= 10) out[idx] = Math.max(out[idx]!, out[order[k - 1]!]! + IMMEDIATE_PACE_MS);
  });
  return out;
}
/** Highest keyring generation this browser has opened or written (public: a counter), to notice a replayed older document. */
const generationKey = (platformNetwork: string, ownerId: string) => `govhub.keyring.generation.${platformNetwork}.${ownerId}`;
const EMPTY_MNS: MnState = { phase: 'idle', owned: [], missing: [], mismatch: [], smlNodes: 0, forKeys: '' };

/** Async work whose session ended (sign-out, another identity or network) meanwhile: it stopped and kept nothing. */
export class SessionChangedError extends Error {
  constructor() {
    super('The session changed meanwhile; nothing was kept.');
    this.name = 'SessionChangedError';
  }
}

/** A pasted key refused by the masternode-list check. `canForce`: it may be added anyway (it votes for no known masternode). */
export class KeyCheckError extends Error {
  constructor(
    message: string,
    readonly canForce: boolean,
  ) {
    super(message);
    this.name = 'KeyCheckError';
  }
}

const LOCKED_SAVE = 'Your saved keyring is locked. Unlock it with your recovery phrase or a passkey first, then add these keys there.';

/** Weighted counts after replacing `prev` (or nothing) with `outcome` for a masternode of `weight`, run backwards for "before". */
function tallyBefore(after: OutcomeCounts, outcome: number, weight: number, prev: number | undefined): OutcomeCounts {
  const k = (o: number) => (o === 1 ? 'yes' : o === 2 ? 'no' : o === 3 ? 'abstain' : null);
  const b = { ...after };
  const now = k(outcome);
  if (now) b[now] = Math.max(0, b[now] - weight);
  const was = prev !== undefined ? k(prev) : null;
  if (was) b[was] += weight;
  return b;
}

export function KeyringProvider({ children }: { children: ReactNode }) {
  const { registry, mode } = useApp();
  const auth = useAuth();
  const session = auth.session;
  const demo = mode === 'fixtures';
  const sim = useMemo(() => (demo ? new VoteSim(simScenario(location.search)) : null), [demo]);
  const coreNetwork = demo ? 'mainnet' : registry.coreNetwork;
  const relays = useMemo(() => (demo ? SIM_RELAYS : registry.relays.map((r) => normalizeRelayUrl(r.url)).filter(Boolean)), [registry.relays, demo]);
  const relayFor = useCallback((url: string): RelayPort => (sim ? sim.relay(url) : new RelayClient(url)), [sim]);
  const [status, setStatus] = useState<KeyringStatus>('signed-out');
  const [error, setError] = useState<string | null>(null);
  const [needsTopUp, setNeedsTopUp] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [memoryOnly, setMemoryOnly] = useState(false);
  const [keyring, setKeyring] = useState<OpenedKeyring | null>(null);
  const [version, setVersion] = useState(0); // bump to re-render after in-place keyring edits
  const [mns, setMns] = useState<MnState>(EMPTY_MNS);
  const [mnNonce, setMnNonce] = useState(0);
  const [watched, setWatchedState] = useState<WatchedVote[]>([]);
  const [relayHealth, setRelayHealth] = useState<Record<string, RelayHealth>>({});
  const healthRef = useRef<Record<string, RelayHealth>>({});
  const [celebrations, setCelebrations] = useState<string[]>([]);
  /** The keyring could be planted or replayed (not authenticated by this seed, or older than one seen here): saving waits for the user. */
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const kr = useRef<OpenedKeyring | null>(null);
  kr.current = keyring;
  const mnsRef = useRef(mns);
  mnsRef.current = mns;
  const watchedRef = useRef<WatchedVote[]>([]);
  /** a cast or cancel is changing votes: the watchdog does not re-send meanwhile */
  const castingRef = useRef(false);
  /** watchdog re-sends in flight, by vote hash: a cancel waits for them, so it also reaches the relay just sent to */
  const inflightRef = useRef(new Map<string, Promise<unknown>>());
  /** wakes the watchdog now (after a cast, Retry now) */
  const kickRef = useRef<() => void>(() => {});
  /** The ref is the single source of truth for watched votes (async code reads it); the state only re-renders. */
  const setWatched = useCallback((next: WatchedVote[]) => {
    watchedRef.current = next;
    setWatchedState(next);
  }, []);
  // fixture mode signs in to sample identities (app sessions without @govhub/auth behind them): the demo keyring follows those
  const appSession = useForum().session;
  const identityId = (demo ? appSession?.identityId : session?.identityId) ?? null;
  /** The identity signed in NOW: async work started for another identity (a cast, a re-send) must not write into this one's votes. */
  const identityRef = useRef(identityId);
  identityRef.current = identityId;
  const netRef = useRef(coreNetwork);
  netRef.current = coreNetwork;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  /** Bumped synchronously when the session ends or is replaced (session/end.ts). */
  const genRef = useRef(0);
  /**
   * The session this work belongs to: generation, identity, Core network and mode. Async keyring work captures it when it starts and
   * opens, writes or keeps nothing once it differs (D-004 sign-out or identity switch, D-016 profile switch).
   */
  const sessionToken = useCallback(() => `${genRef.current}|${identityRef.current ?? ''}|${netRef.current}|${modeRef.current}`, []);
  /** The key the watched votes are stored under, sealed to the keyring (D-027); kept while the session lasts, locked or not. */
  const storeKeyRef = useRef<{ key: Uint8Array; scope: string } | null>(null);
  const dropStoreKey = useCallback(() => {
    storeKeyRef.current?.key.fill(0);
    storeKeyRef.current = null;
  }, []);
  /** The session in which the saved keyring was locked (button or idle): only the phrase or a passkey reopens it (D-015). */
  const lockRef = useRef(new KeyringLock());
  const touch = () => setVersion((v) => v + 1);

  // Sign-out or identity switch: the keys are wiped NOW, before React re-renders (and before a bfcache freeze on pagehide, D-025)
  useEffect(
    () =>
      onSessionEnd((next) => {
        genRef.current++;
        kr.current?.close();
        kr.current = null;
        // the next render must not read the wiped keys (they are zero now): the keyring is gone with the session
        setKeyring(null);
        setMns(EMPTY_MNS);
        clearStash(next);
        dropStoreKey();
        watchedRef.current = [];
        lockRef.current.unlock();
      }),
    [dropStoreKey],
  );

  useEffect(() => {
    if (!sim) return;
    (globalThis as { __voteSim?: unknown }).__voteSim = sim.controls();
    return () => void delete (globalThis as { __voteSim?: unknown }).__voteSim;
  }, [sim]);

  const storeCtx = useCallback(async (): Promise<StoreCtx> => {
    const [evo, sdk, port, { createEvoKeyringStore }] = await Promise.all([import('@dashevo/evo-sdk'), getSdk(registry), getPlatformPort(registry), import('@govhub/auth/keyring-evo')]);
    return { store: createEvoKeyringStore(evo, sdk, port, registry.forum.contractId), contractId: registry.forum.contractId };
  }, [registry]);

  const bridgeEndpoint = enabledBridges(registry)[0] ?? null;
  const bridge = useMemo<Bridge | null>(() => (sim ? sim.bridge : bridgeEndpoint ? new HttpBridge(bridgeEndpoint.name, bridgeEndpoint.httpBase) : null), [sim, bridgeEndpoint?.name, bridgeEndpoint?.httpBase]);
  const dapi = useMemo(() => (mode === 'live' ? createWebDapi(dapiConfig(registry)) : null), [registry, mode]);
  const lookupDeps = useMemo<LookupDeps | null>(
    () =>
      bridge && {
        mnlist: () => bridge.mnlist(),
        sml: dapi ? (signal) => dapi.getSml({ signal }) : null,
        rawTx: dapi ? async (txid, signal) => (await dapi.call((core, s) => core.getTransaction(txid, { signal: s }), { signal })).value.raw : null,
        network: coreNetwork,
      },
    [bridge, dapi, coreNetwork],
  );

  /** From now on the watched votes are stored sealed to this (saved) keyring. */
  const keepVotesSealedTo = useCallback(
    (k: OpenedKeyring) => {
      dropStoreKey();
      if (!identityId) return null;
      const scope = watchedScope(registry.platformNetwork, coreNetwork, identityId);
      return (storeKeyRef.current = { key: localRecordKey(k.content.keyringId, scope), scope });
    },
    [identityId, coreNetwork, registry.platformNetwork, dropStoreKey],
  );

  /** Writes the watched votes sealed to the keyring (nothing while no saved keyring was opened in this session). */
  const persistWatched = useCallback(
    (list: readonly WatchedVote[]) => {
      const s = storeKeyRef.current;
      if (s && identityId) saveWatchedSealed(localStorage, coreNetwork, identityId, s.scope, s.key, list);
    },
    [identityId, coreNetwork],
  );

  const close = useCallback(() => {
    kr.current?.close();
    setKeyring(null);
  }, []);

  /** Shows an opened keyring. `t`: the session it was opened for; a stale one is wiped instead (returns false). */
  const opened = useCallback(
    (k: OpenedKeyring, memory: boolean, t: string): boolean => {
      if (sessionToken() !== t) {
        k.close();
        return false;
      }
      kr.current?.close();
      setKeyring(k);
      setMemoryOnly(memory);
      setStatus('open');
      setError(null);
      setNeedsTopUp(false);
      if (demo) {
        setNeedsConfirm(false);
        return true;
      }
      if (!memory) lockRef.current.unlock();
      const gkey = generationKey(registry.platformNetwork, k.ownerId);
      const seen = Number(localStorage.getItem(gkey) ?? 0);
      const rolledBack = !memory && k.content.generation < seen;
      if (!memory && !rolledBack) localStorage.setItem(gkey, String(k.content.generation));
      setNeedsConfirm(!memory && (k.authenticated !== true || rolledBack));
      if (rolledBack) setError(`This keyring is older than one this browser opened before (version ${k.content.generation}, seen ${seen}): someone who held a key of this identity may have put back an old copy. Check the unlockers below before saving anything.`);
      else if (k.authenticated === false) setError('This keyring does not list your recovery phrase as an unlocker. Someone who held a key of this identity may have replaced it: check the unlockers below and remove any you do not recognise before adding keys.');
      if (!identityId) return true;
      // the watched votes: sealed to this keyring on this device (D-027), a plain list left by an earlier version, and the
      // Platform backup (this Core network's only, D-016/D-028)
      let list = watchedRef.current;
      const known = new Set(list.map((x) => x.voteHash));
      const add = (more: WatchedVote[]) => {
        for (const v of more) if (!known.has(v.voteHash)) (known.add(v.voteHash), (list = [...list, v]));
      };
      if (!memory) {
        const { key, scope } = keepVotesSealedTo(k)!;
        add(loadWatchedSealed(localStorage, coreNetwork, identityId, scope, key));
        add(loadWatched(localStorage, coreNetwork, identityId).map((v) => ({ ...v, network: v.network ?? coreNetwork })));
      }
      const keyIds = new Set(k.content.keys.map((x) => votingKeyId(x.privateKey, x.compressed)));
      add(
        k.pending.votes.flatMap((p) => {
          const fields = { collateralTxid: p.collateralTxid, collateralIndex: p.collateralIndex, govHashDisplay: p.govHash, signal: 1, outcome: p.outcome, time: p.time };
          const r = fromPending(p, '', governanceVoteHash(fields));
          if (p.network) return p.network === coreNetwork ? [r] : [];
          // an untagged backup (written before the network tag): this network's when one of our keys signed it for this network
          const signer = recoverVoteSigner(r.sig, fields, coreNetwork);
          return signer && keyIds.has(bytesToHex(signer.keyId)) ? [{ ...r, network: coreNetwork }] : [];
        }),
      );
      const next = pruneWatched(list, nowS());
      if (!memory) {
        persistWatched(next);
        removePlainWatched(localStorage, coreNetwork, identityId);
      }
      setWatched(next);
      return true;
    },
    [identityId, coreNetwork, registry.platformNetwork, setWatched, demo, sessionToken, keepVotesSealedTo, persistWatched],
  );

  const tryOpen = useCallback(
    async (key: UnlockKey, seedCheck: UnlockKey | null, t: string): Promise<'open' | 'absent'> => {
      if (!identityId) throw new Error('Sign in first.');
      const k = await loadKeyring(await storeCtx(), identityId, key, seedCheck);
      if (sessionToken() !== t) {
        k?.close();
        throw new SessionChangedError();
      }
      if (!k) return 'absent';
      opened(k, false, t);
      return 'open';
    },
    [identityId, storeCtx, opened, sessionToken],
  );

  // ---- session changes: open with the seed, or with the passkey ceremony that signed in (fixtures: the demo keyring) ----
  const sessionObj = demo ? appSession : session;
  useEffect(() => {
    const t = sessionToken();
    close();
    dropStoreKey();
    setMns(EMPTY_MNS);
    setError(null);
    setNeedsTopUp(false);
    setMemoryOnly(false);
    setCelebrations([]);
    // signed votes are read when the keyring opens (they are sealed to it)
    setWatched([]);
    if (!identityId || (!demo && !session)) {
      lockRef.current.unlock();
      setStatus('signed-out');
      return;
    }
    if (demo || !session) {
      const k = emptyKeyring(identityId, []);
      for (const d of DEMO_KEYS) k.content.keys.push({ privateKey: fixtureMnKey(d.index).slice(), compressed: true, label: d.label });
      opened(k, true, t);
      setMnNonce((n) => n + 1); // same demo keys for every sample identity: the lookup must still run again
      return;
    }
    const stash = takeStash(identityId);
    // locked in this session (button or idle lock): a profile switch or re-render must not reopen it with the session seed (D-015)
    const locked = lockRef.current.lockedIn(session);
    const seed = locked ? null : seedUnlockKey(session);
    const key = locked ? null : stash?.purpose === 'unlock' ? stash.key : seed;
    if (stash && stash.key !== key) stash.key.wipe(); // a passkey stashed for another purpose: nothing takes it now (D-068)
    if (!key) {
      setStatus('locked');
      return;
    }
    setStatus('checking');
    tryOpen(key, seed, t)
      .then((r) => sessionToken() === t && r === 'absent' && setStatus('absent'))
      .catch((e) => {
        if (sessionToken() !== t) return;
        if (e instanceof KeyringLockedError) setStatus('locked');
        else {
          setStatus('error');
          setError(errorText(e));
        }
      })
      .finally(() => {
        key.wipe();
        if (seed && seed !== key) seed.wipe();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityId, mode, coreNetwork, sessionObj]);

  useEffect(() => () => kr.current?.close(), []);

  /**
   * Locks: wipes the keys. A saved keyring then needs the phrase or a passkey again in this session, whatever happens meanwhile
   * (memory-only keys, "Save encrypted", a profile switch: D-015). A memory-only one is simply gone.
   */
  const lockNow = useCallback(() => {
    close();
    if (!memoryOnly) lockRef.current.lock(session);
    setStatus(lockRef.current.lockedIn(session) ? 'locked' : 'absent');
    setMns(EMPTY_MNS);
  }, [close, memoryOnly, session]);
  const lock = useCallback(() => lockNow(), [lockNow]);

  // ---- idle lock ----
  const idleMinutes = keyring?.content.idleLockMinutes ?? DEFAULT_IDLE_LOCK_MINUTES;
  useEffect(() => {
    if (status !== 'open' || demo) return;
    let last = Date.now();
    const bump = () => (last = Date.now());
    const evs = ['pointerdown', 'keydown', 'scroll'] as const;
    evs.forEach((e) => addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - last > idleMinutes * 60_000) {
        lockNow();
        setError(memoryOnly ? 'The keyring was idle and its memory-only keys were wiped.' : 'The keyring locked itself after being idle. Unlock it again to vote.');
      }
    }, 15_000);
    return () => {
      clearInterval(t);
      evs.forEach((e) => removeEventListener(e, bump));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, idleMinutes, memoryOnly, demo]);

  /** Shows an error, unless it belongs to a session that ended (nobody's business now). */
  const report = useCallback(
    (e: unknown, t: string) => {
      if (sessionToken() !== t) return;
      setError(errorText(e));
      setNeedsTopUp(e instanceof TopUpError);
    },
    [sessionToken],
  );

  const run = useCallback(async <T,>(what: string, fn: () => Promise<T>): Promise<T> => {
    const t = sessionToken();
    setBusy(what);
    setError(null);
    setNeedsTopUp(false);
    try {
      return await fn();
    } catch (e0) {
      const e = topUpFromError(e0);
      report(e, t);
      throw e;
    } finally {
      setBusy(null);
    }
  }, [sessionToken, report]);

  /** Keyring writes are paid from the identity's credits: refused up front when the balance cannot cover one (D-024). */
  const canWrite = useCallback(
    (k: OpenedKeyring) => assertCanWrite(auth.balance, k.content.keys.length <= KEYS_CAPS[1].keys && k.content.labels.length <= KEYS_CAPS[1].labels ? 1 : 2),
    [auth.balance],
  );

  const persist = useCallback(async (target?: OpenedKeyring, unconfirmedOk = false) => {
    const k = target ?? kr.current;
    if (!k || memoryOnly || !session) return;
    if (needsConfirm && !unconfirmedOk) throw new Error('Check the list of unlockers below and confirm it before saving: this keyring could not be verified as yours.');
    canWrite(k);
    await saveKeys(await storeCtx(), session, k);
    localStorage.setItem(generationKey(registry.platformNetwork, k.ownerId), String(k.content.generation));
    auth.refreshBalance();
  }, [memoryOnly, needsConfirm, session, storeCtx, auth, registry.platformNetwork, canWrite]);

  const unlockWithPasskey = useCallback(
    () =>
      run('Unlocking with a passkey', async () => {
        const t = sessionToken();
        const a = await getPasskeyPrf({ rpId: rpId(), prfInput: prfInput(identifierBytes(registry.forum.contractId)) });
        const key = passkeyUnlockKey(a.prfOutput);
        a.prfOutput.fill(0);
        const seed = session ? seedUnlockKey(session) : null;
        try {
          const r = await tryOpen(key, seed, t);
          if (r === 'absent') setStatus('absent');
        } catch (e) {
          if (e instanceof KeyringLockedError) throw new Error('This passkey does not unlock the keyring. Use your recovery phrase, or a passkey that was added while the keyring was open.');
          throw e;
        } finally {
          key.wipe();
          seed?.wipe();
        }
      }),
    [run, registry.forum.contractId, session, tryOpen, sessionToken],
  );

  const unlockWithPhrase = useCallback(
    (phrase: string) =>
      run('Unlocking with the recovery phrase', async () => {
        const t = sessionToken();
        if (!identityId) throw new Error('Sign in first.');
        const w = SeedWallet.fromPhrase(phrase, auth.network);
        const e = w.entropy();
        w.wipe();
        const key = seedUnlockKeyFromEntropy(e, auth.network, identityId);
        e.fill(0);
        try {
          const r = await tryOpen(key, key, t);
          if (r === 'absent') setStatus('absent');
        } catch (err) {
          if (err instanceof KeyringLockedError) throw new Error("That recovery phrase doesn't unlock this identity's keyring.");
          throw err;
        } finally {
          key.wipe();
        }
      }),
    [run, identityId, auth.network, tryOpen, sessionToken],
  );

  const createKeyring = useCallback(
    (memory: boolean) =>
      run(memory ? 'Starting a memory-only keyring' : 'Creating the keyring', async () => {
        const t = sessionToken();
        if (!identityId || !session) throw new Error('Sign in first.');
        if (!memory && lockRef.current.lockedIn(session)) throw new Error(LOCKED_SAVE);
        const k = emptyKeyring(identityId, []);
        if (!memory) {
          const seed = seedUnlockKey(session);
          if (!seed) throw new Error('Saving a keyring needs your recovery phrase in this session (sign in with it, or with a passkey that keeps it). A pasted key cannot open a saved keyring; use memory-only.');
          addUnlocker(k, seed);
          seed.wipe();
          canWrite(k);
          await saveKeys(await storeCtx(), session, k);
          auth.refreshBalance();
        }
        if (!opened(k, memory, t)) throw new SessionChangedError();
      }),
    [run, identityId, session, storeCtx, opened, auth, canWrite, sessionToken],
  );

  /**
   * Every keyring edit is saved from a draft and applied only once the save succeeded, so the page never shows (and the next save
   * never carries) a change that is not on Platform. `unconfirmedOk`: removing unlockers seals to fewer recipients and is allowed
   * before the user confirmed an unverified keyring's unlockers.
   */
  const edit = useCallback(
    (what: string, change: (draft: OpenedKeyring) => void, o: { unconfirmedOk?: boolean; after?(): void; onFail?(): void } = {}) =>
      run(what, async () => {
        const t = sessionToken();
        const k = kr.current;
        if (!k) throw new Error('Open the keyring first.');
        const c = k.content;
        const seen = Number(localStorage.getItem(generationKey(registry.platformNetwork, k.ownerId)) ?? 0);
        // a replayed older keyring is saved ABOVE the highest generation seen here, so the rollback check stays meaningful
        const draft: OpenedKeyring = { ...k, content: { ...c, generation: Math.max(c.generation, seen), unlockers: [...c.unlockers], keys: [...c.keys], labels: [...c.labels] } };
        change(draft);
        try {
          await persist(draft, o.unconfirmedOk);
          if (sessionToken() !== t || kr.current !== k) throw new SessionChangedError();
        } catch (e) {
          o.onFail?.();
          throw e;
        }
        k.content = draft.content;
        k.keysDoc = draft.keysDoc;
        touch();
        o.after?.();
      }),
    [run, persist, registry.platformNetwork, sessionToken],
  );

  /** What a key is, from the masternode list (this key's own lookup), before it is saved anywhere (D-023). */
  const checkKey = useCallback(
    async (privateKey: Uint8Array, compressed: boolean) => {
      if (!lookupDeps) throw new Error('no bridge is configured (Settings)');
      const r = await lookupMasternodes([{ index: 0, keyId: votingKeyId(privateKey, compressed) }], lookupDeps, { signal: new AbortController().signal });
      return keyRole(votingAddressOf(privateKey, compressed, coreNetwork), r.list ?? [], r.owned);
    },
    [lookupDeps, coreNetwork],
  );

  const addKey = useCallback(
    async (input: string, label: string, opts: { force?: boolean } = {}) => {
      const t = sessionToken();
      setError(null);
      setNeedsTopUp(false);
      const k = kr.current;
      if (!k) throw new Error('Open the keyring first.');
      let parsed: { privateKey: Uint8Array; compressed: boolean };
      try {
        parsed = parseVotingKey(input, coreNetwork);
      } catch (e) {
        setError(errorText(e));
        throw e;
      }
      const { privateKey, compressed } = parsed;
      const refuse = (e: Error): never => {
        privateKey.fill(0);
        report(e, t);
        throw e;
      };
      const id = votingKeyId(privateKey, compressed);
      if (k.content.keys.some((x) => votingKeyId(x.privateKey, x.compressed) === id)) refuse(new Error('That voting key is in the keyring already.'));
      if (!memoryOnly && !demo) {
        try {
          canWrite(k);
        } catch (e) {
          refuse(e as Error);
        }
      }
      if (!demo) {
        setBusy('Checking the key against the masternode list');
        let role: Awaited<ReturnType<typeof checkKey>> | { kind: 'error'; message: string };
        try {
          role = await checkKey(privateKey, compressed);
        } catch (e) {
          role = { kind: 'error', message: `The key could not be checked against the masternode list (${errorText(e)}). It was not saved.` };
        } finally {
          setBusy(null);
        }
        if (sessionToken() !== t || kr.current !== k) refuse(new SessionChangedError());
        if (role.kind === 'collateral' || role.kind === 'payout') refuse(new KeyCheckError(role.message, false));
        if ((role.kind === 'none' || role.kind === 'error') && !opts.force) refuse(new KeyCheckError(role.message, true));
      }
      await edit('Adding the voting key', (d) => d.content.keys.push({ privateKey, compressed, label }), { onFail: () => privateKey.fill(0), after: () => setMnNonce((n) => n + 1) });
      return id;
    },
    [edit, coreNetwork, memoryOnly, demo, canWrite, checkKey, sessionToken, report],
  );

  const removeKey = useCallback(
    (index: number) => {
      const gone = kr.current?.content.keys[index];
      return edit('Removing the voting key', (d) => d.content.keys.splice(index, 1), { after: () => (gone?.privateKey.fill(0), setMnNonce((n) => n + 1)) });
    },
    [edit],
  );

  const setNodeLabel = useCallback(
    (proTxHash: string, label: string) =>
      edit('Saving the label', (d) => {
        const others = d.content.labels.filter((l) => l.proTxHash !== proTxHash);
        d.content.labels = label.trim() ? [...others, { proTxHash, label: label.trim() }] : others;
      }),
    [edit],
  );

  const setIdleMinutes = useCallback((m: number) => edit('Saving the idle lock', (d) => void (d.content.idleLockMinutes = m)), [edit]);

  const addPasskeyUnlocker = useCallback(
    async () => {
      if (!kr.current || memoryOnly) throw new Error('Open a saved keyring first.');
      let a;
      try {
        a = await getPasskeyPrf({ rpId: rpId(), prfInput: prfInput(identifierBytes(registry.forum.contractId)) });
      } catch (e) {
        setError(errorText(e));
        throw e;
      }
      const key = passkeyUnlockKey(a.prfOutput);
      a.prfOutput.fill(0);
      try {
        await edit('Adding a passkey unlocker', (d) => {
          if (!addUnlocker(d, key)) throw new Error('This passkey already unlocks the keyring.');
        });
      } finally {
        key.wipe();
      }
    },
    [edit, memoryOnly, registry.forum.contractId],
  );

  const removeUnlockerKey = useCallback((recipientKey: Uint8Array) => edit('Removing the unlocker', (d) => removeUnlocker(d, recipientKey), { unconfirmedOk: true }), [edit]);

  /** "These are mine": saves the keyring as it is now (its unlockers), which also records its generation here. */
  const confirmUnlockers = useCallback(
    () =>
      edit('Saving the confirmed unlockers', () => {}, { unconfirmedOk: true, after: () => (setNeedsConfirm(false), setError(null)) }).catch(() => {}),
    [edit],
  );

  // a passkey added (Passkeys.tsx) while the keyring is open becomes an unlocker
  useEffect(() => {
    const on = () => {
      if (!identityId) return;
      const s = takeStash(identityId);
      if (!s) return;
      const k = kr.current;
      if (s.purpose === 'add' && k && !memoryOnly && !k.content.unlockers.some((u) => bytesEqual(u.recipientKey, s.key.pair.publicKey))) {
        void edit('Adding the passkey as an unlocker', (d) => void addUnlocker(d, s.key))
          .catch(() => {})
          .finally(() => s.key.wipe());
        return;
      }
      s.key.wipe();
    };
    addEventListener(KEYRING_STASH_EVENT, on);
    return () => removeEventListener(KEYRING_STASH_EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityId, memoryOnly, edit]);

  const saveToPlatform = useCallback(
    () =>
      run('Saving the keyring on Platform', async () => {
        const t = sessionToken();
        const k = kr.current;
        if (!k || !session) throw new Error('Nothing to save.');
        if (demo) throw new Error('The demo keyring of fixture mode cannot be saved.');
        // a locked saved keyring is opened by its phrase or a passkey, never by this session's seed behind the user's back (D-015)
        if (lockRef.current.lockedIn(session)) throw new Error(LOCKED_SAVE);
        const seed = seedUnlockKey(session);
        if (!seed) throw new Error('Saving needs your recovery phrase in this session. A pasted key cannot open a saved keyring.');
        // merge into an existing keyring rather than replacing it blindly
        const ctx = await storeCtx();
        try {
          const existing = await loadKeyring(ctx, k.ownerId, seed, seed).catch((e) => {
            if (e instanceof KeyringLockedError) throw new Error('You already have a saved keyring that your recovery phrase cannot open (its phrase unlocker was removed). Unlock it with a passkey and add these keys there.');
            throw e;
          });
          if (existing) {
            const seen = Number(localStorage.getItem(generationKey(registry.platformNetwork, existing.ownerId)) ?? 0);
            if (existing.authenticated !== true || existing.content.generation < seen) {
              existing.close();
              throw new Error('Your saved keyring could not be verified as yours (or is older than one this browser saw). Open it first and check its unlockers.');
            }
            for (const key of k.content.keys) if (!existing.content.keys.some((x) => votingKeyId(x.privateKey, x.compressed) === votingKeyId(key.privateKey, key.compressed))) existing.content.keys.push({ ...key, privateKey: key.privateKey.slice() });
            try {
              canWrite(existing);
              await saveKeys(ctx, session, existing);
            } catch (e) {
              existing.close();
              throw e;
            }
            if (!opened(existing, false, t)) throw new SessionChangedError();
          } else {
            addUnlocker(k, seed);
            canWrite(k);
            await saveKeys(ctx, session, k);
            if (sessionToken() !== t) throw new SessionChangedError();
            setMemoryOnly(false);
            keepVotesSealedTo(k);
            touch();
          }
        } finally {
          seed.wipe();
        }
        auth.refreshBalance();
      }),
    [run, session, storeCtx, opened, auth, registry.platformNetwork, demo, canWrite, sessionToken, keepVotesSealedTo],
  );

  // ---- masternodes for the keys: ONE lookup, read by this page and every vote panel ----
  const keysSig = keyring ? keyring.content.keys.map((k) => votingKeyId(k.privateKey, k.compressed)).join(',') : '';
  useEffect(() => {
    if (!keyring || !keysSig) return setMns(EMPTY_MNS);
    if (!lookupDeps) return setMns({ ...EMPTY_MNS, phase: 'error', error: 'No bridge is configured (Settings): the masternode list and collateral outpoints come from a bridge.', forKeys: keysSig });
    const ctrl = new AbortController();
    // while a lookup runs, keep what an earlier one found for the same keys (a refresh) or for the keys before one was added
    setMns((m) => ({ ...(m.forKeys && (keysSig === m.forKeys || keysSig.startsWith(`${m.forKeys},`)) ? m : EMPTY_MNS), phase: 'loading', step: 'bridge', error: undefined, startedAt: Date.now(), forKeys: keysSig }));
    const keys = keyring.content.keys.map((k, index) => ({ index, keyId: votingKeyId(k.privateKey, k.compressed) }));
    lookupMasternodes(keys, lookupDeps, { signal: ctrl.signal, onStep: (step) => !ctrl.signal.aborted && setMns((m) => ({ ...m, step })) }).then(
      (r) => !ctrl.signal.aborted && setMns({ ...r, phase: 'ready', forKeys: keysSig }),
      (e) => !ctrl.signal.aborted && setMns((m) => ({ ...m, phase: 'error', error: errorText(e) })),
    );
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSig, lookupDeps, mnNonce]);

  // ---- current votes (bridge's verified live vote set) ----
  /**
   * The current funding votes of OUR masternodes, from the bridge's live vote set, each re-verified here like the recount does
   * (verifyVoteSignature against the masternode's voting key, which for our masternodes is our own key; votes more than 1 h ahead
   * dropped like Core). A bridge vote for one of our masternodes that our key did not sign is ignored, so a lying bridge cannot make
   * a vote look confirmed or replaced. (The VerificationPanel's recount checks the whole set against the proven list.)
   */
  const currentVotes = useCallback(
    async (govHashes: string[]): Promise<Map<string, CurrentVote>> => {
      const out = new Map<string, CurrentVote>();
      const k = kr.current;
      if (!bridge || !k) return out;
      const keyOf = new Map(mns.owned.map((m) => [mnId(m), k.content.keys[m.keyIndex]] as const));
      const now = nowS();
      await Promise.all(
        govHashes.map(async (h) => {
          let vs;
          try {
            vs = await bridge.votes(h);
          } catch (e) {
            if (e instanceof BridgeError && e.status === 404) return; // no live tally yet (new proposal): no current votes
            throw e; // unreachable bridge: voting waits (Core's 1-hour rule needs the current votes)
          }
          for (const v of vs.votes) {
            const key = keyOf.get(mnId(v));
            if (v.signal !== 1 || !key || v.time > now + VOTE_MAX_FUTURE_S) continue;
            const fields = { collateralTxid: v.collateralTxid, collateralIndex: v.collateralIndex, govHashDisplay: h, signal: v.signal, outcome: v.outcome, time: v.time };
            const ck = currentKey(v, h);
            if ((out.get(ck)?.time ?? -1) < v.time && verifyVoteSignature(v.sig, fields, hexToBytes(votingKeyId(key.privateKey, key.compressed)), coreNetwork)) out.set(ck, { outcome: v.outcome, time: v.time });
          }
        }),
      );
      return out;
    },
    [bridge, mns.owned, coreNetwork],
  );

  const updateWatchedRef = useRef<(f: (w: WatchedVote[]) => WatchedVote[], t: string) => void>(() => {});

  /** `t`: the session the change belongs to. A change from work of an ended session, another identity or network is dropped. */
  const updateWatched = useCallback(
    (f: (w: WatchedVote[]) => WatchedVote[], t: string) => {
      if (sessionToken() !== t) return;
      // computed from (and written to) the ref synchronously, so the watchdog's "unchanged" check always sees the latest records
      const next = pruneWatched(f(watchedRef.current), nowS());
      // memory-only keyrings keep nothing on the device, not even signed votes (ephemeral records are never written)
      persistWatched(next);
      setWatched(next);
    },
    [sessionToken, persistWatched, setWatched],
  );
  updateWatchedRef.current = updateWatched;

  /** Rewrites the PENDING backup. `create`: may create it (the user opted in); otherwise only an existing one is kept current. */
  const backupPending = useCallback(
    async (list: WatchedVote[], create: boolean, t: string) => {
      const k = kr.current;
      if (sessionToken() !== t || !k || memoryOnly || !session || k.ownerId !== session.identityId || (!create && !k.pendingDoc)) return;
      if (needsConfirm) throw new Error('Confirm the keyring’s unlockers before backing up votes.');
      // this Core network's votes, newest first; what the backup holds for the other network (Dev and Testnet share it) stays
      const votes = pendingBackup(list, coreNetwork, k.pending.votes, PENDING_CAPS[2].votes);
      assertCanWrite(auth.balance, votes.length > PENDING_CAPS[1].votes ? 2 : 1);
      k.pending = { keyringId: k.content.keyringId.slice(), votes };
      await savePending(await storeCtx(), session, k);
      auth.refreshBalance();
    },
    [memoryOnly, needsConfirm, session, storeCtx, auth, coreNetwork, sessionToken],
  );

  // ---- relays: health, failover ----
  const checkHealth = useCallback(
    async (url: string, force = false): Promise<RelayHealth> => {
      const cached = healthRef.current[url];
      if (!force && cached && Date.now() - cached.checkedAt < HEALTH_TTL_MS) return cached;
      const h = await relayFor(url).health(coreNetwork);
      healthRef.current = { ...healthRef.current, [url]: h };
      setRelayHealth(healthRef.current);
      return h;
    },
    [relayFor, coreNetwork],
  );
  const noteHealth = useCallback((url: string, ok: boolean, err?: string) => {
    const prev = healthRef.current[url];
    if (prev?.ok === ok && !err) return;
    healthRef.current = { ...healthRef.current, [url]: { ...prev, ok, ...(err ? { error: err } : { error: undefined }), checkedAt: Date.now() } };
    setRelayHealth(healthRef.current);
  }, []);
  /** Relays in the order to try: healthy ones (random order), then unchecked, then those that failed their last check. */
  const relayOrder = useCallback((): string[] => {
    const rank = (u: string) => (healthRef.current[u] === undefined ? 1 : healthRef.current[u]!.ok ? 0 : 2);
    return [...relays].sort(() => Math.random() - 0.5).sort((a, b) => rank(a) - rank(b));
  }, [relays]);

  /**
   * One submission attempt for a vote not yet accepted by any relay: every configured relay in turn until one takes it. Returns the
   * updated record: held (or further) with the relay's id, a final state for a refusal, or still queued with the next retry time.
   */
  const trySend = useCallback(
    async (v: WatchedVote): Promise<WatchedVote> => {
      let last: string | null = null;
      let afterS = 0;
      const maybeAt = new Set(v.maybeAt ?? []);
      const withMaybe = (x: WatchedVote): WatchedVote => (maybeAt.size ? { ...x, maybeAt: [...maybeAt] } : x);
      for (const relay of relayOrder()) {
        try {
          const st = await relayFor(relay).submit(v, coreNetwork);
          noteHealth(relay, true);
          maybeAt.delete(relay);
          const { lastSendError: _e, nextSendAt: _n, ...rest } = v;
          return withMaybe(applyRelayState({ ...rest, status: 'held' }, relay, st));
        } catch (e) {
          const c = classifySubmitError(e, relay);
          if (c.kind === 'sent') return withMaybe({ ...v, status: 'broadcast', lastSendError: undefined });
          if (c.kind === 'final') return withMaybe({ ...v, status: c.status, ...(c.status === 'failed' ? { failReason: c.text } : { replacedBy: '', failReason: c.text }) });
          if (c.kind === 'retry' && c.maybeReceived) maybeAt.add(relay);
          if (!(e instanceof RelayError && e.status !== undefined)) noteHealth(relay, false, c.text);
          last = c.text;
          afterS = Math.max(afterS, c.afterS ?? 0);
          if (!c.tryOther) break;
        }
      }
      const attempts = (v.sendAttempts ?? 0) + 1;
      return withMaybe({ ...v, status: 'queued', sendAttempts: attempts, lastSendError: last ?? 'no relay is configured (Settings, Relays)', nextSendAt: nowS() + Math.max(afterS, sendRetryDelay(attempts)) });
    },
    [relayOrder, relayFor, coreNetwork, noteHealth],
  );

  /** The keyring's key for a vote's masternode, now (null while locked). */
  const liveKey = (v: Pick<WatchedVote, 'collateralTxid' | 'collateralIndex'>) => {
    const owner = ownerOf(mnsRef.current.owned, v);
    return owner ? kr.current?.content.keys[owner.keyIndex] : undefined;
  };

  /**
   * Takes a vote back at every relay that holds it or may hold it (withdraw.ts: a vote whose submission timed out is first looked up
   * by hash), records what was learned and the outcome, and returns the outcome. `gone` (no relay has it) becomes `onGone`.
   */
  const withdraw = useCallback(
    async (w: WatchedVote, key: { privateKey: Uint8Array; compressed: boolean } | undefined, t: string, onGone: 'dropped' | 'cancelled'): Promise<WithdrawResult> => {
      if (!key) throw new Error('Unlock the keyring holding this masternode’s voting key to cancel.');
      // a watchdog re-send may be on its way to another relay: wait for it, then use the latest record
      await inflightRef.current.get(w.voteHash)?.catch(() => {});
      const cur = watchedRef.current.find((x) => x.voteHash === w.voteHash) ?? w;
      const sigOf = (v: WatchedVote) => cancelSignature(key.privateKey, key.compressed, coreNetwork, v.voteHash);
      let r: Awaited<ReturnType<typeof withdrawVote>>;
      try {
        r = await withdrawVote(cur, { relayFor, network: coreNetwork, cancelSig: sigOf });
      } catch (e) {
        if (!(e instanceof WithdrawError)) throw e;
        // keep the relay ids found on the way, so the next try (or the watchdog) can reach the vote
        updateWatched((list) => list.map((x) => (x.voteHash === w.voteHash ? { ...x, refs: e.vote.refs, relayStatus: e.vote.relayStatus, relayInfo: e.vote.relayInfo } : x)), t);
        throw e.reason;
      }
      const after: Record<WithdrawResult, Partial<WatchedVote>> = {
        cancelled: { status: 'cancelled' },
        gone: { status: onGone },
        sent: { status: 'broadcast' },
        maybe: { status: 'broadcast', withdrawn: true },
        // a relay may still hold it: never sent again from here, and shown as such (not "dropped")
        unknown: { status: 'queued', restored: true },
      };
      updateWatched((list) => list.map((x) => (x.voteHash === w.voteHash ? { ...r.vote, ...after[r.result] } : x)), t);
      return r.result;
    },
    [coreNetwork, relayFor, updateWatched],
  );

  const cast = useCallback(
    (intents: Intent[], opts: CastOptions, deadline: number | null, currentIn: Map<string, CurrentVote>) =>
      run(opts.mode === 'now' ? 'Signing and sending the votes' : 'Signing and scheduling the votes', async () => {
        const t = sessionToken();
        const k = kr.current;
        if (!k) throw new Error('Unlock the keyring first.');
        if (!relays.length) throw new Error('No relay is configured (Settings, Relays).');
        // A vote of ours that is still held for the same masternode and proposal would be broadcast later and win (a later nTime):
        // cancel it, but only once a new vote can actually be made for that masternode (planned first). One that already went
        // out counts as the current vote (Core's 1-hour rule and "later wins" apply to it), and those masternodes are re-planned.
        // A vote still queued in this browser never left: the new one simply takes its place (mergeWatched drops it). One whose
        // submission timed out may be held by that relay: it is looked up there and cancelled like a held one (D-005).
        const now = nowS();
        let window: { earliest: number; latest: number } | null = null;
        if (opts.mode === 'deferred') {
          if (!deadline) throw new Error('The voting deadline is not known yet (no cycle data).');
          const w = deferredWindow(now, deadline, coreNetwork);
          if (!w) throw new Error('There is not enough time left before the voting deadline for a randomized schedule. Vote now instead.');
          const latest = Math.min(w.latest, opts.latest ?? Infinity);
          if (latest <= w.earliest) throw new Error('The release window ends too soon.');
          window = { earliest: w.earliest, latest };
        }
        // Copies of the keys and the masternode list this cast uses, the keys wiped as soon as the votes are signed: locking the
        // keyring mid-cast (button or idle lock) then no longer cancels the held votes and leaves the new ones unsigned (D-029).
        const { keyOf, ownerOf, wipe: wipeKeys } = castKeys(k.content.keys, mnsRef.current.owned);
        const stillHere = () => {
          if (sessionToken() !== t) throw new SessionChangedError();
        };
        try {
          const planWith = (cur: Map<string, CurrentVote>, list: Intent[]): PlanResult => (window ? planDeferred(list, cur, now, window) : planImmediate(list, cur, now, { resend: !!opts.resend }));
          const current = new Map(currentIn);
          /** A vote of ours that went out (or may have) is the masternode's current vote when it is newer than what the bridge shows. */
          const countAsCurrent = (w: WatchedVote) => {
            const ck = currentKey(w, w.govHash);
            if ((current.get(ck)?.time ?? -Infinity) < w.time) current.set(ck, { outcome: w.outcome, time: w.time });
          };
          watchedRef.current.filter((x) => x.status === 'broadcast').forEach(countAsCurrent);
          // a queued vote being sent right now (watchdog) may land at a relay: wait, so it is cancelled like any held vote
          await Promise.all([...inflightRef.current.values()].map((p) => p.catch(() => {})));
          let plan = planWith(current, intents);
          // masternodes that get a new vote, plus those whose new choice equals the current vote (skipped as "already voted"):
          // a held vote of ours for either would otherwise go out later and win
          const keep = new Set([
            ...plan.ok.map((p) => currentKey(p.mn, p.govHash)),
            ...intents.filter((i) => current.get(currentKey(i.mn, i.govHash))?.outcome === i.outcome).map((i) => currentKey(i.mn, i.govHash)),
          ]);
          let replan = false;
          castingRef.current = true;
          let n = 0;
          const taking = (x: WatchedVote) => x.status === 'held' || (x.status === 'queued' && !!x.maybeAt?.length);
          for (const w of watchedRef.current.filter((x) => taking(x) && keep.has(currentKey(x, x.govHash)))) {
            stillHere();
            // paced like submissions, so replacing many held votes stays under a relay's per-IP limit
            if (n++ >= 10) await new Promise((r) => setTimeout(r, IMMEDIATE_PACE_MS));
            const r = await withdraw(w, keyOf(w), t, 'dropped');
            if (r !== 'cancelled' && r !== 'gone') {
              // went out, may have, or a relay may still hold it: it counts as the current vote, and the new one is timed after it
              replan = true;
              countAsCurrent(w);
            }
          }
          stillHere();
          if (replan) plan = planWith(current, intents);
          const signed: WatchedVote[] = plan.ok.map((p) => {
            const owner = ownerOf(p.mn);
            const key = keyOf(p.mn);
            if (!key) throw new Error(`No key for masternode ${p.mn.proTxHash.slice(0, 12)}…`);
            const prev = currentIn.get(currentKey(p.mn, p.govHash)) ?? null;
            return { ...signPlanned(p, key.privateKey, key.compressed, coreNetwork), refs: [], status: 'queued', rebroadcasts: 0, signedAt: now, network: coreNetwork, weight: owner?.type === 'evo' ? 4 : 1, prev, ...(opts.mode === 'now' && p.time > now ? { hourRule: true } : {}), ...(memoryOnly ? { ephemeral: true } : {}) };
          });
          wipeKeys();
          // every signed vote is kept (queued) before the first request, so a failed or interrupted send never loses one
          updateWatched((w) => mergeWatched(w, signed), t);
          // deferred: random delays (unlinkability); immediate: the first few at once, then paced under a relay's per-IP limit
          const delays = opts.mode === 'deferred' ? pacedRandomDelays(signed.length) : signed.map((_, i) => Math.max(0, i - 9) * IMMEDIATE_PACE_MS);
          const order = signed.map((_, i) => i).sort((a, b) => delays[a]! - delays[b]!);
          let waited = 0;
          for (const i of order) {
            const d = delays[i]! - waited;
            if (d > 0) await new Promise((r) => setTimeout(r, d));
            waited += Math.max(0, d);
            // signed out, another identity or network: the rest stay queued (sealed) for that session and are sent when it opens again
            stillHere();
            const before = watchedRef.current.find((x) => x.voteHash === signed[i]!.voteHash);
            if (!before || before.status !== 'queued') continue; // dropped or cancelled meanwhile
            const after = await trySend(before);
            updateWatched((w) => w.map((x) => (x.voteHash === after.voteHash && x.status === 'queued' ? after : x)), t);
          }
          // the backup is created only when the user asks for it, but an existing one is always kept current (cancelled votes leave it)
          await backupPending(watchedRef.current, opts.mode === 'deferred' && !!opts.backupOnPlatform, t).catch((e) => sessionToken() === t && setError(`Backup on Platform failed: ${errorText(topUpFromError(e))}`));
          castingRef.current = false;
          kickRef.current();
          return plan;
        } finally {
          wipeKeys();
        }
      }).finally(() => {
        castingRef.current = false;
      }),
    [run, relays, coreNetwork, updateWatched, backupPending, withdraw, trySend, memoryOnly, sessionToken],
  );

  const submitSigned = useCallback(
    (v: Omit<WatchedVote, 'refs' | 'status' | 'rebroadcasts'>) =>
      run('Sending the signed vote', async () => {
        const t = sessionToken();
        if (!relays.length) throw new Error('No relay is configured (Settings, Relays).');
        const queued: WatchedVote = { ...v, network: coreNetwork, refs: [], status: 'queued', rebroadcasts: 0, signedAt: nowS(), ...(memoryOnly ? { ephemeral: true } : {}) };
        updateWatched((list) => mergeWatched(list, [queued]), t);
        const after = await trySend(queued);
        updateWatched((list) => list.map((x) => (x.voteHash === after.voteHash ? after : x)), t);
        kickRef.current();
      }),
    [run, relays, trySend, updateWatched, memoryOnly, coreNetwork, sessionToken],
  );

  const cancel = useCallback(
    (voteHash: string) =>
      run('Cancelling the held vote', async () => {
        const t = sessionToken();
        // a send of this vote may be on its way (watchdog): wait for its answer, then decide on the latest record
        await inflightRef.current.get(voteHash)?.catch(() => {});
        const v = watchedRef.current.find((x) => x.voteHash === voteHash);
        if (!v) return;
        // never left this browser: taking it out of the queue is the cancel
        if (v.status === 'queued' && !v.maybeAt?.length) {
          updateWatched((list) => list.map((x) => (x.voteHash === voteHash ? { ...x, status: 'cancelled' } : x)), t);
          return;
        }
        castingRef.current = true;
        const r = await withdraw(v, liveKey(v), t, 'cancelled').finally(() => (castingRef.current = false));
        if (r === 'unknown')
          throw new Error('It is not known whether a relay holds this vote (its submission was never confirmed, and the relay could not be asked). This browser will not send it again, but if a relay did receive it, it could still be released: vote again to be sure, the new vote is timed later and wins.');
        if (r === 'sent') throw new Error('Too late: a relay has already broadcast this vote. Vote again to change it (Core allows one change per hour).');
        if (r === 'maybe') throw new Error('Cancelled at the relay, but the relay had already handed this vote to the network once, so it may already count. Vote again to change it (Core allows one change per hour).');
        await backupPending(watchedRef.current.filter((x) => x.voteHash !== voteHash), false, t).catch(() => {});
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, withdraw, updateWatched, backupPending, sessionToken],
  );

  const retryNow = useCallback(() => {
    updateWatched((list) => list.map((x) => (x.status === 'queued' && !x.restored ? { ...x, nextSendAt: 0 } : x)), sessionToken());
    for (const r of relays) void checkHealth(r, true);
    kickRef.current();
  }, [updateWatched, relays, checkHealth, sessionToken]);

  const dismissCelebration = useCallback((h: string) => setCelebrations((c) => c.filter((x) => x !== h)), []);

  // ---- watchdog: send queued votes, relay status, bridge confirmation, recount, re-broadcast ----
  const relaysKey = relays.join(' ');
  useEffect(() => {
    if (!identityId) return;
    let stop = false;
    const configured = new Set(relays);
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let quiet = 0;
    const tickFor = sessionToken();
    const mnlists = new Map<number, Promise<Map<string, number>>>();
    const weightsAt = (height: number): Promise<Map<string, number>> => {
      let p = mnlists.get(height);
      if (!p && bridge) {
        p = bridge.mnlist(height).then((l) => new Map(l.masternodes.map((m) => [normalizeMnId(`${m.collateralTxid}-${m.collateralIndex}`), m.type === 'evo' ? 4 : 1])));
        p.catch(() => mnlists.delete(height));
        mnlists.set(height, p);
      }
      return p ?? Promise.reject(new Error('no bridge'));
    };
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!stop) timer = setTimeout(() => void tick(), ms);
    };
    const tick = async () => {
      if (running || stop) return;
      running = true;
      let changed = false;
      try {
        changed = await tickOnce();
      } catch {
        /* the next tick tries again */
      } finally {
        running = false;
      }
      const now = nowS();
      const list = watchedRef.current.filter((v) => isTracked(v, now));
      if (!list.length) return schedule(TICK_SLOW_MS);
      quiet = changed ? 0 : Math.min(quiet + 1, 3);
      const urgent = list.some(
        (v) => v.status === 'broadcast' || v.status === 'confirmed' || (v.status === 'queued' && (v.nextSendAt ?? 0) - now < 10) || (v.status === 'held' && Math.max(v.releaseAt, ...Object.values(v.relayInfo ?? {}).map((i) => i.nextAttemptAt ?? 0)) - now < 90),
      );
      // while a cast is sending, its own votes are not the watchdog's to send: no 1-second ticks for them
      const nextSend = castingRef.current ? Infinity : Math.min(...list.filter((v) => sendDue({ ...v, nextSendAt: 0 }, now)).map((v) => (v.nextSendAt ?? now) - now));
      const base = urgent || castingRef.current ? TICK_FAST_MS * (1 + quiet * 0.5) : TICK_SLOW_MS;
      schedule(Math.max(1000, Math.min(base, Number.isFinite(nextSend) ? nextSend * 1000 + 200 : base)));
    };
    kickRef.current = () => {
      quiet = 0;
      schedule(50);
    };
    /**
     * Applies updates to the records this tick started from (a cancel or a new cast in the meantime wins). A tick of a session that
     * ended writes nothing (updateWatched drops it); its relays keep the votes, and the next session reads them again.
     */
    const apply = (from: Map<string, WatchedVote>, updates: WatchedVote[]) => {
      if (updates.length) updateWatchedRef.current((w) => w.map((x) => (from.get(x.voteHash) === x ? (updates.find((u) => u.voteHash === x.voteHash) ?? x) : x)), tickFor);
    };
    const tickOnce = async (): Promise<boolean> => {
      let now = nowS();
      let changed = false;
      // 1. queued votes that are due: submit (one at a time; paced by the relays' answers)
      if (!castingRef.current) {
        for (const v of watchedRef.current.filter((x) => sendDue(x, now))) {
          if (stop || castingRef.current || sessionToken() !== tickFor) break;
          const p = trySend(v);
          inflightRef.current.set(v.voteHash, p);
          let after: WatchedVote;
          try {
            after = await p;
          } finally {
            inflightRef.current.delete(v.voteHash);
          }
          const nowRec = watchedRef.current.find((x) => x.voteHash === v.voteHash);
          if (nowRec && nowRec !== v && (nowRec.status === 'cancelled' || nowRec.status === 'dropped') && after.refs.length) {
            // withdrawn while the relay was taking it: remember where it is, and take it back there
            updateWatchedRef.current((w) => w.map((x) => (x.voteHash === v.voteHash ? { ...x, refs: after.refs, relayStatus: after.relayStatus, relayInfo: after.relayInfo } : x)), tickFor);
            const status = nowRec.status;
            void withdraw({ ...nowRec, refs: after.refs, relayStatus: after.relayStatus, relayInfo: after.relayInfo, status: 'held' }, liveKey(v), tickFor, status).catch(() => {});
            continue;
          }
          apply(new Map([[v.voteHash, v]]), [after]);
          changed ||= after.status !== v.status;
        }
      }
      const open = watchedRef.current.filter((v) => isTracked(v, nowS()) && v.status !== 'queued');
      if (!open.length || stop) return changed;
      // 2. the bridge: only votes signed by the same voting key as ours count. The key comes from our own stored signature, so this
      // works while the keyring is locked too (no private key needed).
      const current = new Map<string, CurrentVote>();
      const sets = new Map<string, BridgeVotes>();
      if (bridge) {
        const signerOf = new Map<string, Uint8Array>();
        for (const v of open) {
          const r = recoverVoteSigner(v.sig, voteFields({ mn: v, govHash: v.govHash, outcome: v.outcome, time: v.time }), coreNetwork);
          if (r) signerOf.set(currentKey(v, v.govHash), r.keyId);
        }
        now = nowS();
        for (const h of new Set(open.map((v) => v.govHash))) {
          let vs;
          try {
            vs = await bridge.votes(h);
          } catch {
            continue; // no tally yet, or unreachable
          }
          sets.set(h, vs);
          for (const b of vs.votes) {
            const ck = currentKey(b, h);
            const keyId = signerOf.get(ck);
            if (!keyId || b.signal !== 1 || b.time > now + VOTE_MAX_FUTURE_S || (current.get(ck)?.time ?? -1) >= b.time) continue;
            const fields = { collateralTxid: b.collateralTxid, collateralIndex: b.collateralIndex, govHashDisplay: h, signal: b.signal, outcome: b.outcome, time: b.time };
            if (verifyVoteSignature(b.sig, fields, keyId, coreNetwork)) current.set(ck, { outcome: b.outcome, time: b.time });
          }
        }
      }
      const updates: WatchedVote[] = [];
      const newlySeen: string[] = [];
      const from = new Map(open.map((v) => [v.voteHash, v]));
      for (const v of open) {
        let next = v;
        const verdict = bridgeVerdict(v, current.get(currentKey(v, v.govHash)), watchedRef.current);
        if (verdict?.status === 'confirmed' && v.status !== 'confirmed') {
          next = { ...next, status: 'confirmed', seenAt: now };
          if (now - (v.signedAt ?? v.time) < 86400) newlySeen.push(v.voteHash);
        } else if (verdict?.status === 'replaced') next = { ...next, status: 'replaced', replacedBy: verdict.replacedBy };
        // 3. counted: the recount of the tally's vote set has our vote as the masternode's current one, and recounts to the set's hash
        if (next.status === 'confirmed' && !next.countedAt) {
          const vs = sets.get(v.govHash);
          if (vs) {
            try {
              const weights = await weightsAt(vs.tallyHeight);
              const t = countVotes(
                vs.votes.filter((b) => b.signal === 1).map((b) => ({ mn: normalizeMnId(`${b.collateralTxid}-${b.collateralIndex}`), outcome: b.outcome, time: b.time })),
                weights,
                { now },
              );
              const me = normalizeMnId(`${v.collateralTxid}-${v.collateralIndex}`);
              const mine = t.current.get(me);
              // counted = in the weight map of the tally's list (an unknown masternode's vote counts for nothing) and the recount is the bridge's set
              if (mine && weights.has(me) && Number(mine.time) === v.time && mine.outcome === v.outcome && vs.voteSetHash && vs.voteSetHash === t.voteSetHash) {
                next = { ...next, countedAt: now, tally: { before: tallyBefore(t.weighted, v.outcome, weights.get(me)!, v.prev?.outcome), after: t.weighted } };
              }
            } catch {
              /* list not readable now: next tick */
            }
          }
        }
        // 4. relays (only those the user configured; a ref from elsewhere is never followed)
        if (next.status === 'held' || next.status === 'broadcast') {
          for (const r of next.refs.filter((x) => configured.has(x.relay))) {
            try {
              const st = await relayFor(r.relay).status(r.id);
              if (st) next = applyRelayState(next, r.relay, st);
              noteHealth(r.relay, true);
            } catch (e) {
              if (!(e instanceof RelayError && e.status !== undefined)) noteHealth(r.relay, false, errorText(e));
            }
          }
        }
        // 5. re-broadcast through another relay when the vote does not show up long after its release
        const unchanged = !castingRef.current && watchedRef.current.find((x) => x.voteHash === v.voteHash) === v;
        if (unchanged && isOpen(next) && needsRebroadcast(next, now) && (next.retryAt ?? 0) <= now) {
          const relay = pickRebroadcastRelay(next, relays);
          if (relay) {
            next = { ...next, rebroadcasts: next.rebroadcasts + 1 };
            try {
              const p = relayFor(relay).submit(next, coreNetwork);
              inflightRef.current.set(v.voteHash, p);
              let st: RelayVoteState;
              try {
                st = await p;
              } finally {
                inflightRef.current.delete(v.voteHash);
              }
              next = applyRelayState(next, relay, st);
              // the new relay's id is recorded at once, whatever happens to this tick's other updates, so it can be cancelled
              const ref = next.refs.find((r) => r.relay === relay)!;
              const before = watchedRef.current.find((x) => x.voteHash === v.voteHash);
              updateWatchedRef.current((w) => w.map((x) => (x.voteHash === v.voteHash && !x.refs.some((r) => r.relay === relay) ? { ...x, refs: [...x.refs, ref] } : x)), tickFor);
              const after = watchedRef.current.find((x) => x.voteHash === v.voteHash);
              if (before === v && after) from.set(v.voteHash, after);
            } catch (e) {
              // a briefly rate-limited relay (429 rate-limited) did not see the vote: that attempt does not count, but the next try
              // waits for Retry-After; anything else (too-many-held, refusals, transport) counts
              if (e instanceof RelayError && e.status === 429 && e.code === 'rate-limited') next = { ...next, rebroadcasts: next.rebroadcasts - 1, retryAt: nowS() + Math.min(Math.max(e.retryAfterS ?? 60, 30), 3600) };
            }
          }
        }
        if (JSON.stringify(next) !== JSON.stringify(v)) updates.push(next);
      }
      apply(from, updates);
      if (newlySeen.length && sessionToken() === tickFor) setCelebrations((c) => [...c.filter((x) => !newlySeen.includes(x)), ...newlySeen]);
      return changed || updates.length > 0;
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
      kickRef.current = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityId, mode, bridge, relaysKey, updateWatched]);

  // relay health: checked once the keyring opens, and again while votes wait for a relay
  useEffect(() => {
    if (status !== 'open') return;
    for (const r of relays) void checkHealth(r);
  }, [status, relaysKey, checkHealth]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- "Check it yourself": one vote re-verified from scratch ----
  const verifyVote = useCallback(
    async (voteHash: string): Promise<VoteProof> => {
      const v = watchedRef.current.find((x) => x.voteHash === voteHash);
      if (!v) throw new Error('That vote is no longer in this browser.');
      const fields = voteFields({ mn: v, govHash: v.govHash, outcome: v.outcome, time: v.time });
      const checks: VoteProof['checks'] = [];
      const signer = recoverVoteSigner(v.sig, fields, coreNetwork);
      const signerAddr = signer ? p2pkhAddress(signer.keyId, coreNetwork) : null;
      checks.push({ label: 'The signature is valid', ok: !!signer, detail: signerAddr ? `It recovers to the voting address ${signerAddr}.` : 'It does not recover to any key.' });
      const owned: OwnedMasternode | undefined = mnsRef.current.owned.find((m) => mnId(m) === mnId(v));
      const pro = (owned?.proTxHash ?? v.proTxHash).toLowerCase();
      // the voting address of this masternode in the list several evonodes agree on (fixtures: the bridge's list)
      let listAddr: string | null = null;
      let listName = 'the bridge’s masternode list';
      try {
        if (dapi) {
          const sml = await dapi.getSml();
          listAddr = sml.masternodes.find((m) => m.proTxHash.toLowerCase() === pro)?.votingAddress ?? null;
          listName = `the masternode list ${sml.agreedBy.length} DAPI evonodes agree on`;
        } else if (bridge) {
          listAddr = (await bridge.mnlist()).masternodes.find((m) => m.proTxHash.toLowerCase() === pro)?.votingAddress ?? null;
        }
        checks.push({ label: 'It is this masternode’s voting key', ok: !!listAddr && listAddr === signerAddr, detail: listAddr ? `${listName} gives ${listAddr} for ${pro.slice(0, 12)}…` : `${pro.slice(0, 12)}… is not in ${listName}.` });
      } catch (e) {
        checks.push({ label: 'It is this masternode’s voting key', ok: null, detail: `The masternode list could not be read (${errorText(e)}).` });
      }
      if (dapi && owned) {
        try {
          const p = await proveCollaterals([owned], async (txid) => (await dapi.call((core, s) => core.getTransaction(txid, { signal: s }))).value.raw, coreNetwork);
          const ok = p.mns[0]?.provenance.collateral === 'protx';
          checks.push({ label: 'The collateral belongs to it', ok, detail: ok ? `The registration transaction ${pro.slice(0, 12)}… names the collateral ${v.collateralTxid.slice(0, 12)}…:${v.collateralIndex}.` : 'The registration transaction could not be read or names another collateral.' });
        } catch (e) {
          checks.push({ label: 'The collateral belongs to it', ok: null, detail: errorText(e) });
        }
      }
      if (bridge) {
        try {
          const vs = await bridge.votes(v.govHash);
          const b = vs.votes.find((x) => mnId(x) === mnId(v));
          const exact = !!b && b.time === v.time && b.outcome === v.outcome && b.sig === v.sig;
          checks.push({ label: 'The network has it as the current vote', ok: exact, detail: exact ? `The bridge’s vote set as of block ${vs.asOfHeight} has exactly this vote.` : b ? 'The bridge’s vote set has a different vote for this masternode.' : 'The bridge’s vote set has no vote for this masternode yet.' });
        } catch (e) {
          checks.push({ label: 'The network has it as the current vote', ok: null, detail: errorText(e) });
        }
      }
      return { checks };
    },
    [coreNetwork, dapi, bridge],
  );

  const value = useMemo<Ctx>(
    () => ({
      status,
      error,
      needsTopUp,
      demo,
      canUsePlatform: !demo && !!session && (!!session.wallet || session.source === 'passkey'),
      memoryOnly,
      keyring,
      busy,
      mns,
      watched,
      coreNetwork,
      relays,
      relayHealth,
      celebrations,
      dismissCelebration,
      bridgeBase: demo ? null : (bridgeEndpoint?.httpBase ?? null),
      unlockWithPasskey,
      unlockWithPhrase,
      createKeyring,
      lock,
      addKey,
      removeKey,
      setNodeLabel,
      setIdleMinutes,
      addPasskeyUnlocker,
      removeUnlockerKey,
      saveToPlatform,
      needsConfirm,
      confirmUnlockers,
      refreshMasternodes: () => setMnNonce((n) => n + 1),
      currentVotes,
      cast,
      cancel,
      retryNow,
      submitSigned,
      verifyVote,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, error, needsTopUp, demo, session, memoryOnly, needsConfirm, confirmUnlockers, keyring, version, busy, mns, watched, coreNetwork, relays, relayHealth, celebrations, dismissCelebration, bridgeEndpoint?.httpBase, unlockWithPasskey, unlockWithPhrase, createKeyring, lock, addKey, removeKey, setNodeLabel, setIdleMinutes, addPasskeyUnlocker, removeUnlockerKey, saveToPlatform, currentVotes, cast, cancel, retryNow, submitSigned, verifyVote],
  );
  return <C.Provider value={value}>{children}</C.Provider>;
}
