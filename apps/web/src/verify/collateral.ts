// "Content matches on-chain collateral" (PLAN §2): recompute the gov hash from the published
// fields, check the collateral transaction fetched over DAPI, and check that the denormalised
// fields shown in the UI are the ones committed in dataHex.
import type { VerifiedTransaction } from '@govhub/dapi';
import { checkCollateralTx, GOVERNANCE_FEE_CONFIRMATIONS, governanceObjectHash, inputKeyIds, parseProposalData } from '@govhub/verify';
import { DUFFS_PER_DASH } from '../lib/format.ts';
import type { Proposal } from '../data/types.ts';

/**
 * The collateral transaction as @govhub/dapi returns it: `chainLocked`, `proof.merkle` and `proof.chainLock` say what was proven;
 * everything else (confirmations, the IS-lock flag, and the ChainLock flag when `chainLocked` is 'claimed') is a node's word.
 */
export type TxLookup = Pick<VerifiedTransaction, 'raw' | 'height' | 'confirmations' | 'chainLocked' | 'instantLocked' | 'proof' | 'node'> & {
  /** A second node's answer for the same txid, asked only when the block inclusion is not proven. */
  second?: { node: string; height: number; sameBytes: boolean } | null;
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
  /** Confirmations proven by the ChainLock (a lower bound), when that proves the 6 Core needs; else null. */
  provenConfirmations: number | null;
  /** Blocks from the collateral's block up to the verified ChainLock, whatever their number. */
  lockDepth: number | null;
  /** The node's claim. */
  confirmations: number;
  /** The block is in the chain this browser verified (headers from the checkpoint); `confirmations` below is then counted from its tip. */
  anchored?: { tip: number; confirmations: number; chainLockHeight: number; final: boolean };
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
  /** The transaction could not be fetched for reasons that say nothing about the proposal (nodes unreachable, timeouts). */
  inconclusive?: boolean;
  /** Why the verified chain could not be built (the old per-transaction proof was used instead). */
  anchorError?: string;
}

/** A failed lookup: `notFound` when several distinct DAPI nodes answered NOT_FOUND (the collateral is not on this chain). */
export type LookupError = { error: string; notFound?: boolean };

/** Steps whose failure can be a fact about the proposal itself, when it does not rest on one node's word (`basis: 'reported'`). */
const DEFINITE: readonly Step['id'][] = ['hash', 'fields', 'tx', 'collateral', 'confirmations'];

/**
 * Why a verdict means the proposal failed verification, or null when it passed or the check could not conclude. Only facts count:
 * the published fields against the gov hash, a collateral missing on several nodes, or the real collateral (bytes that hash to its
 * txid) not burning to the gov hash. Anything a single node could cause (altered bytes, a low confirmation count, a second node
 * disagreeing, an unreachable network) never hides a proposal.
 */
export function verdictFailure(v: CollateralVerdict): string | null {
  if (v.ok || v.inconclusive) return null;
  if (v.steps.some((s) => s.id === 'crosscheck' && s.status === 'fail')) {
    const content = v.steps.filter((s) => (s.id === 'hash' || s.id === 'fields') && s.status === 'fail');
    return content.length ? content.map((s) => `${s.label}: ${s.detail}`).join('; ') : null;
  }
  const bad = v.steps.filter((s) => s.status === 'fail' && s.basis !== 'reported' && DEFINITE.includes(s.id));
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

/** Full verdict from the content checks plus the DAPI transaction lookup (or its error). */
export function verifyCollateral(p: ProposalCore, lookup: TxLookup | LookupError): CollateralVerdict {
  const { steps, govHashComputed } = checkContent(p);
  if ('error' in lookup) {
    steps.push({ id: 'tx', status: 'fail', label: 'Collateral transaction', detail: lookup.notFound ? `not on the chain: every DAPI node asked answered NOT_FOUND (${lookup.error})` : `not fetched: ${lookup.error}` });
    return { ok: false, steps, ...(govHashComputed ? { govHashComputed } : {}), ...(lookup.notFound ? {} : { inconclusive: true }) };
  }
  const { proof } = lookup;
  const num = (n: number) => n.toLocaleString('en-US');
  steps.push({ id: 'tx', status: 'ok', label: 'Collateral transaction', detail: `${lookup.raw.length} bytes from DAPI node ${lookup.node}` });
  // A merkle proof only shows the transaction is in the block a node named. "anchored": that block is the one at its height in the chain
  // this browser verified from the checkpoint (work and difficulty checked). "locked": a BLS-valid ChainLock covers it (final).
  const anc = proof.anchor;
  const cl = proof.chainLock;
  const locked = lookup.chainLocked === 'verified' && cl !== null;
  const proven = !!anc || locked;
  if (proof.merkle) {
    const checks = `the whole block was fetched, its merkle root recomputed from every txid and the coinbase height matches${proof.blockHash === 'verified' ? '; the header hashes (X11) to the block hash' : ''}`;
    steps.push(
      anc
        ? { id: 'block', status: 'ok', basis: 'verified', label: 'Block inclusion', detail: `in block ${num(lookup.height)} of the chain verified in this browser`, more: `${checks}; its hash is the verified hash at that height` }
        : locked
          ? { id: 'block', status: 'ok', basis: 'verified', label: 'Block inclusion', detail: `in block ${num(lookup.height)}, which a verified ChainLock covers`, more: checks }
          : { id: 'block', status: 'ok', basis: 'reported', label: 'Block inclusion', detail: `in block ${num(lookup.height)} as a node names it; nothing ties that block to the chain`, more: checks },
    );
  }
  if (!proven) {
    const sec = lookup.second;
    steps.push(
      !sec
        ? { id: 'crosscheck', status: 'warn', basis: 'reported', label: 'Second node', detail: 'no second DAPI node answered; the block and confirmations rest on one node' }
        : sec.sameBytes && sec.height === lookup.height
          ? { id: 'crosscheck', status: 'ok', basis: 'reported', label: 'Second node', detail: `${sec.node} returns the same transaction in the same block` }
          : { id: 'crosscheck', status: 'fail', label: 'Second node', detail: `${sec.node} disagrees: ${sec.sameBytes ? `block ${sec.height} vs ${lookup.height}` : 'different transaction bytes'}` },
    );
  }

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
  // ChainLock's depth, else the node's word.
  const provenConf = anc ? anc.confirmations : locked && cl ? cl.verifiedConfirmations : null;
  if (provenConf !== null && provenConf >= GOVERNANCE_FEE_CONFIRMATIONS) {
    steps.push({
      id: 'confirmations', status: 'ok', basis: 'verified', label: 'Confirmations',
      detail: `${anc ? '' : 'at least '}${num(provenConf)} (Core needs ${GOVERNANCE_FEE_CONFIRMATIONS})`,
      more: anc ? `verified tip ${num(anc.tip)} - block ${num(lookup.height)} + 1; the node claims ${num(lookup.confirmations)}` : `headers from the block up to the verified ChainLock; the node claims ${num(lookup.confirmations)}`,
    });
  } else {
    // A proven count below 6 is only a lower bound (newer blocks may be withheld): the node's number stands, labelled as such.
    const confOk = lookup.confirmations >= GOVERNANCE_FEE_CONFIRMATIONS;
    steps.push({
      id: 'confirmations', status: confOk ? 'ok' : 'fail', basis: 'reported', label: 'Confirmations', detail: `${num(lookup.confirmations)} (Core needs ${GOVERNANCE_FEE_CONFIRMATIONS}), node-reported`,
      ...(provenConf !== null ? { more: `only ${num(provenConf)} proven so far` } : {}),
    });
  }
  const notes = proof.notes.length ? proof.notes.join('; ') : undefined;
  // "proof failed" (as opposed to "block too old" or "no verifier") means the machinery ran and something did not check out.
  const proofFailed = proof.notes.some((n) => /chainlock proof failed/i.test(n));
  const quorum = (c: NonNullable<typeof cl>) => (c.exact ? 'signed by the quorum Core selects' : "signed by a quorum of the proven masternode list (Core's exact choice could not be reproduced)");
  steps.push(
    locked && cl
      ? {
          id: 'chainlock', status: 'ok', basis: 'verified', label: 'ChainLock',
          detail: `final: covered by the BLS-verified ChainLock on block ${num(cl.height)}`,
          more: `${quorum(cl)}; ${num(cl.verifiedConfirmations)} verified headers from the block to the locked one`,
        }
      : anc
        ? { id: 'chainlock', status: 'warn', basis: 'verified', label: 'ChainLock', detail: `not final yet: the block is newer than the newest verified ChainLock (block ${num(anc.chainLockHeight)})`, ...(notes ? { more: notes } : {}) }
        : lookup.chainLocked === 'claimed'
          ? { id: 'chainlock', status: proofFailed ? 'warn' : 'ok', basis: 'reported', label: 'ChainLock', detail: `a node reports it ChainLocked; ${proofFailed ? 'checking the signature FAILED' : 'the signature was not checked'}`, ...(notes ? { more: notes } : {}) }
          : { id: 'chainlock', status: 'warn', basis: 'reported', label: 'ChainLock', detail: 'a node reports no ChainLock yet', ...(notes ? { more: notes } : {}) },
  );
  if (p.collateralHeight) {
    const same = lookup.height === p.collateralHeight;
    steps.push({
      id: 'height',
      status: same ? 'ok' : 'warn',
      basis: proven ? 'verified' : 'reported',
      label: 'Collateral height',
      detail: same ? `block ${num(lookup.height)}${proven ? ' (the coinbase of the verified block commits to it)' : ''}` : `chain says ${num(lookup.height)}, published ${num(p.collateralHeight)}`,
    });
  }
  const critical: Step['id'][] = ['hash', 'fields', 'tx', 'collateral', 'confirmations'];
  const ok = steps.filter((s) => critical.includes(s.id)).every((s) => s.status === 'ok') && !steps.some((s) => s.status === 'fail');
  const chain: ChainFacts = {
    height: lookup.height, merkle: proof.merkle, chainLocked: lookup.chainLocked, confirmations: lookup.confirmations,
    provenConfirmations: provenConf !== null && provenConf >= GOVERNANCE_FEE_CONFIRMATIONS ? provenConf : null,
    lockDepth: locked && cl ? cl.verifiedConfirmations : null,
    ...(anc ? { anchored: { tip: anc.tip, confirmations: anc.confirmations, chainLockHeight: anc.chainLockHeight, final: locked } } : {}),
  };
  return { ok, steps, chain, ...(govHashComputed ? { govHashComputed } : {}), ...(ok && inputKeys ? { inputKeys } : {}) };
}
