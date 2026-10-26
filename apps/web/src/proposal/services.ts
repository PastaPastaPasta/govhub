// What the wizard needs from the outside world, live (DAPI, the verification worker, relays, a bridge, Platform) or simulated for
// the fixture demo (`?fixtures=1`: nothing leaves the browser, no money moves, a pretend payment and a pretend relay).
import {
  buildProposalCollateral, p2pkhScript, runCollateralFunding, sessionProposalDepositKey, type CollateralFundingRecord, type CollateralFundingView, type DepositKey, type DepositKeySource,
} from '@govhub/auth';
import type { Dapi } from '@govhub/dapi';
import { bytesToHex, checkCollateralTx, decodeAddress, GOVERNANCE_FEE_CONFIRMATIONS, hexToBytes, sha256d } from '@govhub/verify';
import type { Registry } from '../config/registry.ts';
import { makeBridge } from '../data/bridgeFactory.ts';
import { createWebDapi, dapiConfig } from '../data/dapi.ts';
import type { DataSource } from '../data/repo.ts';
import type { CoreNetwork, Proposal } from '../data/types.ts';
import type { Step } from '../verify/collateral.ts';
import { runVerification } from '../verify/client.ts';
import type { DraftLock } from './draft.ts';
import { HttpProposalRelay, type HeldProposalState, type ProposalRelayPort, type SubmitBody } from './relay.ts';

export interface CollateralCheck {
  /**
   * `not-found`: no DAPI node knows the txid (not broadcast yet, or a typo); `mempool`: known, not in a block; `mined`: in a block;
   * `invalid`: the transaction does not pay this proposal's fee (a fact about its bytes); `error`: the check could not run.
   */
  state: 'not-found' | 'mempool' | 'mined' | 'invalid' | 'error';
  message?: string;
  height?: number;
  confirmations: number;
  /** `verified`: counted from the chain verified in this browser; `reported`: a node's word (or a chain proof of work does not secure). */
  basis: 'verified' | 'reported';
  /** A ChainLock covers the block (final: it cannot be reorganised away). */
  final: boolean;
  /** Why a `reported` basis is not secure (testnet). */
  weak?: string | null;
  steps?: Step[];
}

export interface FundCollateralOptions {
  record: CollateralFundingRecord;
  key: DepositKey;
  save(r: CollateralFundingRecord): void;
  /** A reason not to build the fee transaction now (see runCollateralFunding), or null. */
  guard?(): string | null;
  signal?: AbortSignal;
  onUpdate?(v: CollateralFundingView): void;
}

export interface WizardServices {
  readonly demo: boolean;
  readonly network: CoreNetwork;
  /** How often the submit step re-checks confirmations and relays. */
  readonly pollMs: number;
  checkCollateral(lock: DraftLock, txid: string): Promise<CollateralCheck>;
  fundCollateral(o: FundCollateralOptions): Promise<{ txid: string }>;
  relays(): ProposalRelayPort[];
  /** Whether a bridge (another Core node) has the proposal; null when there is no bridge to ask. */
  seenByNetwork(govHash: string): Promise<boolean | null>;
  /** Whether the proposal is on Platform (govhub lists it). */
  onGovhub(govHash: string): Promise<boolean>;
  /** Demo only: pretend a wallet paid the deposit address. */
  simulatePayment?(): void;
}

export const submitBody = (lock: DraftLock, txid: string, network: CoreNetwork): SubmitBody => ({ network, parentHash: '0', revision: 1, time: lock.time, dataHex: lock.dataHex, collateralTxid: txid });

/** The draft as the verification worker's Proposal (the fields it checks against the hashed data). */
export const lockAsProposal = (lock: DraftLock, txid: string): Proposal => ({
  govHash: lock.govHash,
  parentHash: '0',
  revision: 1,
  time: lock.time,
  dataHex: lock.dataHex,
  name: lock.name,
  url: lock.url,
  paymentAddress: lock.paymentAddress,
  paymentAmount: Number(lock.paymentDuffs),
  startEpoch: lock.startEpoch,
  endEpoch: lock.endEpoch,
  collateralTxid: txid,
  collateralHeight: 0,
});

const errCode = (e: unknown) => (e as { code?: unknown } | null)?.code;

/** A check result from a node's word, with nothing counted yet. */
const reported = (state: CollateralCheck['state'], message?: string): CollateralCheck => ({ state, confirmations: 0, basis: 'reported', final: false, ...(message === undefined ? {} : { message }) });

// ---- live ------------------------------------------------------------------------------------------------------------------------

let coreDapi: { key: string; value: Dapi } | null = null;
/** DAPI on the proposal's Core network (the main thread's; the worker has its own for proofs). */
function dapiFor(registry: Registry): Dapi {
  const cfg = dapiConfig(registry);
  const key = JSON.stringify(cfg);
  if (coreDapi?.key !== key) coreDapi = { key, value: createWebDapi(cfg) };
  return coreDapi.value;
}

export function liveServices(source: DataSource): WizardServices {
  const registry = source.registry;
  const network = source.coreNetwork;
  const relays = registry.relays.map((r) => new HttpProposalRelay(r.url, r.name));
  return {
    demo: false,
    network,
    pollMs: 45_000,
    async checkCollateral(lock, txid) {
      const dapi = dapiFor(registry);
      // 1. a node's copy of the transaction: is it known, and do its bytes pay this proposal's fee? (decidable from the bytes alone)
      let claimed: { raw: Uint8Array; height: number; confirmations: number };
      try {
        claimed = (await dapi.call((core, signal) => core.getTransaction(txid, { signal }))).value;
      } catch (e) {
        if (errCode(e) === 5) return reported('not-found', 'no DAPI node knows this transaction yet');
        return reported('error', (e as Error).message);
      }
      const c = checkCollateralTx(claimed.raw, hexToBytes(lock.govHashRaw), { expectedTxid: txid });
      if (!c.valid) {
        // bytes that do not hash to the txid are the node's fault, not the transaction's
        if (c.failure === 'txid-mismatch' || c.failure === 'tx-parse-error') return reported('error', `a DAPI node sent bad data (${c.failure})`);
        return { state: 'invalid', confirmations: 0, basis: 'verified', final: false, message: c.message ?? c.failure ?? 'not a collateral for this proposal' };
      }
      if (claimed.height <= 0) return reported('mempool');
      // 2. mined: the verification worker proves the block into the chain verified here and counts confirmations from its tip
      try {
        const { verdict } = await runVerification({ kind: 'collateral', proposal: lockAsProposal(lock, txid), dapi: source.dapiDescriptor() });
        const ch = verdict.chain;
        if (!ch) throw new Error('no chain facts');
        if (ch.anchored) {
          return {
            state: 'mined', height: ch.height, confirmations: ch.anchored.confirmations, basis: ch.anchored.weak ? 'reported' : 'verified', final: ch.anchored.final,
            weak: ch.anchored.weak, steps: verdict.steps,
          };
        }
        return { state: 'mined', height: ch.height, confirmations: ch.confirmations, basis: 'reported', final: ch.lockDepth !== null, weak: ch.weak ?? null, steps: verdict.steps };
      } catch (e) {
        return { state: 'mined', height: claimed.height, confirmations: claimed.confirmations, basis: 'reported', final: false, message: `not proven here: ${(e as Error).message}` };
      }
    },
    fundCollateral: (o) => runCollateralFunding({ ...o, dapi: dapiFor(registry), network }),
    relays: () => relays,
    async seenByNetwork(govHash) {
      const d = source.bridgeDescriptor();
      if (!d) return null;
      try {
        return (await makeBridge(d).proposal(govHash)) !== null;
      } catch {
        return null;
      }
    },
    async onGovhub(govHash) {
      try {
        return (await source.proposal(govHash)) !== null;
      } catch {
        return false;
      }
    },
  };
}

// ---- demo (fixtures) -------------------------------------------------------------------------------------------------------------

/** The demo's signed-in key: deposit keys come from it the way a pasted key's do. Not a secret: nothing is ever paid to it. */
const DEMO_SESSION_KEY = hexToBytes('6f'.repeat(32));
export const demoDepositKey = (identityId: string, index: number): DepositKey => sessionProposalDepositKey(DEMO_SESSION_KEY, identityId, index);
export const demoDepositSource = (identityId: string, index: number): DepositKeySource => ({ kind: 'session', index, identityId });

/** In the demo a block is ChainLocked from this depth. */
const DEMO_LOCKED_AT = 2;

/** A pretend chain: a "paid" collateral gains a confirmation every `blockMs` (ChainLocked from DEMO_LOCKED_AT); the relay sends it once locked. */
class DemoChain {
  readonly paidAt = new Map<string, number>();
  constructor(readonly blockMs: number) {}
  confirmations(txid: string): number {
    const t = this.paidAt.get(txid);
    return t === undefined ? 0 : Math.min(GOVERNANCE_FEE_CONFIRMATIONS + 2, Math.floor((Date.now() - t) / this.blockMs));
  }
}

class DemoRelay implements ProposalRelayPort {
  readonly name = 'demo relay (simulated)';
  readonly base = 'demo:';
  private held = new Map<string, { govHash: string; txid: string; submittedAt: number | null }>();
  constructor(private chain: DemoChain) {}
  async hold(body: SubmitBody, govHash: string) {
    const id = bytesToHex(sha256d(new TextEncoder().encode(`${govHash}${body.collateralTxid}`))).slice(0, 32);
    if (!this.held.has(id)) this.held.set(id, { govHash, txid: body.collateralTxid, submittedAt: null });
    return { kind: 'held' as const, state: (await this.status(id, govHash))! };
  }
  async status(id: string, govHash: string): Promise<HeldProposalState | null> {
    const h = this.held.get(id);
    if (!h || h.govHash !== govHash) return null;
    const n = this.chain.confirmations(h.txid);
    if (n >= GOVERNANCE_FEE_CONFIRMATIONS && h.submittedAt === null) h.submittedAt = Math.floor(Date.now() / 1000);
    const sent = n >= DEMO_LOCKED_AT;
    return { id, govHash, status: h.submittedAt ? 'submitted' : 'waiting', confirmations: n, sent, lastError: null, coreMessage: null, nextAttemptAt: null, submittedAt: h.submittedAt };
  }
  async submitNow(): Promise<never> {
    throw new Error('the demo relay holds proposals');
  }
}

export function demoServices(network: CoreNetwork, o: { blockMs?: number; pollMs?: number } = {}): WizardServices {
  const chain = new DemoChain(o.blockMs ?? 700);
  const relay = new DemoRelay(chain);
  let pay: (() => void) | null = null;
  let paid = false;
  const seen = new Set<string>();
  return {
    demo: true,
    network,
    pollMs: o.pollMs ?? 600,
    async checkCollateral(lock, txid) {
      if (!chain.paidAt.has(txid)) return reported('not-found', 'the demo only knows payments made in this demo');
      const n = chain.confirmations(txid);
      return n === 0 ? reported('mempool') : { state: 'mined', height: 1000 + n, confirmations: n, basis: 'verified', final: n >= DEMO_LOCKED_AT };
    },
    async fundCollateral({ record, key, save, signal, onUpdate }) {
      const view = (): CollateralFundingView => ({
        state: record.state, address: record.address, uri: `dash:${record.address}?amount=1.00001`, neededDuffs: 100_001_000n, receivedDuffs: paid ? 120_000_000n : 0n, pendingDuffs: 0n,
        remainingDuffs: paid ? 0n : 100_001_000n, lateDuffs: 0n, ...(record.tx ? { txid: record.tx.txid } : {}),
      });
      if (!record.tx) {
        save(record);
        onUpdate?.(view());
        await new Promise<void>((resolve, reject) => {
          pay = resolve;
          if (paid) resolve();
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        // a real collateral transaction, signed by the demo deposit key, spending a made-up payment
        const govHashRaw = hexToBytes(record.govHashRaw);
        const paymentTxid = bytesToHex(sha256d(govHashRaw));
        const built = buildProposalCollateral({
          utxos: [{ txid: paymentTxid, vout: 0, value: 120_000_000n }],
          key: key.privateKey,
          govHashRaw,
          changeScript: p2pkhScript(decodeAddress(record.refundAddress, network)!.hash160),
        });
        record.deposits = [{ txid: paymentTxid, vout: 0, value: '120000000', confirmed: true }];
        record.tx = { raw: bytesToHex(built.raw), txid: built.txid, feeDuffs: built.feeDuffs.toString(), changeDuffs: built.changeDuffs.toString(), burnDuffs: built.burnDuffs.toString() };
        record.state = 'building';
        save(record);
      }
      record.state = 'broadcast';
      record.broadcastAt ??= Date.now();
      if (!chain.paidAt.has(record.tx!.txid)) chain.paidAt.set(record.tx!.txid, Date.now());
      save(record);
      onUpdate?.(view());
      return { txid: record.tx!.txid };
    },
    relays: () => [relay],
    async seenByNetwork(govHash) {
      // "seen" one poll after the relay submitted
      if (seen.has(govHash)) return true;
      for (const [txid] of chain.paidAt) if (chain.confirmations(txid) >= GOVERNANCE_FEE_CONFIRMATIONS + 1) seen.add(govHash);
      return seen.has(govHash);
    },
    async onGovhub(govHash) {
      for (const [txid] of chain.paidAt) if (chain.confirmations(txid) >= GOVERNANCE_FEE_CONFIRMATIONS + 2 && seen.has(govHash)) return true;
      return false;
    },
    simulatePayment() {
      paid = true;
      pay?.();
    },
  };
}

