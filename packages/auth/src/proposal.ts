// Paying a proposal's collateral from the browser (PLAN 6.1 path b), all over DAPI:
//   1. a one-time DEPOSIT KEY that can always be derived again (below), so money sent to it is never lost with the tab
//   2. watchAddressForDeposit subscribes BEFORE the address is shown; a payment counts once it is IS-locked or merkle-proven in a block,
//      P2PKH outputs to the key only (the same rules as identity funding in funding.ts)
//   3. once the counted payments cover the burn plus the fee, the collateral `[OP_RETURN <gov hash> (1 DASH), change -> refund P2PKH]`
//      is built, CHECKED with @govhub/verify (checkCollateralTx) and its signed bytes PERSISTED before the broadcast
//   4. broadcast; "inputs missing or spent" is believed only when the collateral's own txid is still unknown after three tries
// Progress is a CollateralFundingRecord the caller persists (the wizard keeps it in its draft and in the backup file). Public data
// only: never a key. Resuming with the same key continues where it stopped and never builds a second collateral from the same money.
//
// ---- Deposit key derivation (for recovery tools: "Recover funds" scans these) ----------------------------------------------------
//   seed sign-in:  m/9'/<coin>'/100'/0'/<index>'   (BIP32 from the BIP39 seed, no passphrase; coin 5' mainnet, 1' testnet)
//                  DIP-9 feature 100' is not registered (assigned: 3', 4', 5', 15', 16', 17'; dip-0009/assignments.md); govhub uses
//                  it for keys no DIP defines, sub-path 0' = proposal collateral deposits. Indexes start at 0 and are used in order.
//   key sign-in:   HMAC-SHA256(key, "govhub/proposal-collateral/v1" || identity id (32 bytes) || u32be(index) || u8(ctr)), the first ctr
//                  giving a valid secp256k1 scalar, where `key` is the signed-in identity's private key (the one pasted). The same
//                  identity key and index always give the same deposit key.
//   A scanner derives indexes 0 .. PROPOSAL_DEPOSIT_GAP_LIMIT-1 past the highest used one and looks for P2PKH outputs to each
//   address (proposalDepositKeys below lists them). The deposit key only ever pays the collateral; whatever is left goes to the refund
//   address in the same transaction, so funds stay at a deposit address only when a payment arrived and no collateral was made from it.
import { classifyScript, type Dapi, type Watcher } from '@govhub/dapi';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeAddress, duffsToDash, GOVERNANCE_PROPOSAL_FEE_DUFFS, isCollateralChangeAddress } from '@govhub/verify';
import { bytesEqual, bytesToHex, concatBytes, hash160, hexToBytes, identifierBytes, u32be, wipe } from './bytes.ts';
import { redact, sleep, tipHeight } from './funding.ts';
import { addressOf, coinType, isValidPrivateKey, publicKeyOf, type Network } from './keys.ts';
import type { SeedWallet } from './seed.ts';
import { buildProposalCollateral, estimateCollateralFee, FEE_PER_BYTE, p2pkhScript, type Utxo } from './tx.ts';

/** The unregistered DIP-9 feature govhub derives its own keys under. */
export const GOVHUB_DIP9_FEATURE = 100;
/** Sub-path of GOVHUB_DIP9_FEATURE for proposal collateral deposits. */
export const PROPOSAL_DEPOSIT_BRANCH = 0;
/** How many unused indexes in a row a scanner checks before it stops. */
export const PROPOSAL_DEPOSIT_GAP_LIMIT = 20;
/** Most payments one collateral spends (each costs ~148 bytes of fee). */
export const MAX_COLLATERAL_INPUTS = 50;

const hardened = (i: number) => {
  if (!Number.isInteger(i) || i < 0 || i >= 0x80000000) throw new RangeError(`invalid derivation index ${i}`);
  return `${i}'`;
};

/** `m/9'/coin'/100'/0'/index'`: the deposit key of the index-th proposal a seed pays from the browser. */
export const proposalDepositPath = (network: Network, index: number): string =>
  `m/9'/${coinType(network)}'/${GOVHUB_DIP9_FEATURE}'/${PROPOSAL_DEPOSIT_BRANCH}'/${hardened(index)}`;

export interface DepositKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** Deposit key for a key-only sign-in (pasted key, or a passkey vault holding only the key). Deterministic: nothing secret is stored. */
export function sessionProposalDepositKey(sessionKey: Uint8Array, identityId: string, index: number): DepositKey {
  if (!isValidPrivateKey(sessionKey)) throw new Error('The signed-in key is not available any more. Sign in again.');
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new RangeError(`invalid deposit index ${index}`);
  for (let ctr = 0; ctr < 256; ctr++) {
    const k = hmac(sha256, sessionKey, concatBytes(new TextEncoder().encode('govhub/proposal-collateral/v1'), identifierBytes(identityId), u32be(index), Uint8Array.of(ctr)));
    if (isValidPrivateKey(k)) return { privateKey: k, publicKey: publicKeyOf(k) };
    wipe(k);
  }
  throw new Error('no valid deposit key');
}

/** How a deposit key is derived: what a record keeps (public) so the same key can be derived again after a reload or on another device. */
export type DepositKeySource = { kind: 'seed'; index: number } | { kind: 'session'; index: number; identityId: string };

/**
 * THE derivation (one function for the wizard and for recovery scanners): the deposit key for `source` from the user's seed (kind
 * 'seed') or signed-in private key (kind 'session'). The caller wipes `privateKey`.
 */
export function proposalDepositKey(source: DepositKeySource, secret: { wallet?: SeedWallet | null; sessionKey?: Uint8Array | null }, network: Network): DepositKey {
  if (source.kind === 'seed') {
    if (!secret.wallet) throw new Error('This deposit address belongs to a recovery phrase: sign in with that phrase.');
    if (secret.wallet.network !== network) throw new Error(`network mismatch: seed ${secret.wallet.network}, proposal ${network}`);
    return secret.wallet.derive(proposalDepositPath(network, source.index));
  }
  if (!secret.sessionKey) throw new Error('This deposit address belongs to a signed-in key: sign in with that key.');
  return sessionProposalDepositKey(secret.sessionKey, source.identityId, source.index);
}

/** The deposit addresses of indexes [from, from + count) for a recovery scan (public data: address and hash160 per index). */
export function proposalDepositKeys(
  secret: { wallet?: SeedWallet | null; sessionKey?: Uint8Array | null; identityId?: string },
  network: Network,
  from = 0,
  count = PROPOSAL_DEPOSIT_GAP_LIMIT,
): Array<{ source: DepositKeySource; address: string; hash160: string }> {
  const out: Array<{ source: DepositKeySource; address: string; hash160: string }> = [];
  for (let index = from; index < from + count; index++) {
    if (!secret.wallet && !secret.identityId) throw new Error('a key sign-in needs the identity id');
    const source: DepositKeySource = secret.wallet ? { kind: 'seed', index } : { kind: 'session', index, identityId: secret.identityId! };
    const k = proposalDepositKey(source, secret, network);
    try {
      out.push({ source, address: addressOf(k.publicKey, network), hash160: bytesToHex(hash160(k.publicKey)) });
    } finally {
      wipe(k.privateKey);
    }
  }
  return out;
}

// ---- the runner ------------------------------------------------------------------------------------------------------------------

export interface CollateralDeposit {
  txid: string;
  vout: number;
  value: string;
  /** IS-locked or merkle-proven in a block: only these are spent. */
  confirmed: boolean;
}

export type CollateralFundingState = 'awaiting-deposit' | 'building' | 'broadcast';

/** Persisted progress of one browser-paid collateral. Public data only. */
export interface CollateralFundingRecord {
  v: 1;
  network: Network;
  source: DepositKeySource;
  /** The deposit address (checked against the derived key on resume). */
  address: string;
  /** Raw-order gov hash (the OP_RETURN bytes), hex. */
  govHashRaw: string;
  /** P2PKH address the change goes to. */
  refundAddress: string;
  watchFromHeight?: number;
  deposits: CollateralDeposit[];
  /** Payments that arrived after the collateral was built: they stay at the deposit address (the same key controls them). */
  lateDeposits?: Array<{ txid: string; vout: number; value: string }>;
  /** The signed collateral, saved BEFORE it is broadcast. */
  tx?: { raw: string; txid: string; feeDuffs: string; changeDuffs: string; burnDuffs: string };
  broadcastAt?: number;
  /** Collaterals the network refused (inputs spent elsewhere); at most 2 rebuilds. */
  rejected?: string[];
  state: CollateralFundingState;
}

export interface CollateralFundingView {
  state: CollateralFundingState;
  address: string;
  /** `dash:<address>?amount=<still needed>` for the QR code. */
  uri: string;
  /** Burn + fee for the payments counted so far (one more payment adds ~148 duffs). */
  neededDuffs: bigint;
  receivedDuffs: bigint;
  /** Seen but not yet IS-locked or mined. */
  pendingDuffs: bigint;
  remainingDuffs: bigint;
  lateDuffs: bigint;
  txid?: string;
  note?: string;
}

export class CollateralFundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollateralFundingError';
  }
}

const errText = (e: unknown): string => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e));
const errCode = (e: unknown): number | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'number' ? c : undefined;
};
const inputsRejected = (e: unknown) => /missing-?inputs|bad-txns-inputs-missingorspent|txn-mempool-conflict|inputs.*(spent|missing)/i.test(errText(e));

/** Estimated fee of a collateral spending `inputs` payments, with change (the larger case). */
export function collateralFeeDuffs(inputs: number, feePerByte = FEE_PER_BYTE): bigint {
  return estimateCollateralFee(inputs, true, feePerByte);
}

/** Rounded up to 0.00001 DASH: the amounts a depositor is asked for. */
const roundUpForRequest = (duffs: bigint): bigint => ((duffs + 999n) / 1000n) * 1000n;

/** What to ask a depositor for: the 1 DASH burn plus the fee of a one-payment collateral, rounded up. */
export const MIN_COLLATERAL_DEPOSIT_DUFFS = roundUpForRequest(GOVERNANCE_PROPOSAL_FEE_DUFFS + collateralFeeDuffs(1));

/** Counted payments, largest first, that cover the burn plus their own fee; null while they do not. Skips outputs worth less than their input cost. */
export function pickCollateralInputs<T extends { txid: string; vout: number; value: string; confirmed: boolean }>(deposits: readonly T[], burn = GOVERNANCE_PROPOSAL_FEE_DUFFS): T[] | null {
  // a total order (value, then outpoint): the same payments always sign into the same transaction, whatever order they arrived in
  const usable = deposits
    .filter((d) => d.confirmed && BigInt(d.value) > 148n * FEE_PER_BYTE)
    .sort((a, b) => {
      const va = BigInt(a.value);
      const vb = BigInt(b.value);
      if (va !== vb) return vb > va ? 1 : -1;
      return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout;
    });
  // all of them: whatever is not needed goes back as change, so nothing is left at the deposit address
  const picked = usable.slice(0, MAX_COLLATERAL_INPUTS);
  const sum = picked.reduce((a, d) => a + BigInt(d.value), 0n);
  return picked.length && sum >= burn + collateralFeeDuffs(picked.length) ? picked : null;
}

/** Whether nodes know the tx: mined height, 0 in the mempool, 'unknown' only for NOT_FOUND. Other failures throw. */
async function txStatus(dapi: Dapi, txid: string, signal?: AbortSignal): Promise<number | 'unknown'> {
  try {
    const { value } = await dapi.call((core, s) => core.getTransaction(txid, { signal: s }), { signal });
    return value.height > 0 ? value.height : 0;
  } catch (e) {
    if (errCode(e) === 5) return 'unknown';
    throw e;
  }
}

export interface CollateralFundingOptions {
  dapi: Dapi;
  network: Network;
  /** The derived deposit key (see proposalDepositKey); the runner does not wipe it. */
  key: DepositKey;
  record: CollateralFundingRecord;
  /** Persist the record (synchronously, before the runner goes on: the signed tx is saved this way before the broadcast). */
  save(r: CollateralFundingRecord): void;
  /**
   * Asked right before the collateral is built: a reason not to burn the fee now (the proposal expired, its first payment can no
   * longer be reached, ...), or null. With a reason the runner stops with a CollateralFundingError and the payments stay at the deposit
   * address, which the same sign-in controls.
   */
  guard?(): string | null;
  signal?: AbortSignal;
  onUpdate?(v: CollateralFundingView): void;
  log?(msg: string): void;
}

/** A fresh record for a deposit key: no payments yet. */
export function newCollateralFunding(o: { network: Network; source: DepositKeySource; key: DepositKey; govHashRaw: string; refundAddress: string }): CollateralFundingRecord {
  if (!isCollateralChangeAddress(o.refundAddress, o.network)) throw new CollateralFundingError('The refund address must be an ordinary (P2PKH) Dash address of this network: Core refuses a collateral with any other kind of output.');
  if (!/^[0-9a-f]{64}$/.test(o.govHashRaw)) throw new CollateralFundingError('bad governance hash');
  return { v: 1, network: o.network, source: o.source, address: addressOf(o.key.publicKey, o.network), govHashRaw: o.govHashRaw, refundAddress: o.refundAddress, deposits: [], state: 'awaiting-deposit' };
}

/**
 * Runs (or resumes) one browser-paid collateral until it is broadcast. Resolves with the collateral txid. Persists after every step;
 * calling it again with the same key and record continues where it stopped. Confirmations are the caller's business (proven ones).
 */
export async function runCollateralFunding(o: CollateralFundingOptions): Promise<{ txid: string }> {
  const { dapi, network, key, signal } = o;
  const rec = o.record;
  if (dapi.network !== network || rec.network !== network) throw new CollateralFundingError(`network mismatch: DAPI ${dapi.network}, proposal ${rec.network}`);
  const h160 = hash160(key.publicKey);
  if (addressOf(key.publicKey, network) !== rec.address) throw new CollateralFundingError('this record belongs to another deposit key: sign in the way you did when you started');
  const refund = decodeAddress(rec.refundAddress, network);
  if (!refund || refund.type !== 'p2pkh') throw new CollateralFundingError('the refund address must be a P2PKH address');
  const log = o.log ?? (() => {});
  const save = () => o.save(rec);
  const sum = (l: ReadonlyArray<{ value: string }>) => l.reduce((a, d) => a + BigInt(d.value), 0n);
  const view = (note?: string): CollateralFundingView => {
    const counted = rec.deposits.filter((d) => d.confirmed);
    const inputs = Math.max(1, counted.length + (rec.deposits.length > counted.length ? 1 : 0));
    const needed = GOVERNANCE_PROPOSAL_FEE_DUFFS + collateralFeeDuffs(inputs);
    const have = sum(rec.deposits);
    const remaining = rec.tx || have >= needed ? 0n : needed - have;
    const rounded = roundUpForRequest(remaining);
    return {
      state: rec.state,
      address: rec.address,
      uri: rounded > 0n ? `dash:${rec.address}?amount=${duffsToDash(rounded)}` : `dash:${rec.address}`,
      neededDuffs: needed,
      receivedDuffs: sum(counted),
      pendingDuffs: sum(rec.deposits.filter((d) => !d.confirmed)),
      remainingDuffs: rounded,
      lateDuffs: sum(rec.lateDeposits ?? []),
      ...(rec.tx ? { txid: rec.tx.txid } : {}),
      ...(note ? { note } : {}),
    };
  };
  const update = (note?: string) => {
    save();
    o.onUpdate?.(view(note));
  };
  const watchers: Watcher[] = [];
  try {
    for (;;) {
      // ---- 1-2: payments (the watcher stays open: payments after the collateral are reported as late) ----
      rec.watchFromHeight ??= Math.max(0, (await tipHeight(dapi, signal)) - 3);
      save();
      let wake: () => void = () => {};
      const locked = new Set<string>();
      const same = (a: { txid: string; vout: number }) => (b: { txid: string; vout: number }) => a.txid === b.txid && a.vout === b.vout;
      const confirm = (txid: string) => {
        let changed = false;
        for (const d of rec.deposits) if (d.txid === txid && !d.confirmed) changed = d.confirmed = true;
        if (changed) {
          update(`payment ${txid.slice(0, 12)}… confirmed`);
          wake();
        }
      };
      const w = await dapi.watchAddressForDeposit(
        h160,
        {
          onTx: ({ tx }) => {
            if (tx.txid === rec.tx?.txid) return;
            const outs = tx.outputs.flatMap((out, vout) => {
              const c = classifyScript(out.script);
              return c.type === 'p2pkh' && bytesEqual(c.hash, h160) ? [{ txid: tx.txid, vout, value: out.value.toString() }] : [];
            });
            const fresh = outs.filter((d) => !rec.deposits.some(same(d)) && !(rec.lateDeposits ?? []).some(same(d)));
            if (!fresh.length) return;
            if (rec.tx) {
              (rec.lateDeposits ??= []).push(...fresh);
              update(`a payment arrived after the collateral was made (${tx.txid.slice(0, 12)}…); it stays at the deposit address`);
              return;
            }
            for (const d of fresh) rec.deposits.push({ ...d, confirmed: locked.has(d.txid) });
            update(`payment ${tx.txid.slice(0, 12)}… seen; waiting for InstantSend or a block`);
            wake();
          },
          onIsLock: ({ lock }) => {
            locked.add(lock.txid);
            confirm(lock.txid);
          },
          onBlock: (b) => {
            for (const t of b.matched) {
              locked.add(t);
              confirm(t);
            }
          },
          onError: (e, ctx) => log(`watch ${ctx.phase}: ${redact(errText(e))}`),
        },
        { fromHeight: rec.watchFromHeight, signal },
      );
      watchers.push(w);
      update(); // the address may be shown now: the subscription is live

      if (!rec.tx) {
        const stop = new Promise<never>((_, rej) => {
          if (signal?.aborted) return rej(signal.reason);
          signal?.addEventListener('abort', () => rej(signal.reason), { once: true });
        });
        stop.catch(() => {});
        while (!pickCollateralInputs(rec.deposits)) await Promise.race([new Promise<void>((r) => (wake = r)), stop]);
        // a wallet may split a payment into several transactions that arrive together
        await sleep(1500, signal);
        const stopReason = o.guard?.();
        if (stopReason) {
          update(`not paying the fee: ${stopReason}`);
          throw new CollateralFundingError(`The fee was not paid: ${stopReason} Your payment is still at ${rec.address}, which your sign-in controls.`);
        }
        rec.state = 'building';
        const inputs = pickCollateralInputs(rec.deposits)!;
        const utxos: Utxo[] = inputs.map((d) => ({ txid: d.txid, vout: d.vout, value: BigInt(d.value) }));
        const built = buildProposalCollateral({ utxos, key: key.privateKey, govHashRaw: hexToBytes(rec.govHashRaw), changeScript: p2pkhScript(refund.hash160) });
        const left = rec.deposits.filter((d) => !inputs.some(same(d))).map(({ txid, vout, value }) => ({ txid, vout, value }));
        if (left.length) (rec.lateDeposits ??= []).push(...left);
        rec.deposits = inputs;
        rec.tx = { raw: bytesToHex(built.raw), txid: built.txid, feeDuffs: built.feeDuffs.toString(), changeDuffs: built.changeDuffs.toString(), burnDuffs: built.burnDuffs.toString() };
        update('collateral built and saved');
      }

      // ---- 4: broadcast (never re-sent once any node knows it) ----
      const tx = rec.tx!;
      const status = await txStatus(dapi, tx.txid, signal);
      if (status === 'unknown') {
        let sent = false;
        for (let attempt = 0; ; attempt++) {
          try {
            await dapi.broadcastTransaction(hexToBytes(tx.raw), { signal });
            sent = true;
            break;
          } catch (e) {
            if (!inputsRejected(e)) throw e;
            log(`collateral broadcast refused (${attempt + 1}): ${redact(errText(e))}`);
            if ((await txStatus(dapi, tx.txid, signal)) !== 'unknown') {
              sent = true;
              break;
            }
            if (attempt >= 2) break;
            await sleep(4000 * (attempt + 1), signal);
          }
        }
        if (!sent) {
          // every node refused the inputs and none knows the collateral: a payment was double-spent or replaced. Forget it and
          // replay the address from the start (at most twice). Nothing was burnt: the collateral never made it out.
          (rec.rejected ??= []).push(tx.txid);
          if (rec.rejected.length >= 3) {
            update('the network refused the collateral three times');
            throw new CollateralFundingError('The network refused the collateral three times. The payments are still at the deposit address; the recovery tool can return them.');
          }
          rec.tx = undefined;
          rec.deposits = [];
          rec.lateDeposits = undefined;
          rec.state = 'awaiting-deposit';
          update('the network rejected the payment the collateral spends; waiting for a valid payment');
          for (const x of watchers.splice(0)) x.cancel();
          continue;
        }
      }
      rec.broadcastAt ??= Date.now();
      rec.state = 'broadcast';
      update('collateral broadcast');
      return { txid: tx.txid };
    }
  } finally {
    for (const x of watchers) x.cancel();
  }
}

