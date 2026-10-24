// Masternode keyring and voting state (PLAN §5.1-5.2): "add my masternodes" once, sign in again later and they are back.
//
// Keys live in this tab's memory while the keyring is open. Saved keyrings are encrypted in the browser (@govhub/auth keyring) to
// the recovery phrase and the user's passkeys and stored in `forum.keyring`; the operator only ever sees ciphertext. A seed sign-in
// opens it at once, a passkey sign-in with the same ceremony; a pasted-key session cannot open it (memory-only keys still work).
// After the idle timeout the keys are wiped and the keyring has to be unlocked again (passkey or phrase).
import {
  addUnlocker,
  emptyKeyring,
  identifierBytes,
  KeyringLockedError,
  loadKeyring,
  passkeyUnlockKey,
  prfInput,
  removeUnlocker,
  savePending,
  saveKeys,
  seedUnlockKey,
  seedUnlockKeyFromEntropy,
  SeedWallet,
  UnlockerType,
  type KeyringContext as StoreCtx,
  type OpenedKeyring,
  type UnlockKey,
} from '@govhub/auth';
import { hexToBytes, isValidPrivateKey } from '@govhub/auth';
import { getPasskeyPrf } from '@govhub/auth/webauthn';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../app/context.tsx';
import { useAuth } from '../auth/context.tsx';
import { errorText, rpId } from '../auth/runtime.ts';
import { enabledBridges } from '../config/registry.ts';
import { HttpBridge, type Bridge, type BridgeVote } from '../data/bridge.ts';
import { createWebDapi, dapiConfig } from '../data/dapi.ts';
import { getSdk } from '../data/platform.ts';
import { getPlatformPort } from '../auth/runtime.ts';
import type { SmlEntry } from '../verify/votes.ts';
import { matchMasternodes, proveCollaterals, votingKeyId, type OwnedMasternode } from './masternodes.ts';
import { bridgeVerdict, fromPending, isOpen, loadWatched, mergeWatched, needsRebroadcast, pickRebroadcastRelay, pruneWatched, saveWatched, toPending, type WatchedVote } from './pending.ts';
import { currentKey, deferredWindow, mnId, planDeferred, planImmediate, signPlanned, submitDelays, type CurrentVote, type Intent, type PlanResult } from './plan.ts';
import { cancelSignature, normalizeRelayUrl, RelayClient } from './relay.ts';
import { KEYRING_STASH_EVENT, takeStash } from './stash.ts';
import { decodeWif, governanceVoteHash } from '@govhub/verify';

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
const EMPTY_MNS: MnState = { loading: false, owned: [], missing: [], mismatch: [], smlNodes: 0 };

export function parseVotingKey(input: string, network: 'mainnet' | 'testnet'): { privateKey: Uint8Array; compressed: boolean } {
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
  const [watched, setWatched] = useState<WatchedVote[]>([]);
  const kr = useRef<OpenedKeyring | null>(null);
  kr.current = keyring;
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
      if (k.authenticated === false) setError('This keyring does not list your recovery phrase as an unlocker. Someone who held a key of this identity may have replaced it: check the unlockers below and remove any you do not recognise before adding keys.');
      // restore pending votes kept on Platform into the local watch list
      if (k.pending.votes.length && identityId) {
        const restored = k.pending.votes.map((p) => {
          const voteHash = governanceVoteHash({ collateralTxid: p.collateralTxid, collateralIndex: p.collateralIndex, govHashDisplay: p.govHash, signal: 1, outcome: p.outcome, time: p.time });
          return fromPending(p, '', voteHash);
        });
        setWatched((w) => {
          const known = new Set(w.map((x) => x.voteHash));
          const merged = mergeWatched(w, restored.filter((r) => !known.has(r.voteHash)));
          saveWatched(localStorage, coreNetwork, identityId, merged);
          return merged;
        });
      }
    },
    [identityId, coreNetwork],
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
  const idleMinutes = keyring?.content.idleLockMinutes ?? 15;
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

  const persist = useCallback(async () => {
    const k = kr.current;
    if (!k || memoryOnly || !session) return;
    await saveKeys(await storeCtx(), session, k);
    auth.refreshBalance();
  }, [memoryOnly, session, storeCtx, auth]);

  // a passkey added (Passkeys.tsx) while the keyring is open becomes an unlocker
  useEffect(() => {
    const on = () => {
      if (!identityId) return;
      const s = takeStash(identityId);
      if (!s) return;
      const k = kr.current;
      if (s.purpose === 'add' && k && !memoryOnly) {
        if (addUnlocker(k, s.key)) void run('Adding the passkey as an unlocker', persist).then(touch, () => {});
      }
      s.key.wipe();
    };
    addEventListener(KEYRING_STASH_EVENT, on);
    return () => removeEventListener(KEYRING_STASH_EVENT, on);
  }, [identityId, memoryOnly, run, persist]);

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

  const addKey = useCallback(
    (input: string, label: string) =>
      run('Adding the voting key', async () => {
        const k = kr.current;
        if (!k) throw new Error('Open the keyring first.');
        const { privateKey, compressed } = parseVotingKey(input, coreNetwork);
        const id = votingKeyId(privateKey, compressed);
        if (k.content.keys.some((x) => votingKeyId(x.privateKey, x.compressed) === id)) {
          privateKey.fill(0);
          throw new Error('That voting key is in the keyring already.');
        }
        k.content.keys.push({ privateKey, compressed, label });
        try {
          await persist();
        } catch (e) {
          k.content.keys.pop()?.privateKey.fill(0);
          throw e;
        }
        touch();
        setMnNonce((n) => n + 1);
      }),
    [run, coreNetwork, persist],
  );

  const removeKey = useCallback(
    (index: number) =>
      run('Removing the voting key', async () => {
        const k = kr.current;
        if (!k) return;
        const [gone] = k.content.keys.splice(index, 1);
        await persist();
        gone?.privateKey.fill(0);
        touch();
        setMnNonce((n) => n + 1);
      }),
    [run, persist],
  );

  const setNodeLabel = useCallback(
    (proTxHash: string, label: string) =>
      run('Saving the label', async () => {
        const k = kr.current;
        if (!k) return;
        const others = k.content.labels.filter((l) => l.proTxHash !== proTxHash);
        k.content.labels = label.trim() ? [...others, { proTxHash, label: label.trim() }] : others;
        await persist();
        touch();
      }),
    [run, persist],
  );

  const setIdleMinutes = useCallback(
    (m: number) =>
      run('Saving the idle lock', async () => {
        const k = kr.current;
        if (!k) return;
        k.content.idleLockMinutes = m;
        await persist();
        touch();
      }),
    [run, persist],
  );

  const addPasskeyUnlocker = useCallback(
    () =>
      run('Adding a passkey unlocker', async () => {
        const k = kr.current;
        if (!k || memoryOnly) throw new Error('Open a saved keyring first.');
        const a = await getPasskeyPrf({ rpId: rpId(), prfInput: prfInput(identifierBytes(registry.forum.contractId)) });
        const key = passkeyUnlockKey(a.prfOutput);
        a.prfOutput.fill(0);
        try {
          if (!addUnlocker(k, key)) throw new Error('This passkey already unlocks the keyring.');
        } finally {
          key.wipe();
        }
        await persist();
        touch();
      }),
    [run, memoryOnly, registry.forum.contractId, persist],
  );

  const removeUnlockerKey = useCallback(
    (recipientKey: Uint8Array) =>
      run('Removing the unlocker', async () => {
        const k = kr.current;
        if (!k) return;
        removeUnlocker(k, recipientKey);
        await persist();
        touch();
      }),
    [run, persist],
  );

  const saveToPlatform = useCallback(
    () =>
      run('Saving the keyring on Platform', async () => {
        const k = kr.current;
        if (!k || !session) throw new Error('Nothing to save.');
        const seed = seedUnlockKey(session);
        if (!seed) throw new Error('Saving needs your recovery phrase in this session. A pasted key cannot open a saved keyring.');
        // merge into an existing keyring rather than replacing it blindly
        const ctx = await storeCtx();
        const existing = await loadKeyring(ctx, k.ownerId, seed, seed).catch((e) => (e instanceof KeyringLockedError ? null : Promise.reject(e)));
        if (existing) {
          for (const key of k.content.keys) if (!existing.content.keys.some((x) => votingKeyId(x.privateKey, x.compressed) === votingKeyId(key.privateKey, key.compressed))) existing.content.keys.push({ ...key, privateKey: key.privateKey.slice() });
          await saveKeys(ctx, session, existing);
          seed.wipe();
          opened(existing, false);
        } else {
          addUnlocker(k, seed);
          seed.wipe();
          k.keysDoc = (await ctx.store.get(k.ownerId, 0)) ?? null;
          await saveKeys(ctx, session, k);
          setMemoryOnly(false);
          touch();
        }
        auth.refreshBalance();
      }),
    [run, session, storeCtx, opened, auth],
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
      setWatched((w) => {
        const next = pruneWatched(f(w), nowS());
        if (identityId) saveWatched(localStorage, coreNetwork, identityId, next);
        return next;
      });
    },
    [identityId, coreNetwork],
  );

  const backupPending = useCallback(
    async (list: WatchedVote[]) => {
      const k = kr.current;
      if (!k || memoryOnly || !session) return;
      k.pending = { votes: list.filter(isOpen).slice(0, 60).map(toPending) };
      await savePending(await storeCtx(), session, k);
      auth.refreshBalance();
    },
    [memoryOnly, session, storeCtx, auth],
  );

  const send = useCallback(
    async (v: WatchedVote, relay: string): Promise<WatchedVote> => {
      const st = await new RelayClient(relay).submit(v, coreNetwork);
      return { ...v, refs: [...v.refs.filter((r) => r.relay !== relay), { relay, id: st.id }], relayStatus: { ...v.relayStatus, [relay]: st.status } };
    },
    [coreNetwork],
  );

  const cast = useCallback(
    (intents: Intent[], opts: CastOptions, deadline: number | null, current: Map<string, CurrentVote>) =>
      run(opts.mode === 'now' ? 'Signing and sending the votes' : 'Signing and scheduling the votes', async () => {
        const k = kr.current;
        if (!k) throw new Error('Unlock the keyring first.');
        if (!relays.length) throw new Error('No relay is configured (Settings, Relays).');
        const now = nowS();
        let plan: PlanResult;
        if (opts.mode === 'now') plan = planImmediate(intents, current, now);
        else {
          if (!deadline) throw new Error('The voting deadline is not known yet (no cycle data).');
          const w = deferredWindow(now, deadline, coreNetwork);
          if (!w) throw new Error('There is not enough time left before the voting deadline for a randomized schedule. Vote now instead.');
          const latest = Math.min(w.latest, opts.latest ?? Infinity);
          if (latest <= w.earliest) throw new Error('The release window ends too soon.');
          plan = planDeferred(intents, current, now, { earliest: w.earliest, latest });
        }
        const signed: WatchedVote[] = plan.ok.map((p) => {
          const owner = mns.owned.find((m) => mnId(m) === mnId(p.mn));
          const key = owner ? k.content.keys[owner.keyIndex] : undefined;
          if (!key) throw new Error(`No key for masternode ${p.mn.proTxHash.slice(0, 12)}…`);
          return { ...signPlanned(p, key.privateKey, key.compressed, coreNetwork), refs: [], status: 'held', rebroadcasts: 0 };
        });
        const delays = opts.mode === 'deferred' ? submitDelays(signed.length, Math.min(30_000, 2000 * signed.length)) : signed.map(() => 0);
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
            failures.push(`${signed[i]!.proTxHash.slice(0, 10)}…: ${errorText(e)}`);
            sent.push(signed[i]!); // kept: the watchdog re-sends it
          }
          updateWatched((w) => mergeWatched(w, [sent[sent.length - 1]!]));
        }
        if (opts.mode === 'deferred' && opts.backupOnPlatform) await backupPending(mergeWatched(watched, sent)).catch((e) => failures.push(`backup on Platform failed: ${errorText(e)}`));
        if (failures.length) setError(`Some votes were not accepted by a relay yet (they are kept and retried): ${failures.join('; ')}`);
        return plan;
      }),
    [run, relays, coreNetwork, mns.owned, send, updateWatched, backupPending, watched],
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
        const k = kr.current;
        const v = watched.find((x) => x.voteHash === voteHash);
        if (!v) return;
        const owner = mns.owned.find((m) => mnId(m) === mnId(v));
        const key = k && owner ? k.content.keys[owner.keyIndex] : undefined;
        if (!key) throw new Error('Unlock the keyring holding this masternode’s voting key to cancel.');
        const sig = cancelSignature(key.privateKey, key.compressed, coreNetwork, voteHash);
        const results = await Promise.allSettled(v.refs.map((r) => new RelayClient(r.relay).cancel(r.id, sig)));
        const ok = results.some((r) => r.status === 'fulfilled' && r.value === 'cancelled');
        updateWatched((list) => list.map((x) => (x.voteHash === voteHash ? { ...x, status: ok ? 'cancelled' : x.status } : x)));
        if (!ok) throw new Error('No relay could cancel it: it may have been broadcast already.');
        await backupPending(watched.filter((x) => x.voteHash !== voteHash)).catch(() => {});
      }),
    [run, watched, mns.owned, coreNetwork, updateWatched, backupPending],
  );

  // ---- watchdog: relay status, bridge confirmation, re-broadcast ----
  useEffect(() => {
    if (!identityId || mode !== 'live') return;
    let stop = false;
    const tick = async () => {
      const open = watched.filter(isOpen);
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
      for (const v of open) {
        let n: WatchedVote = v;
        const verdict = bridgeVerdict(v, byGov.get(v.govHash)?.get(mnId(v)));
        if (verdict) n = { ...n, status: verdict };
        else {
          for (const r of v.refs) {
            try {
              const st = await new RelayClient(r.relay).status(r.id);
              if (st) n = { ...n, relayStatus: { ...n.relayStatus, [r.relay]: st.status }, ...(st.status === 'broadcast' || st.status === 'confirmed' ? { status: 'broadcast' as const } : {}), ...(st.status === 'cancelled' ? { status: 'cancelled' as const } : {}) };
            } catch {
              /* relay down: the re-broadcast below covers it */
            }
          }
          if (n.status !== 'cancelled' && needsRebroadcast(n, now)) {
            const relay = pickRebroadcastRelay(n, relays);
            if (relay) {
              try {
                n = { ...(await send(n, relay)), rebroadcasts: n.rebroadcasts + 1 };
              } catch {
                n = { ...n, rebroadcasts: n.rebroadcasts + 1 };
              }
            }
          }
        }
        if (n !== v) updates.push(n);
      }
      if (updates.length && !stop) updateWatched((w) => w.map((x) => updates.find((u) => u.voteHash === x.voteHash) ?? x));
    };
    void tick();
    const t = setInterval(() => void tick(), 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [identityId, mode, watched, bridge, relays, send, updateWatched]);

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
      refreshMasternodes: () => setMnNonce((n) => n + 1),
      currentVotes,
      cast,
      cancel,
      submitSigned,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, error, session, memoryOnly, keyring, version, busy, mns, watched, coreNetwork, relays, unlockWithPasskey, unlockWithPhrase, createKeyring, lock, addKey, removeKey, setNodeLabel, setIdleMinutes, addPasskeyUnlocker, removeUnlockerKey, saveToPlatform, currentVotes, cast, cancel, submitSigned],
  );
  return <C.Provider value={value}>{children}</C.Provider>;
}

export { UnlockerType };
