// Voting keys pasted without an account (what vote.dashhq.org offered): kept in this tab's memory only, never stored and never sent
// anywhere, and used only to sign username contest votes. They are wiped after 15 minutes without use, on "Forget", when the network
// changes, and when the page is hidden for good (pagehide, as the keyring does: D-025). Only keys that are some masternode's current
// voting key are kept; the rest are wiped as soon as the lookup says so. Signing in wipes them too (the keyring takes over).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../app/context.tsx';
import { useForum } from '../app/forum.tsx';
import { enabledBridges } from '../config/registry.ts';
import { HttpBridge } from '../data/bridge.ts';
import { createWebDapi, dapiConfig } from '../data/dapi.ts';
import { errText } from '../lib/format.ts';
import { castKeys } from '../voting/gate.ts';
import { lookupMasternodes, type LookupDeps } from '../voting/lookup.ts';
import { parseVotingKey, votingKeyId, votingKeyInfos, type OwnedMasternode, type VotingKeyInfo } from '../voting/masternodes.ts';

export const GUEST_IDLE_MS = 15 * 60_000;

interface GuestKey {
  privateKey: Uint8Array;
  compressed: boolean;
  label: string;
}

interface Ctx {
  status: 'empty' | 'looking' | 'ready';
  error: string | null;
  /** masternodes whose current voting key was pasted (keyIndex: into keyInfos) */
  owned: readonly OwnedMasternode[];
  /** the public side of the kept keys */
  keyInfos: readonly VotingKeyInfo[];
  /** Adds keys (one per line, WIF or hex) and looks up their masternodes. */
  add(text: string): Promise<void>;
  /** Wipes every pasted key now. */
  forget(): void;
  /** Copies of the keys for one signing (castKeys: wipe() right after); null when there are none. Counts as use (idle timer). */
  copyKeys(): ReturnType<typeof castKeys> | null;
}

const GuestCtx = createContext<Ctx | null>(null);

export function useGuestKeys(): Ctx {
  const c = useContext(GuestCtx);
  if (!c) throw new Error('useGuestKeys outside GuestKeysProvider');
  return c;
}

export function GuestKeysProvider({ children }: { children: ReactNode }) {
  const { registry, mode } = useApp();
  const network = registry.coreNetwork;
  const keys = useRef<GuestKey[]>([]);
  const [owned, setOwned] = useState<OwnedMasternode[]>([]);
  const [keyInfos, setKeyInfos] = useState<VotingKeyInfo[]>([]);
  const [status, setStatus] = useState<Ctx['status']>('empty');
  const [error, setError] = useState<string | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  // bumped by every forget: a lookup that started before one must not bring keys back
  const generation = useRef(0);

  const forget = useCallback(() => {
    generation.current++;
    for (const k of keys.current) k.privateKey.fill(0);
    keys.current = [];
    if (idle.current) clearTimeout(idle.current);
    idle.current = null;
    setOwned([]);
    setKeyInfos([]);
    setStatus('empty');
    setError(null);
  }, []);
  const touch = useCallback(() => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = keys.current.length ? setTimeout(forget, GUEST_IDLE_MS) : null;
  }, [forget]);

  // another network: these keys belong to the old one; a sign-in: the keyring takes over
  const signedIn = useForum().session?.identityId ?? null;
  useEffect(() => forget, [network, signedIn, forget]);
  useEffect(() => {
    const off = () => forget();
    addEventListener('pagehide', off);
    return () => removeEventListener('pagehide', off);
  }, [forget]);

  const bridgeEndpoint = enabledBridges(registry)[0] ?? null;
  const deps = useMemo<LookupDeps | null>(() => {
    if (mode !== 'live' || !bridgeEndpoint) return null;
    const bridge = new HttpBridge(bridgeEndpoint.name, bridgeEndpoint.httpBase);
    const dapi = createWebDapi(dapiConfig(registry));
    return {
      mnlist: () => bridge.mnlist(),
      sml: (signal) => dapi.getSml({ signal }),
      rawTx: async (txid, signal) => (await dapi.call((core, s) => core.getTransaction(txid, { signal: s }), { signal })).value.raw,
      network,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, bridgeEndpoint?.name, bridgeEndpoint?.httpBase, registry, network]);

  const add = useCallback(
    async (text: string) => {
      setError(null);
      const lines = text
        .split(/\s+/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) return setError('Paste a voting key.');
      if (!deps) return setError(mode === 'live' ? 'No bridge is configured (Settings): the masternode list comes from a bridge.' : 'In demo mode, sign in as a sample user to try voting.');
      const parsed: GuestKey[] = [];
      try {
        lines.forEach((l, i) => {
          try {
            parsed.push({ ...parseVotingKey(l, network), label: '' });
          } catch (e) {
            throw new Error(lines.length > 1 ? `Key ${i + 1}: ${errText(e)}` : errText(e));
          }
        });
      } catch (e) {
        for (const k of parsed) k.privateKey.fill(0);
        return setError(errText(e));
      }
      // already kept: not added twice
      const have = new Set(keys.current.map((k) => votingKeyId(k.privateKey, k.compressed)));
      const fresh = parsed.filter((k) => {
        const id = votingKeyId(k.privateKey, k.compressed);
        if (have.has(id)) return (k.privateKey.fill(0), false);
        have.add(id);
        return true;
      });
      const all = [...keys.current, ...fresh];
      const base = all.length - fresh.length;
      const gen = generation.current;
      setStatus('looking');
      try {
        const r = await lookupMasternodes(
          all.map((k, index) => ({ index, keyId: votingKeyId(k.privateKey, k.compressed) })),
          deps,
          { signal: new AbortController().signal },
        );
        // forgotten meanwhile (idle, network, pagehide): the new keys go too
        if (gen !== generation.current) {
          for (const k of fresh) k.privateKey.fill(0);
          return;
        }
        const used = new Set(r.owned.map((m) => m.keyIndex));
        const kept: GuestKey[] = [];
        const remap = new Map<number, number>();
        all.forEach((k, i) => {
          if (used.has(i)) {
            remap.set(i, kept.length);
            kept.push(k);
          } else k.privateKey.fill(0);
        });
        // a key held before but not kept now (another lookup ran meanwhile) is wiped, never just dropped
        for (const k of keys.current) if (!kept.includes(k)) k.privateKey.fill(0);
        keys.current = kept;
        setOwned(r.owned.map((m) => ({ ...m, keyIndex: remap.get(m.keyIndex)! })));
        setKeyInfos(votingKeyInfos(kept));
        setStatus(kept.length ? 'ready' : 'empty');
        if (!used.size) setError(fresh.length === 1 ? 'No masternode uses this key as its voting key.' : 'No masternode uses these keys as its voting key.');
        else if (fresh.some((_, j) => !used.has(base + j))) setError('Some of these keys are not any masternode’s voting key; they were dropped.');
        touch();
      } catch (e) {
        for (const k of fresh) k.privateKey.fill(0);
        setStatus(keys.current.length ? 'ready' : 'empty');
        setError(`The masternode list could not be read: ${errText(e)}`);
      }
    },
    [deps, mode, network, touch],
  );

  const copyKeys = useCallback(() => {
    if (!keys.current.length) return null;
    touch();
    return castKeys(keys.current, owned);
  }, [owned, touch]);

  const value = useMemo<Ctx>(() => ({ status, error, owned, keyInfos, add, forget, copyKeys }), [status, error, owned, keyInfos, add, forget, copyKeys]);
  return <GuestCtx.Provider value={value}>{children}</GuestCtx.Provider>;
}
