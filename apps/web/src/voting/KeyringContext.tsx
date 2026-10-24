// Masternode keyring and voting state (PLAN §5.1-5.2): "add my masternodes" once, sign in again later and they are back.
//
// Keys live in this tab's memory while the keyring is open. Saved keyrings are encrypted in the browser (@govhub/auth keyring) to
// the recovery phrase and the user's passkeys and stored in `forum.keyring`; the operator only ever sees ciphertext. A seed sign-in
// opens it at once, a passkey sign-in with the same ceremony; a pasted-key session cannot open it (memory-only keys still work).
// After the idle timeout the keys are wiped and the keyring has to be unlocked again (passkey or phrase).
import {
  addUnlocker,
  DEFAULT_IDLE_LOCK_MINUTES,
  emptyKeyring,
  hexToBytes,
  identifierBytes,
  isValidPrivateKey,
  KeyringLockedError,
  loadKeyring,
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
import { useAuth } from '../auth/context.tsx';
import { errorText, getPlatformPort, rpId } from '../auth/runtime.ts';
import { enabledBridges } from '../config/registry.ts';
import { HttpBridge, type Bridge, type BridgeVote } from '../data/bridge.ts';
import { createWebDapi, dapiConfig } from '../data/dapi.ts';
import { getSdk } from '../data/platform.ts';
import type { SmlEntry } from '../verify/votes.ts';
import { matchMasternodes, proveCollaterals, votingKeyId, type OwnedMasternode } from './masternodes.ts';
import { bridgeVerdict, fromPending, isOpen, type WatchStatus, loadWatched, mergeWatched, needsRebroadcast, pickRebroadcastRelay, pruneWatched, saveWatched, toPending, type WatchedVote } from './pending.ts';
import { currentKey, deferredWindow, mnId, planDeferred, planImmediate, signPlanned, submitDelays, type CurrentVote, type Intent, type PlanResult } from './plan.ts';
import { cancelSignature, normalizeRelayUrl, RelayClient, RelayError } from './relay.ts';
import { KEYRING_STASH_EVENT, takeStash } from './stash.ts';
import { bytesEqual, decodeWif, governanceVoteHash } from '@govhub/verify';

export type KeyringStatus = 'signed-out' | 'fixtures' | 'checking' | 'absent' | 'locked' | 'open' | 'error';

export interface MnState {
  loading: boolean;
  error?: string;
  owned: OwnedMasternode[];
  /** listed for our key in the SML but not (yet) in the bridge's list: cannot vote */
  missing: string[];
  /** the bridge named another collateral than the ProRegTx: dropped */
  mismatch: string[];
  smlNodes: number;
}

export interface CastOptions {
  mode: 'now' | 'deferred';
  /** deferred: unix seconds; the window ends at min(this, deadline - margin) */
  latest?: number;
  /** backup of held votes in the encrypted PENDING document (deferred only) */
  backupOnPlatform?: boolean;
}

interface Ctx {
  status: KeyringStatus;
  error: string | null;
  /** the session can open a Platform keyring (seed or passkey); a pasted key cannot */
  canUsePlatform: boolean;
  memoryOnly: boolean;
  keyring: OpenedKeyring | null;
  busy: string | null;
  mns: MnState;
  watched: WatchedVote[];
  coreNetwork: 'mainnet' | 'testnet';
  relays: string[];
  /** unlock / create */
  unlockWithPasskey(): Promise<void>;
  unlockWithPhrase(phrase: string): Promise<void>;
  createKeyring(memoryOnly: boolean): Promise<void>;
  lock(): void;
  /** keys and labels */
  addKey(input: string, label: string): Promise<void>;
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
  /** offline: submit a signature made elsewhere for a planned vote */
  submitSigned(v: Omit<WatchedVote, 'refs' | 'status' | 'rebroadcasts'>): Promise<void>;
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
/** Highest keyring generation this browser has opened or written (public: a counter), to notice a replayed older document. */
const generationKey = (platformNetwork: string, ownerId: string) => `govhub.keyring.generation.${platformNetwork}.${ownerId}`;
const EMPTY_MNS: MnState = { loading: false, owned: [], missing: [], mismatch: [], smlNodes: 0 };

function parseVotingKey(input: string, network: 'mainnet' | 'testnet'): { privateKey: Uint8Array; compressed: boolean } {
  const t = input.trim();
  if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(t)) {
    const privateKey = hexToBytes(t.replace(/^0x/, ''));
    if (!isValidPrivateKey(privateKey)) throw new Error('That is not a valid private key.');
    return { privateKey, compressed: true };
  }
  try {
    const { privKey, compressed } = decodeWif(t, network);
    return { privateKey: privKey, compressed };
  } catch {
    throw new Error(`Enter the voting key as a ${network} WIF (or 64 hex characters).`);
  }
}

export function KeyringProvider({ children }: { children: ReactNode }) {
  const { registry, mode } = useApp();
  const auth = useAuth();
  const session = auth.session;
  const coreNetwork = registry.coreNetwork;
  const relays = useMemo(() => registry.relays.map((r) => normalizeRelayUrl(r.url)).filter(Boolean), [registry.relays]);
  const [status, setStatus] = useState<KeyringStatus>('signed-out');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [memoryOnly, setMemoryOnly] = useState(false);
  const [keyring, setKeyring] = useState<OpenedKeyring | null>(null);
  const [version, setVersion] = useState(0); // bump to re-render after in-place keyring edits
  const [mns, setMns] = useState<MnState>(EMPTY_MNS);
  const [mnNonce, setMnNonce] = useState(0);
  const [watched, setWatchedState] = useState<WatchedVote[]>([]);
  /** The keyring could be planted or replayed (not authenticated by this seed, or older than one seen here): saving waits for the user. */
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const kr = useRef<OpenedKeyring | null>(null);
  kr.current = keyring;
  const watchedRef = useRef<WatchedVote[]>([]);
  /** a cast or cancel is changing votes: the watchdog does not re-broadcast meanwhile */
  const castingRef = useRef(false);
  /** watchdog re-sends in flight, by vote hash: a cancel waits for them, so it also reaches the relay just sent to */
  const inflightRef = useRef(new Map<string, Promise<unknown>>());
  /** The ref is the single source of truth for watched votes (async code reads it); the state only re-renders. */
  const setWatched = useCallback((next: WatchedVote[]) => {
    watchedRef.current = next;
    setWatchedState(next);
  }, []);
  const identityId = session?.identityId ?? null;
  const touch = () => setVersion((v) => v + 1);

  const storeCtx = useCallback(async (): Promise<StoreCtx> => {
    const [evo, sdk, port, { createEvoKeyringStore }] = await Promise.all([import('@dashevo/evo-sdk'), getSdk(registry), getPlatformPort(registry), import('@govhub/auth/keyring-evo')]);
    return { store: createEvoKeyringStore(evo, sdk, port, registry.forum.contractId), contractId: registry.forum.contractId };
  }, [registry]);

  const close = useCallback(() => {
    kr.current?.close();
    setKeyring(null);
  }, []);

  const opened = useCallback(
    (k: OpenedKeyring, memory: boolean) => {
      kr.current?.close();
      setKeyring(k);
      setMemoryOnly(memory);
      setStatus('open');
      setError(null);
      const gkey = generationKey(registry.platformNetwork, k.ownerId);
      const seen = Number(localStorage.getItem(gkey) ?? 0);
      const rolledBack = !memory && k.content.generation < seen;
      if (!memory && !rolledBack) localStorage.setItem(gkey, String(k.content.generation));
      setNeedsConfirm(!memory && (k.authenticated !== true || rolledBack));
      if (rolledBack) setError(`This keyring is older than one this browser opened before (version ${k.content.generation}, seen ${seen}): someone who held a key of this identity may have put back an old copy. Check the unlockers below before saving anything.`);
      else if (k.authenticated === false) setError('This keyring does not list your recovery phrase as an unlocker. Someone who held a key of this identity may have replaced it: check the unlockers below and remove any you do not recognise before adding keys.');
      // restore pending votes kept on Platform into the local watch list
      if (k.pending.votes.length && identityId) {
        const restored = k.pending.votes.map((p) => {
          const voteHash = governanceVoteHash({ collateralTxid: p.collateralTxid, collateralIndex: p.collateralIndex, govHashDisplay: p.govHash, signal: 1, outcome: p.outcome, time: p.time });
          return fromPending(p, '', voteHash);
        });
        const w = watchedRef.current;
        const known = new Set(w.map((x) => x.voteHash));
        const merged = mergeWatched(w, restored.filter((r) => !known.has(r.voteHash)));
        if (!memory) saveWatched(localStorage, coreNetwork, identityId, merged);
        setWatched(merged);
      }
    },
    [identityId, coreNetwork, registry.platformNetwork, setWatched],
  );

  const tryOpen = useCallback(
    async (key: UnlockKey, seedCheck: UnlockKey | null): Promise<'open' | 'absent'> => {
      if (!identityId) throw new Error('Sign in first.');
      const k = await loadKeyring(await storeCtx(), identityId, key, seedCheck);
      if (!k) return 'absent';
      opened(k, false);
      return 'open';
    },
    [identityId, storeCtx, opened],
  );

  // ---- session changes: open with the seed, or with the passkey ceremony that signed in ----
  useEffect(() => {
    close();
    setMns(EMPTY_MNS);
    setError(null);
    setMemoryOnly(false);
    if (!identityId || !session) {
      setStatus(mode === 'fixtures' ? 'fixtures' : 'signed-out');
      setWatched([]);
      return;
    }
    setWatched(loadWatched(localStorage, coreNetwork, identityId));
    if (mode === 'fixtures') return setStatus('fixtures');
    let live = true;
    const seed = seedUnlockKey(session);
    const stash = takeStash(identityId);
    const key = stash?.purpose === 'unlock' ? stash.key : seed;
    if (!key) {
      setStatus('locked');
      return;
    }
    setStatus('checking');
    tryOpen(key, seed)
      .then((r) => live && r === 'absent' && setStatus('absent'))
      .catch((e) => {
        if (!live) return;
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
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityId, mode, coreNetwork]);

  useEffect(() => () => kr.current?.close(), []);

  // ---- idle lock ----
  const idleMinutes = keyring?.content.idleLockMinutes ?? DEFAULT_IDLE_LOCK_MINUTES;
  useEffect(() => {
    if (status !== 'open') return;
    let last = Date.now();
    const bump = () => (last = Date.now());
    const evs = ['pointerdown', 'keydown', 'scroll'] as const;
    evs.forEach((e) => addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - last > idleMinutes * 60_000) {
        close();
        setStatus(memoryOnly ? 'absent' : 'locked');
        setError(memoryOnly ? 'The keyring was idle and its memory-only keys were wiped.' : 'The keyring locked itself after being idle. Unlock it again to vote.');
      }
    }, 15_000);
    return () => {
      clearInterval(t);
      evs.forEach((e) => removeEventListener(e, bump));
    };
  }, [status, idleMinutes, memoryOnly, close]);

  const run = useCallback(async <T,>(what: string, fn: () => Promise<T>): Promise<T> => {
    setBusy(what);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorText(e));
      throw e;
    } finally {
      setBusy(null);
    }
  }, []);

  const persist = useCallback(async (target?: OpenedKeyring, unconfirmedOk = false) => {
    const k = target ?? kr.current;
    if (!k || memoryOnly || !session) return;
    if (needsConfirm && !unconfirmedOk) throw new Error('Check the list of unlockers below and confirm it before saving: this keyring could not be verified as yours.');
    await saveKeys(await storeCtx(), session, k);
    localStorage.setItem(generationKey(registry.platformNetwork, k.ownerId), String(k.content.generation));
    auth.refreshBalance();
  }, [memoryOnly, needsConfirm, session, storeCtx, auth, registry.platformNetwork]);

  const unlockWithPasskey = useCallback(
    () =>
      run('Unlocking with a passkey', async () => {
        const a = await getPasskeyPrf({ rpId: rpId(), prfInput: prfInput(identifierBytes(registry.forum.contractId)) });
        const key = passkeyUnlockKey(a.prfOutput);
        a.prfOutput.fill(0);
        const seed = session ? seedUnlockKey(session) : null;
        try {
          const r = await tryOpen(key, seed);
          if (r === 'absent') setStatus('absent');
        } catch (e) {
          if (e instanceof KeyringLockedError) throw new Error('This passkey does not unlock the keyring. Use your recovery phrase, or a passkey that was added while the keyring was open.');
          throw e;
        } finally {
          key.wipe();
          seed?.wipe();
        }
      }),
    [run, registry.forum.contractId, session, tryOpen],
  );

  const unlockWithPhrase = useCallback(
    (phrase: string) =>
      run('Unlocking with the recovery phrase', async () => {
        if (!identityId) throw new Error('Sign in first.');
        const w = SeedWallet.fromPhrase(phrase, auth.network);
        const e = w.entropy();
        w.wipe();
        const key = seedUnlockKeyFromEntropy(e, auth.network, identityId);
        e.fill(0);
        try {
          const r = await tryOpen(key, key);
          if (r === 'absent') setStatus('absent');
        } catch (err) {
          if (err instanceof KeyringLockedError) throw new Error("That recovery phrase doesn't unlock this identity's keyring.");
          throw err;
        } finally {
          key.wipe();
        }
      }),
    [run, identityId, auth.network, tryOpen],
  );

  const createKeyring = useCallback(
    (memory: boolean) =>
      run(memory ? 'Starting a memory-only keyring' : 'Creating the keyring', async () => {
        if (!identityId || !session) throw new Error('Sign in first.');
        const k = emptyKeyring(identityId, []);
        if (!memory) {
          const seed = seedUnlockKey(session);
          if (!seed) throw new Error('Saving a keyring needs your recovery phrase in this session (sign in with it, or with a passkey that keeps it). A pasted key cannot open a saved keyring; use memory-only.');
          addUnlocker(k, seed);
          seed.wipe();
          await saveKeys(await storeCtx(), session, k);
          auth.refreshBalance();
        }
        opened(k, memory);
      }),
    [run, identityId, session, storeCtx, opened, auth],
  );

  const lock = useCallback(() => {
    const wasMemory = memoryOnly;
    close();
    setStatus(wasMemory ? 'absent' : 'locked');
    setMns(EMPTY_MNS);
  }, [close, memoryOnly]);

  /**
   * Every keyring edit is saved from a draft and applied only once the save succeeded, so the page never shows (and the next save
   * never carries) a change that is not on Platform. `unconfirmedOk`: removing unlockers seals to fewer recipients and is allowed
   * before the user confirmed an unverified keyring's unlockers.
   */
  const edit = useCallback(
    (what: string, change: (draft: OpenedKeyring) => void, o: { unconfirmedOk?: boolean; after?(): void; onFail?(): void } = {}) =>
      run(what, async () => {
        const k = kr.current;
        if (!k) throw new Error('Open the keyring first.');
        const c = k.content;
        const seen = Number(localStorage.getItem(generationKey(registry.platformNetwork, k.ownerId)) ?? 0);
        // a replayed older keyring is saved ABOVE the highest generation seen here, so the rollback check stays meaningful
        const draft: OpenedKeyring = { ...k, content: { ...c, generation: Math.max(c.generation, seen), unlockers: [...c.unlockers], keys: [...c.keys], labels: [...c.labels] } };
        change(draft);
        try {
          await persist(draft, o.unconfirmedOk);
        } catch (e) {
          o.onFail?.();
          throw e;
        }
        k.content = draft.content;
        k.keysDoc = draft.keysDoc;
        touch();
        o.after?.();
      }),
    [run, persist, registry.platformNetwork],
  );

  const addKey = useCallback(
    async (input: string, label: string) => {
      setError(null);
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
      const id = votingKeyId(privateKey, compressed);
      if (k.content.keys.some((x) => votingKeyId(x.privateKey, x.compressed) === id)) {
        privateKey.fill(0);
        setError('That voting key is in the keyring already.');
        throw new Error('That voting key is in the keyring already.');
      }
      await edit('Adding the voting key', (d) => d.content.keys.push({ privateKey, compressed, label }), { onFail: () => privateKey.fill(0), after: () => setMnNonce((n) => n + 1) });
    },
    [edit, coreNetwork],
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
        const k = kr.current;
        if (!k || !session) throw new Error('Nothing to save.');
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
              await saveKeys(ctx, session, existing);
            } catch (e) {
              existing.close();
              throw e;
            }
            opened(existing, false);
          } else {
            addUnlocker(k, seed);
            await saveKeys(ctx, session, k);
            setMemoryOnly(false);
            touch();
          }
        } finally {
          seed.wipe();
        }
        auth.refreshBalance();
      }),
    [run, session, storeCtx, opened, auth, registry.platformNetwork],
  );

  // ---- masternodes for the keys ----
  const bridge = useMemo<Bridge | null>(() => {
    const b = enabledBridges(registry)[0];
    return b ? new HttpBridge(b.name, b.httpBase) : null;
  }, [registry]);
  const dapi = useMemo(() => (mode === 'live' ? createWebDapi(dapiConfig(registry)) : null), [registry, mode]);
  const keysSig = keyring ? keyring.content.keys.map((k) => votingKeyId(k.privateKey, k.compressed)).join(',') : '';
  useEffect(() => {
    if (!keyring || !keysSig) return setMns(EMPTY_MNS);
    if (!bridge) return setMns({ ...EMPTY_MNS, error: 'No bridge is configured (Settings): the masternode list and collateral outpoints come from a bridge.' });
    let live = true;
    setMns((m) => ({ ...m, loading: true, error: undefined }));
    (async () => {
      const keys = keyring.content.keys.map((k, index) => ({ index, keyId: votingKeyId(k.privateKey, k.compressed) }));
      const list = await bridge.mnlist();
      let sml: Map<string, SmlEntry> | null = null;
      let smlNodes = 0;
      let smlError: string | undefined;
      if (dapi) {
        try {
          const a = await dapi.getSml();
          sml = new Map(a.masternodes.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: m.isValid, nType: m.nType }]));
          smlNodes = a.agreedBy.length;
        } catch (e) {
          smlError = `The masternode list could not be checked against DAPI (${errorText(e)}); showing the bridge's list.`;
        }
      }
      const m = matchMasternodes(keys, list.masternodes, sml, coreNetwork);
      const proved = dapi ? await proveCollaterals(m.owned, async (txid) => (await dapi.call((core, signal) => core.getTransaction(txid, { signal }))).value.raw, coreNetwork) : { mns: m.owned, mismatch: [] };
      if (live) setMns({ loading: false, owned: proved.mns, missing: m.missing, mismatch: proved.mismatch, smlNodes, ...(smlError ? { error: smlError } : {}) });
    })().catch((e) => live && setMns({ ...EMPTY_MNS, error: errorText(e) }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSig, bridge, dapi, coreNetwork, mnNonce, status]);

  // ---- current votes (bridge's verified live vote set) ----
  const currentVotes = useCallback(
    async (govHashes: string[]): Promise<Map<string, CurrentVote>> => {
      const out = new Map<string, CurrentVote>();
      if (!bridge) return out;
      await Promise.all(
        govHashes.map(async (h) => {
          try {
            const vs = await bridge.votes(h);
            for (const v of vs.votes) if (v.signal === 1) out.set(currentKey(v, h), { outcome: v.outcome, time: v.time });
          } catch {
            /* no live tally yet (new proposal): no current votes */
          }
        }),
      );
      return out;
    },
    [bridge],
  );

  const updateWatched = useCallback(
    (f: (w: WatchedVote[]) => WatchedVote[]) => {
      // computed from (and written to) the ref synchronously, so the watchdog's "unchanged" check always sees the latest records
      const next = pruneWatched(f(watchedRef.current), nowS());
      watchedRef.current = next;
      // memory-only keyrings keep nothing on the device, not even signed votes
      if (identityId && !memoryOnly) saveWatched(localStorage, coreNetwork, identityId, next);
      setWatched(next);
    },
    [identityId, coreNetwork, memoryOnly, setWatched],
  );

  /** Rewrites the PENDING backup. `create`: may create it (the user opted in); otherwise only an existing one is kept current. */
  const backupPending = useCallback(
    async (list: WatchedVote[], create: boolean) => {
      const k = kr.current;
      if (!k || memoryOnly || !session || (!create && !k.pendingDoc)) return;
      if (needsConfirm) throw new Error('Confirm the keyring’s unlockers before backing up votes.');
      k.pending = { keyringId: k.content.keyringId.slice(), votes: list.filter(isOpen).slice(0, PENDING_CAPS[2].votes).map(toPending) };
      await savePending(await storeCtx(), session, k);
      auth.refreshBalance();
    },
    [memoryOnly, needsConfirm, session, storeCtx, auth],
  );

  const send = useCallback(
    async (v: WatchedVote, relay: string): Promise<WatchedVote> => {
      const st = await new RelayClient(relay).submit(v, coreNetwork);
      return { ...v, refs: [...v.refs.filter((r) => r.relay !== relay), { relay, id: st.id }], relayStatus: { ...v.relayStatus, [relay]: st.status } };
    },
    [coreNetwork],
  );

  /**
   * Cancels a held vote on EVERY relay that holds it (signed cancel). Returns 'cancelled' only when no relay will broadcast it any more;
   * 'sent' when some relay already broadcast it (or is broadcasting it).
   */
  const cancelEverywhere = useCallback(
    async (v: WatchedVote): Promise<'cancelled' | 'sent' | 'unknown'> => {
      const k = kr.current;
      const owner = mns.owned.find((m) => mnId(m) === mnId(v));
      const key = k && owner ? k.content.keys[owner.keyIndex] : undefined;
      if (!key) throw new Error('Unlock the keyring holding this masternode’s voting key to cancel.');
      const sig = cancelSignature(key.privateKey, key.compressed, coreNetwork, v.voteHash);
      // a watchdog re-send may be on its way to another relay: wait for it, then use the latest refs
      await inflightRef.current.get(v.voteHash)?.catch(() => {});
      v = watchedRef.current.find((x) => x.voteHash === v.voteHash) ?? v;
      // No relay id: the submission's answer was lost, so a relay may hold it without us knowing which. It cannot be cancelled
      // safely (re-submitting to find it could store and release it); the caller treats it as possibly sent.
      if (!v.refs.length) return 'unknown';
      let sent = false;
      let firstError: unknown = null;
      // every relay is tried even when one fails, so one unreachable relay never leaves the others holding the vote
      for (const r of v.refs) {
        try {
          await new RelayClient(r.relay).cancel(r.id, sig);
        } catch (e) {
          if (e instanceof RelayError && e.status === 404) continue; // it never held it
          // 409 not-held: only sending / broadcast / confirmed mean the vote went (or is going) out; failed, superseded and
          // cancelled are dead
          if (e instanceof RelayError && e.status === 409) {
            if (['sending', 'broadcast', 'confirmed'].includes(e.voteStatus ?? '')) sent = true;
            continue;
          }
          firstError ??= e;
        }
      }
      if (firstError) throw firstError;
      return sent ? 'sent' : 'cancelled';
    },
    [mns.owned, coreNetwork],
  );

  const cast = useCallback(
    (intents: Intent[], opts: CastOptions, deadline: number | null, currentIn: Map<string, CurrentVote>) =>
      run(opts.mode === 'now' ? 'Signing and sending the votes' : 'Signing and scheduling the votes', async () => {
        const k = kr.current;
        if (!k) throw new Error('Unlock the keyring first.');
        if (!relays.length) throw new Error('No relay is configured (Settings, Relays).');
        // A vote of ours that is still held for the same masternode and proposal would be broadcast later and win (a later nTime):
        // cancel it, but only once a new vote can actually be made for that masternode (planned first). One that already went
        // out counts as the current vote (Core's 1-hour rule and "later wins" apply to it), and those masternodes are re-planned.
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
        const planWith = (cur: Map<string, CurrentVote>, list: Intent[]): PlanResult => (window ? planDeferred(list, cur, now, window) : planImmediate(list, cur, now));
        const current = new Map(currentIn);
        for (const w of watchedRef.current.filter((x) => isOpen(x) && x.status !== 'held')) {
          const ck = currentKey(w, w.govHash);
          const c = current.get(ck);
          if (!c || c.time < w.time) current.set(ck, { outcome: w.outcome, time: w.time });
        }
        let plan = planWith(current, intents);
        // masternodes that get a new vote, plus those whose new choice equals the current vote (skipped as "already voted"):
        // a held vote of ours for either would otherwise go out later and win
        const keep = new Set([
          ...plan.ok.map((p) => currentKey(p.mn, p.govHash)),
          ...intents.filter((i) => current.get(currentKey(i.mn, i.govHash))?.outcome === i.outcome).map((i) => currentKey(i.mn, i.govHash)),
        ]);
        const cancelled: string[] = [];
        let replan = false;
        castingRef.current = true;
        try {
          for (const w of watchedRef.current.filter((x) => x.status === 'held' && keep.has(currentKey(x, x.govHash)))) {
            if ((await cancelEverywhere(w)) === 'cancelled') cancelled.push(w.voteHash);
            else {
              // went out, or cannot be cancelled safely: it counts as the current vote, and the new one is timed after it
              replan = true;
              const ck = currentKey(w, w.govHash);
              const c = current.get(ck);
              if (!c || c.time < w.time) current.set(ck, { outcome: w.outcome, time: w.time });
            }
          }
        } finally {
          if (cancelled.length) updateWatched((list) => list.map((x) => (cancelled.includes(x.voteHash) ? { ...x, status: 'cancelled' } : x)));
        }
        if (replan) plan = planWith(current, intents);
        const signed: WatchedVote[] = plan.ok.map((p) => {
          const owner = mns.owned.find((m) => mnId(m) === mnId(p.mn));
          const key = owner ? k.content.keys[owner.keyIndex] : undefined;
          if (!key) throw new Error(`No key for masternode ${p.mn.proTxHash.slice(0, 12)}…`);
          return { ...signPlanned(p, key.privateKey, key.compressed, coreNetwork), refs: [], status: 'held', rebroadcasts: 0 };
        });
        // deferred: random delays (unlinkability); immediate: the first few at once, then paced under a relay's per-IP limit
        const delays = opts.mode === 'deferred' ? submitDelays(signed.length, Math.min(30_000, 2000 * signed.length)) : signed.map((_, i) => Math.max(0, i - 9) * IMMEDIATE_PACE_MS);
        const order = signed.map((_, i) => i).sort((a, b) => delays[a]! - delays[b]!);
        const sent: WatchedVote[] = [];
        let waited = 0;
        const failures: string[] = [];
        for (const i of order) {
          const d = delays[i]! - waited;
          if (d > 0) await new Promise((r) => setTimeout(r, d));
          waited += Math.max(0, d);
          const relay = relays[Math.floor(Math.random() * relays.length)]!;
          try {
            sent.push(await send(signed[i]!, relay));
          } catch (e) {
            failures.push(`not accepted by a relay yet (kept and retried) ${signed[i]!.proTxHash.slice(0, 10)}…: ${errorText(e)}`);
            sent.push(signed[i]!); // kept: the watchdog re-sends it
          }
          updateWatched((w) => mergeWatched(w, [sent[sent.length - 1]!]));
        }
        // the backup is created only when the user asks for it, but an existing one is always kept current (cancelled votes leave it)
        const backup = mergeWatched(watchedRef.current, sent).map((x) => (cancelled.includes(x.voteHash) ? { ...x, status: 'cancelled' as const } : x));
        await backupPending(backup, opts.mode === 'deferred' && !!opts.backupOnPlatform).catch((e) => failures.push(`backup on Platform failed: ${errorText(e)}`));
        if (failures.length) setError(failures.join('; '));
        castingRef.current = false;
        return plan;
      }).finally(() => {
        castingRef.current = false;
      }),
    [run, relays, coreNetwork, mns.owned, send, updateWatched, backupPending, cancelEverywhere],
  );

  const submitSigned = useCallback(
    (v: Omit<WatchedVote, 'refs' | 'status' | 'rebroadcasts'>) =>
      run('Sending the signed vote', async () => {
        if (!relays.length) throw new Error('No relay is configured (Settings, Relays).');
        const w = await send({ ...v, refs: [], status: 'held', rebroadcasts: 0 }, relays[0]!);
        updateWatched((list) => mergeWatched(list, [w]));
      }),
    [run, relays, send, updateWatched],
  );

  const cancel = useCallback(
    (voteHash: string) =>
      run('Cancelling the held vote', async () => {
        const v = watchedRef.current.find((x) => x.voteHash === voteHash);
        if (!v) return;
        castingRef.current = true;
        const r = await cancelEverywhere(v).finally(() => (castingRef.current = false));
        if (r === 'unknown') {
          // never re-sent from here any more; only a relay that silently got the lost submission could still release it
          updateWatched((list) => list.map((x) => (x.voteHash === voteHash ? { ...x, restored: true } : x)));
          throw new Error('It is not known whether a relay holds this vote (its submission was never confirmed). This browser will not send it again, but if a relay did receive it, it could still be released: vote again to be sure, the new vote is timed later and wins.');
        }
        updateWatched((list) => list.map((x) => (x.voteHash === voteHash ? { ...x, status: r === 'cancelled' ? 'cancelled' : 'broadcast' } : x)));
        if (r !== 'cancelled') throw new Error('Too late: a relay has already broadcast this vote. Vote again to change it (Core allows one change per hour).');
        await backupPending(watchedRef.current.filter((x) => x.voteHash !== voteHash), false).catch(() => {});
      }),
    [run, cancelEverywhere, updateWatched, backupPending],
  );

  // ---- watchdog: relay status, bridge confirmation, re-broadcast (every 30 s; never re-run by its own updates) ----
  const relaysKey = relays.join(' ');
  useEffect(() => {
    if (!identityId || mode !== 'live') return;
    let stop = false;
    const configured = new Set(relays);
    let running = false;
    const tick = async () => {
      if (running) return; // a slow tick (relays timing out) is never overlapped
      running = true;
      try {
        await tickOnce();
      } finally {
        running = false;
      }
    };
    const tickOnce = async () => {
      const open = watchedRef.current.filter(isOpen);
      if (!open.length || stop) return;
      const byGov = new Map<string, Map<string, BridgeVote>>();
      if (bridge) {
        for (const h of new Set(open.map((v) => v.govHash))) {
          try {
            byGov.set(h, new Map((await bridge.votes(h)).votes.map((x) => [mnId(x), x])));
          } catch {
            /* no tally yet */
          }
        }
      }
      const now = nowS();
      const updates: WatchedVote[] = [];
      // an update is applied only to the record this tick started from (a cancel or a new cast in the meantime wins)
      const from = new Map(open.map((v) => [v.voteHash, v]));
      for (const v of open) {
        let status: WatchStatus = v.status;
        let relayStatus = v.relayStatus ?? {};
        let refs = v.refs;
        let rebroadcasts = v.rebroadcasts;
        const verdict = bridgeVerdict(v, byGov.get(v.govHash)?.get(mnId(v)));
        if (verdict) status = verdict;
        else {
          // only relays the user configured are contacted (a ref from elsewhere is never followed)
          for (const r of v.refs.filter((x) => configured.has(x.relay))) {
            try {
              const st = await new RelayClient(r.relay).status(r.id);
              if (st && st.status !== relayStatus[r.relay]) relayStatus = { ...relayStatus, [r.relay]: st.status };
            } catch {
              /* relay down: the re-broadcast below covers it */
            }
          }
          const all = Object.values(relayStatus);
          if (all.some((x) => x === 'broadcast' || x === 'confirmed' || x === 'sending')) status = 'broadcast';
          else if (all.length && all.every((x) => x === 'cancelled')) status = 'cancelled';
          else if (all.length && all.every((x) => x === 'failed' || x === 'superseded' || x === 'cancelled')) status = all.includes('superseded') ? 'superseded' : 'failed';
          const unchanged = !castingRef.current && watchedRef.current.find((x) => x.voteHash === v.voteHash) === v;
          if (unchanged && isOpen({ ...v, status }) && needsRebroadcast(v, now)) {
            const relay = pickRebroadcastRelay(v, relays);
            if (relay) {
              rebroadcasts += 1;
              try {
                const p = send(v, relay);
                inflightRef.current.set(v.voteHash, p);
                let n: WatchedVote;
                try {
                  n = await p;
                } finally {
                  inflightRef.current.delete(v.voteHash);
                }
                refs = n.refs;
                relayStatus = { ...relayStatus, ...n.relayStatus };
                // the new relay's id is recorded at once, whatever happens to this tick's other updates, so it can be cancelled
                const ref = n.refs.find((r) => r.relay === relay);
                if (ref && !stop) {
                  updateWatched((w) => w.map((x) => (x.voteHash === v.voteHash && !x.refs.some((r) => r.relay === relay) ? { ...x, refs: [...x.refs, ref] } : x)));
                  // that write replaced the record; this tick's own update below still applies to it
                  const now2 = watchedRef.current.find((x) => x.voteHash === v.voteHash);
                  if (from.get(v.voteHash) === v && now2) from.set(v.voteHash, now2);
                }
              } catch (e) {
                // a rate-limited relay (429) did not see the vote: that attempt does not count, the next tick retries
                if (e instanceof RelayError && e.status === 429) rebroadcasts -= 1;
              }
            }
          }
        }
        if (status !== v.status || relayStatus !== (v.relayStatus ?? {}) || refs !== v.refs || rebroadcasts !== v.rebroadcasts) updates.push({ ...v, status, relayStatus, refs, rebroadcasts });
      }
      if (updates.length && !stop) updateWatched((w) => w.map((x) => (from.get(x.voteHash) === x ? (updates.find((u) => u.voteHash === x.voteHash) ?? x) : x)));
    };
    void tick();
    const t = setInterval(() => void tick(), 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityId, mode, bridge, relaysKey, send, updateWatched]);

  const value = useMemo<Ctx>(
    () => ({
      status,
      error,
      canUsePlatform: !!session && (!!session.wallet || session.source === 'passkey'),
      memoryOnly,
      keyring,
      busy,
      mns,
      watched,
      coreNetwork,
      relays,
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
      submitSigned,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, error, session, memoryOnly, needsConfirm, confirmUnlockers, keyring, version, busy, mns, watched, coreNetwork, relays, unlockWithPasskey, unlockWithPhrase, createKeyring, lock, addKey, removeKey, setNodeLabel, setIdleMinutes, addPasskeyUnlocker, removeUnlockerKey, saveToPlatform, currentVotes, cast, cancel, submitSigned],
  );
  return <C.Provider value={value}>{children}</C.Provider>;
}
