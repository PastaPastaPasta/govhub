// The keyring's key -> masternode lookup, one path for the keyring page and every vote panel (they read the same result).
//
// Steps, each with its own deadline so the whole lookup always ends (at most ~BRIDGE + SML + PROTX seconds):
//   1. the bridge's masternode list (collateral outpoints; the SML has none)
//   2. the masternode list several DAPI evonodes agree on: decides key, type and validity (masternodes.ts matchMasternodes)
//   3. each match's ProRegTx: proves the outpoint and gives the payout address (masternodes.ts proveCollaterals)
// If step 2 fails or times out, the bridge's list is used and labelled (a warning, with retry). If step 3 times out, the bridge's
// outpoints stay, labelled. Only when the bridge itself cannot be read is the lookup an error.
import type { AgreedSml } from '@govhub/dapi';
import type { BridgeMnList } from '../data/bridge.ts';
import type { SmlEntry } from '../verify/votes.ts';
import { matchMasternodes, proveCollaterals, type KeyRef, type OwnedMasternode } from './masternodes.ts';

export type LookupStep = 'bridge' | 'sml' | 'protx';

export interface LookupResult {
  owned: OwnedMasternode[];
  /** listed for our key in the SML but not (yet) in the bridge's list: cannot vote */
  missing: string[];
  /** the bridge named another collateral than the ProRegTx: dropped */
  mismatch: string[];
  /** DAPI nodes that agreed on the SML (0: not checked) */
  smlNodes: number;
  /** something could not be checked; the result is still usable */
  warning?: string;
}

export interface LookupDeps {
  mnlist(signal: AbortSignal): Promise<BridgeMnList>;
  /** null: no DAPI in this mode (fixtures) */
  sml: ((signal: AbortSignal) => Promise<AgreedSml>) | null;
  /** raw transaction bytes by txid (DAPI getTransaction) */
  rawTx: ((txid: string, signal: AbortSignal) => Promise<Uint8Array>) | null;
  network: 'mainnet' | 'testnet';
}

export const LOOKUP_TIMEOUTS = { bridgeMs: 15_000, smlMs: 25_000, protxMs: 20_000 };

export class LookupTimeout extends Error {
  constructor(readonly step: LookupStep, readonly ms: number) {
    super(`${STEP_NAME[step]} took longer than ${Math.round(ms / 1000)} s`);
    this.name = 'LookupTimeout';
  }
}

export const STEP_NAME: Record<LookupStep, string> = {
  bridge: "reading the bridge's masternode list",
  sml: 'checking the masternode list with DAPI evonodes',
  protx: 'proving each collateral from its registration transaction',
};

/** Runs `fn` with a signal that aborts after `ms` or when `outer` aborts; rejects with LookupTimeout on the deadline. */
async function step<T>(name: LookupStep, ms: number, outer: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (outer.aborted) throw outer.reason;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(outer.reason);
  outer.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(ctrl.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const t = new LookupTimeout(name, ms);
          ctrl.abort(t);
          reject(t);
        }, ms);
      }),
      new Promise<never>((_, reject) => ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason), { once: true })),
    ]);
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onAbort);
  }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function lookupMasternodes(
  keys: readonly KeyRef[],
  deps: LookupDeps,
  o: { signal: AbortSignal; onStep?: (s: LookupStep) => void; timeouts?: typeof LOOKUP_TIMEOUTS },
): Promise<LookupResult> {
  const t = o.timeouts ?? LOOKUP_TIMEOUTS;
  o.onStep?.('bridge');
  const list = await step('bridge', t.bridgeMs, o.signal, deps.mnlist);
  let sml: Map<string, SmlEntry> | null = null;
  let smlNodes = 0;
  let warning: string | undefined;
  if (deps.sml) {
    o.onStep?.('sml');
    try {
      const a = await step('sml', t.smlMs, o.signal, deps.sml);
      sml = new Map(a.masternodes.map((m) => [m.proTxHash, { votingAddress: m.votingAddress, isValid: m.isValid, nType: m.nType, typeProven: m.nVersion >= 2 }]));
      smlNodes = a.agreedBy.length;
    } catch (e) {
      if (o.signal.aborted) throw o.signal.reason;
      warning = `Could not confirm with DAPI evonodes (${msg(e)}), so this uses the bridge’s list.`;
    }
  }
  const m = matchMasternodes(keys, list.masternodes, sml, deps.network);
  if (!deps.rawTx || !m.owned.length) return { owned: m.owned, missing: m.missing, mismatch: [], smlNodes, ...(warning ? { warning } : {}) };
  o.onStep?.('protx');
  const rawTx = deps.rawTx;
  try {
    const proved = await step('protx', t.protxMs, o.signal, (signal) => proveCollaterals(m.owned, (txid) => rawTx(txid, signal), deps.network));
    const unproved = proved.mns.filter((x) => x.provenance.collateral !== 'protx').length;
    if (unproved && !warning) warning = `${unproved} collateral${unproved === 1 ? '' : 's'} could not be proved from the registration transaction yet; the bridge’s outpoint is used.`;
    return { owned: proved.mns, missing: m.missing, mismatch: proved.mismatch, smlNodes, ...(warning ? { warning } : {}) };
  } catch (e) {
    if (o.signal.aborted) throw o.signal.reason;
    return { owned: m.owned, missing: m.missing, mismatch: [], smlNodes, warning: warning ?? `Collaterals not proved yet (${msg(e)}); the bridge’s outpoints are used.` };
  }
}
