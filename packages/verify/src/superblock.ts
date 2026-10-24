// Superblock schedule, budget limit and payment matching: pure functions of chain parameters and a (verified) height.
// Dash Core: /Users/pasta/workspace/dash at f35a24cfca12; citations are file:line there.
import { decodeAddress, type Network } from './address.ts';

export interface GovChainParams {
  /** consensus.nSuperblockStartBlock */
  superblockStartBlock: number;
  /** consensus.nSuperblockCycle */
  superblockCycle: number;
  /** consensus.nSuperblockMaturityWindow: the trigger is built this many blocks before the superblock. */
  maturityWindow: number;
  /** consensus.nGovernanceMinQuorum */
  minQuorum: number;
  /** consensus.nBudgetPaymentsStartBlock: blocks after it set aside the treasury share. */
  budgetPaymentsStartBlock: number;
  /** consensus.nSubsidyHalvingInterval (a 1/14 cut, not a halving). */
  subsidyHalvingInterval: number;
  /** consensus.V20Height: fixed subsidy base and a 20% treasury from here. */
  v20Height: number;
  /** nBits GetPaymentsLimit feeds the subsidy formula (superblock.cpp:154): 1, or powLimit's compact form on min-difficulty networks. */
  paymentsLimitBits: number;
}

/** mainnet chainparams.cpp:162-198, testnet :371-407 (powLimit 0x1e0fffff in compact form). */
export const GOV_CHAIN_PARAMS: Record<'mainnet' | 'testnet', GovChainParams> = {
  mainnet: {
    superblockStartBlock: 614_820, superblockCycle: 16_616, maturityWindow: 1_662, minQuorum: 10,
    budgetPaymentsStartBlock: 328_008, subsidyHalvingInterval: 210_240, v20Height: 1_987_776, paymentsLimitBits: 1,
  },
  testnet: {
    superblockStartBlock: 4_200, superblockCycle: 24, maturityWindow: 8, minQuorum: 1,
    budgetPaymentsStartBlock: 4_100, subsidyHalvingInterval: 210_240, v20Height: 905_100, paymentsLimitBits: 0x1e0fffff,
  },
};

/** The first multiple of `cycle` at or above `height`. */
const alignUp = (height: number, cycle: number): number => height + ((cycle - (height % cycle)) % cycle);

const paramsOf = (n: Network): GovChainParams => {
  const p = GOV_CHAIN_PARAMS[n as 'mainnet' | 'testnet'];
  if (!p) throw new Error(`no governance chain parameters for ${n}`);
  return p;
};

/** CSuperblock::IsValidBlockHeight (governance/superblock.cpp:119-124). */
export function isSuperblockHeight(height: number, network: Network): boolean {
  const p = paramsOf(network);
  return height >= p.superblockStartBlock && height % p.superblockCycle === 0;
}

export interface SuperblockSchedule {
  /** Last superblock height at or below `height` (0 before the first). */
  last: number;
  next: number;
  /** First block of the maturity window: the funding trigger is built from the votes as of here (signing.cpp:41-43). */
  votingDeadline: number;
  /** `height` is inside that window: the next superblock's payees are being decided. */
  inMaturityWindow: boolean;
}

/** CSuperblock::GetNearestSuperblocksHeights (superblock.cpp:126-143) plus the maturity window (signing.cpp:41-43). */
export function superblockSchedule(height: number, network: Network): SuperblockSchedule {
  const p = paramsOf(network);
  const first = alignUp(p.superblockStartBlock, p.superblockCycle);
  const last = height < first ? 0 : height - (height % p.superblockCycle);
  const next = height < first ? first : last + p.superblockCycle;
  return { last, next, votingDeadline: next - p.maturityWindow, inMaturityWindow: height % p.superblockCycle >= p.superblockCycle - p.maturityWindow };
}

/** Superblock heights in [from, to]. */
export function superblocksBetween(from: number, to: number, network: Network): number[] {
  const p = paramsOf(network);
  const out: number[] = [];
  for (let h = alignUp(Math.max(from, p.superblockStartBlock), p.superblockCycle); h <= to; h += p.superblockCycle) out.push(h);
  return out;
}

/** ConvertBitsToDouble (validation.cpp:1784-1802). */
function bitsToDouble(bits: number): number {
  let shift = (bits >>> 24) & 0xff;
  let d = 0x0000ffff / (bits & 0x00ffffff);
  while (shift < 29) { d *= 256; shift++; }
  while (shift > 29) { d /= 256; shift--; }
  return d;
}

const COIN = 100_000_000n;

/**
 * GetBlockSubsidyHelper (validation.cpp:1809-1870) -> the treasury share of one block, in duffs. `prevHeight` is the height of
 * the PREVIOUS block, as Core passes it. The pre-V20 branches use doubles exactly like Core (assigning a double to CAmount
 * truncates toward zero).
 */
export function superblockShareOfBlock(prevBits: number, prevHeight: number, network: Network, v20Active: boolean): bigint {
  const p = paramsOf(network);
  let base: number;
  if (v20Active) base = 5;
  else {
    const diff = prevHeight <= 4500 && network === 'mainnet' ? 0x0000ffff / (prevBits & 0x00ffffff) : bitsToDouble(prevBits);
    if (prevHeight < 5465) base = Math.min(500, Math.max(1, Math.trunc(1111.0 / (diff + 1.0) ** 2)));
    else if (prevHeight < 17000 || (diff <= 75 && prevHeight < 24000)) base = Math.min(500, Math.max(25, Math.trunc(11111.0 / ((diff + 51.0) / 6.0) ** 2)));
    else base = Math.min(25, Math.max(5, Math.trunc(2222222.0 / ((diff + 2600.0) / 9.0) ** 2)));
  }
  let subsidy = BigInt(base) * COIN;
  for (let i = p.subsidyHalvingInterval; i <= prevHeight; i += p.subsidyHalvingInterval) subsidy -= subsidy / 14n;
  return prevHeight > p.budgetPaymentsStartBlock ? subsidy / (v20Active ? 5n : 10n) : 0n;
}

/**
 * CSuperblock::GetPaymentsLimit (superblock.cpp:145-162): the most a superblock at `height` may pay out, in duffs. Not a
 * superblock height: 0. Core feeds a fixed nBits, so the limit depends on the height alone.
 */
export function superblockPaymentsLimit(height: number, network: Network): bigint {
  if (!isSuperblockHeight(height, network)) return 0n;
  const p = paramsOf(network);
  return superblockShareOfBlock(p.paymentsLimitBits, height - 1, network, height >= p.v20Height) * BigInt(p.superblockCycle);
}

/** max(nGovernanceMinQuorum, m_valid_weighted / 10), integer division (governance.cpp:1208-1209). */
export function fundingThreshold(validWeighted: number, network: Network): number {
  return Math.max(paramsOf(network).minQuorum, Math.floor(validWeighted / 10));
}

/** The output script Core pays a governance payee with: P2PKH or P2SH (CGovernancePayment, DecodeDestination + GetScriptForDestination). */
export function payeeScript(address: string, network: Network): Uint8Array | null {
  const d = decodeAddress(address, network);
  if (!d) return null;
  return d.type === 'p2pkh'
    ? Uint8Array.from([0x76, 0xa9, 0x14, ...d.hash160, 0x88, 0xac])
    : Uint8Array.from([0xa9, 0x14, ...d.hash160, 0x87]);
}

/**
 * Index of a coinbase output paying exactly `amount` duffs to `address`, or -1. CSuperblock::IsValid requires every trigger
 * payment to appear as such an output, script and amount equal (superblock.cpp:303-310), so a found output is the payment; it
 * cannot tell two proposals with the same address and amount apart.
 */
export function findPayment(outputs: ReadonlyArray<{ value: bigint; script: Uint8Array }>, address: string, amount: bigint, network: Network): number {
  const script = payeeScript(address, network);
  if (!script) return -1;
  return outputs.findIndex((o) => o.value === amount && o.script.length === script.length && o.script.every((b, i) => b === script[i]));
}
