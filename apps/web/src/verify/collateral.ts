// "Content matches on-chain collateral" (PLAN §2): recompute the gov hash from the published
// fields, check the collateral transaction fetched over DAPI, and check that the denormalised
// fields shown in the UI are the ones committed in dataHex.
import type { VerifiedTransaction } from '@govhub/dapi';
import { checkCollateralTx, GOVERNANCE_FEE_CONFIRMATIONS, governanceObjectHash, inputKeyIds, parseProposalData } from '@govhub/verify';
import { DUFFS_PER_DASH } from '../lib/format.ts';
import type { CoreNetwork, Proposal } from '../data/types.ts';

/**
 * The collateral transaction as @govhub/dapi returns it: `chainLocked`, `proof.merkle` and `proof.chainLock` say what was proven;
 * everything else (confirmations, the IS-lock flag, and the ChainLock flag when `chainLocked` is 'claimed') is a node's word.
 */
export type TxLookup = Pick<VerifiedTransaction, 'raw' | 'height' | 'confirmations' | 'chainLocked' | 'instantLocked' | 'proof' | 'node'> & {
  /**
   * A second node's answer for the same txid, asked only when the block inclusion is not proven. `notFound`: that node answered
   * NOT_FOUND, which contradicts the first node (a missing answer is null instead).
   */
  second?: { node: string; height: number; sameBytes: boolean; notFound?: boolean } | null;
};

export type StepStatus = 'ok' | 'fail' | 'warn' | 'skip';
/** Whether a passing step was proven in this browser or rests on what a node says. */
export type StepBasis = 'verified' | 'reported';
export interface Step {
  id: 'hash' | 'fields' | 'tx' | 'block' | 'crosscheck' | 'collateral' | 'confirmations' | 'chainlock' | 'height';
  status: StepStatus;
  label: string;
  detail: string;
  basis?: StepBasis;
  /** Technical detail for "how this was checked" (node notes, parameters). */
  more?: string;
}

/** What the chain lookup established, for the provenance of the collateral line. */
export interface ChainFacts {
  height: number;
  /** The tx was proven into a block by its merkle root. */
  merkle: boolean;
  chainLocked: TxLookup['chainLocked'];
  /** Confirmations proven from the verified chain's tip (a lower bound), when that proves the 6 Core needs; else null. */
  provenConfirmations: number | null;
  /** Blocks from the collateral's block up to the verified ChainLock, whatever their number. */
  lockDepth: number | null;
  /** The node's claim. */
  confirmations: number;
  /**
   * Why none of this is secure, when proof of work does not protect the chain it was checked against (testnet); null/absent otherwise.
   * Set for the anchored chain and for the fallback per-transaction proof alike.
   */
  weak?: string | null;
  /** The block is in the chain this browser verified (headers from the checkpoint); `confirmations` below is then counted from its tip. */
  anchored?: {
    tip: number; confirmations: number; chainLockHeight: number; final: boolean;
    /** proof of work does not protect it (testnet, proof-of-work path only) */ weak: string | null;
    /** what the verified chain rests on: ChainLocks proven from the quorum checkpoint, or proof of work */ trust?: 'quorum-proof' | 'proof-of-work';
    /** the block's hash links up to this block whose hash the build pins (below the quorum checkpoint), not to the ChainLock directly */
    pinned?: { height: number; hash: string };
  };
}

export interface CollateralVerdict {
  ok: boolean;
  steps: Step[];
  govHashComputed?: string;
  chain?: ChainFacts;
  /**
   * hash160s of the keys that signed the collateral's inputs (claim method 3). Set only when the whole verdict is ok
   * (txid matches the proposal's collateral, it burns to the recomputed gov hash, enough confirmations).
   */
  inputKeys?: string[];
  /**
   * The transaction could not be fetched and checked, for reasons that say nothing about the proposal: nodes unreachable, timeouts,
   * or nodes answering NOT_FOUND (`absent`).
   */
  inconclusive?: boolean;
  /**
   * Every DAPI node asked (two or more) answered NOT_FOUND. Nodes can't prove that a transaction does not exist (one that lags,
   * prunes or lies says the same), so this is "couldn't verify", never "failed". Always set together with `inconclusive`.
   */
  absent?: true;
  /** Why the verified chain could not be built (the old per-transaction proof was used instead). */
  anchorError?: string;
}

/** A failed lookup: `notFound` when several distinct DAPI nodes answered NOT_FOUND (they didn't return it: not proof it is missing). */
export type LookupError = { error: string; notFound?: boolean };

/**
 * Steps whose failure can be a fact about the proposal itself, when it does not rest on nodes' word (`basis: 'reported'`). The
 * published collateral height counts only when the verified chain contradicts it (its basis is then 'verified'). The transaction
 * lookup never does: its failures (unreachable, NOT_FOUND) are always 'reported'.
 */
const DEFINITE: readonly Step['id'][] = ['hash', 'fields', 'collateral', 'confirmations', 'height'];
const CONTENT: readonly Step['id'][] = ['hash', 'fields'];

/**
 * Why a verdict means the proposal failed verification, or null when it passed or the check could not conclude. Only cryptographic
 * contradictions count: the published fields against the gov hash, or the real collateral (bytes that hash to its txid) not burning
 * at least the fee to the gov hash. Anything nodes could cause (altered bytes, a low confirmation count, a second node disagreeing,
 * an unreachable network, or every node asked answering NOT_FOUND) never fails or hides a proposal.
 */
export function verdictFailure(v: CollateralVerdict): string | null {
  if (v.ok) return null;
  // Without the transaction (inconclusive), or with nodes disagreeing about it, only the content check (no network) can fail.
  const contentOnly = v.inconclusive || v.steps.some((s) => s.id === 'crosscheck' && s.status === 'fail');
  const bad = v.steps.filter((s) => s.status === 'fail' && s.basis !== 'reported' && (contentOnly ? CONTENT : DEFINITE).includes(s.id));
  return bad.length ? bad.map((s) => `${s.label}: ${s.detail}`).join('; ') : null;
}

type ProposalCore = Pick<Proposal, 'govHash' | 'parentHash' | 'revision' | 'time' | 'dataHex' | 'collateralTxid' | 'collateralHeight' | 'name' | 'url' | 'paymentAddress' | 'paymentAmount' | 'startEpoch' | 'endEpoch'>;

/** Hash + field consistency: needs no network. */
export function checkContent(p: ProposalCore): { steps: Step[]; govHashComputed?: string } {
  const steps: Step[] = [];
  let computed: string | undefined;
  try {
    computed = governanceObjectHash({ parentHash: p.parentHash, revision: p.revision, time: p.time, dataHex: p.dataHex }).display;
    const ok = computed === p.govHash.toLowerCase();
    steps.push({ id: 'hash', status: ok ? 'ok' : 'fail', label: 'Governance hash', detail: ok ? `recomputed ${computed}` : `recomputed ${computed}, published ${p.govHash}` });
  } catch (e) {
    steps.push({ id: 'hash', status: 'fail', label: 'Governance hash', detail: `cannot hash: ${(e as Error).message}` });
  }

  const parsed = parseProposalData(p.dataHex);
  const f = parsed.fields;
  if (!f) {
    steps.push({ id: 'fields', status: 'fail', label: 'Displayed fields', detail: `dataHex does not parse: ${parsed.errors.join('; ')}` });
  } else {
    const diffs: string[] = [];
    if (f.name !== p.name) diffs.push(`name "${p.name}" vs "${f.name}"`);
    if (f.url !== p.url) diffs.push('url');
    if (f.paymentAddress !== p.paymentAddress) diffs.push('payment address');
    if (Math.round(f.paymentAmount * DUFFS_PER_DASH) !== p.paymentAmount) diffs.push('payment amount');
    if (f.startEpoch !== p.startEpoch) diffs.push('start');
    if (f.endEpoch !== p.endEpoch) diffs.push('end');
    steps.push(
      diffs.length
        ? { id: 'fields', status: 'fail', label: 'Displayed fields', detail: `differ from the hashed data: ${diffs.join(', ')}` }
        : { id: 'fields', status: 'ok', label: 'Displayed fields', detail: 'name, URL, address, amount and dates match the hashed data' },
    );
  }
  return { steps, ...(computed ? { govHashComputed: computed } : {}) };
}

const num = (n: number) => n.toLocaleString('en-US');

/** What an all-NOT_FOUND lookup establishes: the nodes didn't return the transaction (not that it is missing). */
export const ABSENT = "the nodes didn't return the fee transaction";

/** What the fallback per-transaction ChainLock rests on (it is "reported", never "verified"). */
export const AGREED_LIST = 'its BLS signature checks against a masternode list DAPI nodes agree on, not one proven from the chain verified here';

/** A second node's answer, for a block not tied to the verified chain. NOT_FOUND contradicts the first node; no answer only warns. */
function crosscheckStep(sec: TxLookup['second'], height: number): Step {
  const step = { id: 'crosscheck', label: 'Second node' } as const;
  if (!sec) return { ...step, status: 'warn', basis: 'reported', detail: 'no second DAPI node answered; the block and confirmations rest on one node' };
  // a disagreement between nodes is a node's word against another's: "couldn't verify", never a fact about the proposal
  if (sec.notFound) return { ...step, status: 'fail', basis: 'reported', detail: `${sec.node} disagrees: it answers NOT_FOUND, as if the transaction were not on its chain` };
  if (sec.sameBytes && sec.height === height) return { ...step, status: 'ok', basis: 'reported', detail: `${sec.node} returns the same transaction in the same block` };
  return { ...step, status: 'fail', basis: 'reported', detail: `${sec.node} disagrees: ${sec.sameBytes ? `block ${sec.height} vs ${height}` : 'different transaction bytes'}` };
}

/** How a block below the downloaded run is tied to the chain: its hash is pinned, or its header links up to one that is. */
const PINNED = 'whose hash this build pins (the quorum checkpoint or one of its ancestors, derived from it by hash links)';
const pinnedNote = (pin: { height: number }, height: number) =>
  pin.height === height ? `block ${num(height)}, ${PINNED}` : `linked by X11 header hashes up to block ${num(pin.height)}, ${PINNED}`;

/** The ChainLock step: final under a lock in the verified chain; the fallback lock and node claims are "reported". */
function chainlockStep(
  lookup: TxLookup,
  c: { anc: TxLookup['proof']['anchor']; cl: TxLookup['proof']['chainLock']; fallbackLock: boolean; chainBasis: StepBasis; word: string; weak: string | null },
): Step {
  const step = { id: 'chainlock', label: 'ChainLock' } as const;
  const notes = lookup.proof.notes.length ? { more: lookup.proof.notes.join('; ') } : {};
  const quorum = (l: NonNullable<typeof c.cl>) => (l.exact ? 'signed by the quorum Core selects' : "signed by a quorum of the proven masternode list (Core's exact choice could not be reproduced)");
  const { anc, cl } = c;
  if (cl && anc && lookup.chainLocked === 'verified') {
    return {
      ...step, status: 'ok', basis: c.chainBasis,
      detail: c.weak ? `covered by the ChainLock on block ${num(cl.height)}, on a chain proof of work does not secure here` : `final: covered by the BLS-verified ChainLock on block ${num(cl.height)}`,
      more: anc.pinned
        ? `${quorum(cl)}; ${num(cl.verifiedConfirmations)} blocks from the block to the locked one; the block is ${pinnedNote(anc.pinned, lookup.height)}`
        : `${quorum(cl)}; ${num(cl.verifiedConfirmations)} ${c.word} headers from the block to the locked one`,
    };
  }
  if (cl && c.fallbackLock) {
    return {
      ...step, status: 'ok', basis: 'reported', detail: `a ChainLock on block ${num(cl.height)} covers it, but the chain could not be verified here`,
      more: `${AGREED_LIST}; ${quorum(cl)}; ${num(cl.verifiedConfirmations)} headers from the block to the locked one`,
    };
  }
  if (anc) return { ...step, status: 'warn', basis: c.chainBasis, detail: `not final yet: the block is newer than the newest ${c.word} ChainLock (block ${num(anc.chainLockHeight)})`, ...notes };
  if (lookup.chainLocked === 'claimed') {
    // "proof failed" (as opposed to "block too old" or "no verifier") means the machinery ran and something did not check out
    const failed = lookup.proof.notes.some((n) => /chainlock proof failed/i.test(n));
    return { ...step, status: failed ? 'warn' : 'ok', basis: 'reported', detail: `a node reports it ChainLocked; ${failed ? 'checking the signature FAILED' : 'the signature was not checked'}`, ...notes };
  }
  return { ...step, status: 'warn', basis: 'reported', detail: 'a node reports no ChainLock yet', ...notes };
}

/** Full verdict from the content checks plus the DAPI transaction lookup (or its error). */
export function verifyCollateral(p: ProposalCore, lookup: TxLookup | LookupError, network: CoreNetwork): CollateralVerdict {
  const { steps, govHashComputed } = checkContent(p);
  if ('error' in lookup) {
    // Neither an unreachable network nor nodes answering NOT_FOUND say anything about the proposal: nodes can't prove that a
    // transaction does not exist, so both are "reported" (couldn't verify), never a failure.
    steps.push({
      id: 'tx', status: 'fail', basis: 'reported', label: 'Collateral transaction',
      detail: lookup.notFound ? `${ABSENT}: every DAPI node asked answered NOT_FOUND, which can't prove it doesn't exist (${lookup.error})` : `not fetched: ${lookup.error}`,
    });
    return { ok: false, inconclusive: true, steps, ...(govHashComputed ? { govHashComputed } : {}), ...(lookup.notFound ? { absent: true as const } : {}) };
  }
  const { proof } = lookup;
  steps.push({ id: 'tx', status: 'ok', label: 'Collateral transaction', detail: `${lookup.raw.length} bytes from DAPI node ${lookup.node}` });
  // A merkle proof only shows the transaction is in the block a node named. "anchored": that block is the one at its height in the chain
  // this browser verified from a pinned checkpoint (hash links down from a ChainLock proven from the quorum checkpoint, or work and
  // difficulty checked). "locked": a BLS-valid ChainLock covers it (final).
  const anc = proof.anchor;
  const cl = proof.chainLock;
  const locked = lookup.chainLocked === 'verified' && cl !== null;
  // Only the chain this browser verified from a pinned checkpoint proves anything. The fallback per-transaction ChainLock (when the
  // chain could not be anchored) checks the lock's BLS signature against a masternode list that DAPI nodes merely agree on (2 of 3):
  // consistent, not proven, on every network.
  const fallbackLock = locked && !anc;
  const proven = !!anc || locked;
  // Where the chain rests on proof of work that protects nothing (testnet) the chain facts are consistent, not secure: they stay
  // "reported", and their text says "checked", not "verified". An anchored chain says itself (`weak` is null on the quorum-proof path).
  const weak = anc ? anc.weak : network === 'mainnet' ? null : `${network} difficulty is too low for proof of work to stop a malicious node from forging the chain`;
  // only the anchored chain off weak proof of work is "verified"; everything else is "reported"
  const chainBasis: StepBasis = anc && !weak ? 'verified' : 'reported';
  const word = weak ? 'checked' : 'verified';
  if (proof.merkle) {
    const checks = `the whole block was fetched, its merkle root recomputed from every txid and the coinbase height matches${proof.blockHash === 'verified' ? '; the header hashes (X11) to the block hash' : ''}`;
    const block = { id: 'block', status: 'ok', label: 'Block inclusion' } as const;
    if (anc) steps.push({ ...block, basis: chainBasis, detail: `in block ${num(lookup.height)} of the chain ${word} in this browser`, more: `${checks}; its hash is the ${word} hash at that height${anc.pinned ? `: ${pinnedNote(anc.pinned, lookup.height)}` : ''}` });
    else if (locked) steps.push({ ...block, basis: 'reported', detail: `in block ${num(lookup.height)}, which a ChainLock covers; the chain could not be verified here`, more: `${checks}; ${AGREED_LIST}` });
    else steps.push({ ...block, basis: 'reported', detail: `in block ${num(lookup.height)} as a node names it; nothing ties that block to the chain`, more: checks });
  }
  if (!proven) steps.push(crosscheckStep(lookup.second, lookup.height));

  let inputKeys: string[] | undefined;
  if (govHashComputed) {
    const raw = governanceObjectHash({ parentHash: p.parentHash, revision: p.revision, time: p.time, dataHex: p.dataHex }).raw;
    const r = checkCollateralTx(lookup.raw, raw, { expectedTxid: p.collateralTxid.toLowerCase() });
    if (r.valid) inputKeys = inputKeyIds(lookup.raw);
    steps.push(
      r.valid
        ? { id: 'collateral', status: 'ok', label: 'OP_RETURN and outputs', detail: `output ${r.opReturnIndex} burns ${(Number(r.tx!.vout[r.opReturnIndex!]!.value) / DUFFS_PER_DASH).toFixed(8)} DASH to the gov hash; every output is P2PKH or OP_RETURN; txid matches` }
        : // Bytes that do not hash to the txid (or do not parse) are a node's fault, not the proposal's.
          { id: 'collateral', status: 'fail', label: 'OP_RETURN and outputs', detail: `${r.failure}: ${r.message ?? ''}`, ...(r.failure === 'txid-mismatch' || r.failure === 'tx-parse-error' ? { basis: 'reported' as const } : {}) },
    );
  } else {
    steps.push({ id: 'collateral', status: 'skip', label: 'OP_RETURN and outputs', detail: 'skipped: no hash to look for' });
  }

  // Confirmations: from the verified tip when anchored (a lower bound: a node can withhold newer blocks, not invent them), else the
  // fallback ChainLock's depth (reported: see fallbackLock), else the node's word.
  const provenConf = anc ? anc.confirmations : locked && cl ? cl.verifiedConfirmations : null;
  if (provenConf !== null && provenConf >= GOVERNANCE_FEE_CONFIRMATIONS) {
    steps.push({
      id: 'confirmations', status: 'ok', basis: chainBasis, label: 'Confirmations',
      detail: `at least ${num(provenConf)} (Core needs ${GOVERNANCE_FEE_CONFIRMATIONS})${anc ? '' : ', counted to a ChainLock the chain does not prove'}`,
      more: anc ? `${word} tip ${num(anc.tip)} - block ${num(lookup.height)} + 1; the node claims ${num(lookup.confirmations)}` : `headers from the block up to the ChainLock; ${AGREED_LIST}; the node claims ${num(lookup.confirmations)}`,
    });
  } else {
    // A proven count below 6 is only a lower bound (newer blocks may be withheld): the node's number stands, labelled as such.
    const confOk = lookup.confirmations >= GOVERNANCE_FEE_CONFIRMATIONS;
    steps.push({
      id: 'confirmations', status: confOk ? 'ok' : 'fail', basis: 'reported', label: 'Confirmations', detail: `${num(lookup.confirmations)} (Core needs ${GOVERNANCE_FEE_CONFIRMATIONS}), node-reported`,
      ...(provenConf !== null ? { more: `only ${num(provenConf)} proven so far` } : {}),
    });
  }
  steps.push(chainlockStep(lookup, { anc, cl, fallbackLock, chainBasis, word, weak }));
  if (p.collateralHeight) {
    // A published height the chain contradicts is a failure (the mark is the chain's): the page must not show it as checked.
    const same = lookup.height === p.collateralHeight;
    const where = anc ? ` (the coinbase of the ${word} block commits to it)` : '';
    steps.push({
      id: 'height',
      status: same ? 'ok' : 'fail',
      basis: chainBasis,
      label: 'Collateral height',
      detail: same ? `block ${num(lookup.height)}${where}` : `published as block ${num(p.collateralHeight)}, but the ${anc ? `${word} chain has it in` : 'node names'} block ${num(lookup.height)}`,
    });
  }
  if (weak) {
    for (const st of steps) {
      if ((['block', 'confirmations', 'chainlock', 'height'] as const).includes(st.id as 'block')) st.more = `${st.more ? `${st.more}; ` : ''}not secure: ${weak}`;
    }
  }
  const critical: Step['id'][] = ['hash', 'fields', 'tx', 'collateral', 'confirmations'];
  const ok = steps.filter((s) => critical.includes(s.id)).every((s) => s.status === 'ok') && !steps.some((s) => s.status === 'fail');
  const chain: ChainFacts = {
    height: lookup.height, merkle: proof.merkle, chainLocked: lookup.chainLocked, confirmations: lookup.confirmations,
    provenConfirmations: anc && !weak && provenConf !== null && provenConf >= GOVERNANCE_FEE_CONFIRMATIONS ? provenConf : null,
    lockDepth: locked && cl ? cl.verifiedConfirmations : null,
    ...(weak ? { weak } : {}),
    ...(anc ? { anchored: { tip: anc.tip, confirmations: anc.confirmations, chainLockHeight: anc.chainLockHeight, final: locked, weak: anc.weak, ...(anc.trust ? { trust: anc.trust } : {}), ...(anc.pinned ? { pinned: anc.pinned } : {}) } } : {}),
  };
  return { ok, steps, chain, ...(govHashComputed ? { govHashComputed } : {}), ...(ok && inputKeys ? { inputKeys } : {}) };
}
