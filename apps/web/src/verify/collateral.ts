// "Content matches on-chain collateral" (PLAN §2): recompute the gov hash from the published
// fields, check the collateral transaction fetched over DAPI, and check that the denormalised
// fields shown in the UI are the ones committed in dataHex.
import type { VerifiedTransaction } from '@govhub/dapi';
import { checkCollateralTx, GOVERNANCE_FEE_CONFIRMATIONS, governanceObjectHash, parseProposalData } from '@govhub/verify';
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
}

/** What the chain lookup established, for the provenance of the collateral line. */
export interface ChainFacts {
  height: number;
  /** The tx was proven into a block by its merkle root. */
  merkle: boolean;
  chainLocked: TxLookup['chainLocked'];
  /** Confirmations proven by the ChainLock (a lower bound), or null. */
  provenConfirmations: number | null;
  /** The node's claim. */
  confirmations: number;
}

export interface CollateralVerdict {
  ok: boolean;
  steps: Step[];
  govHashComputed?: string;
  chain?: ChainFacts;
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
export function verifyCollateral(p: ProposalCore, lookup: TxLookup | { error: string }): CollateralVerdict {
  const { steps, govHashComputed } = checkContent(p);
  if ('error' in lookup) {
    steps.push({ id: 'tx', status: 'fail', label: 'Collateral transaction', detail: `not fetched: ${lookup.error}` });
    return { ok: false, steps, ...(govHashComputed ? { govHashComputed } : {}) };
  }
  const { proof } = lookup;
  const num = (n: number) => n.toLocaleString('en-US');
  steps.push({ id: 'tx', status: 'ok', label: 'Collateral transaction', detail: `${lookup.raw.length} bytes from DAPI node ${lookup.node}` });
  if (proof.merkle) {
    steps.push({
      id: 'block',
      status: 'ok',
      basis: 'verified',
      label: 'Block inclusion',
      detail: `in block ${num(lookup.height)}: the whole block was fetched, its merkle root recomputed from every txid and the coinbase height matches${proof.blockHash === 'verified' ? '; the header hashes (X11) to the block hash' : ''}`,
    });
  } else {
    const sec = lookup.second;
    steps.push(
      !sec
        ? { id: 'crosscheck', status: 'warn', basis: 'reported', label: 'Second node', detail: 'no second DAPI node answered; the block and confirmations rest on one node' }
        : sec.sameBytes && sec.height === lookup.height
          ? { id: 'crosscheck', status: 'ok', basis: 'reported', label: 'Second node', detail: `${sec.node} returns the same transaction in the same block` }
          : { id: 'crosscheck', status: 'fail', label: 'Second node', detail: `${sec.node} disagrees: ${sec.sameBytes ? `block ${sec.height} vs ${lookup.height}` : 'different transaction bytes'}` },
    );
  }

  if (govHashComputed) {
    const raw = governanceObjectHash({ parentHash: p.parentHash, revision: p.revision, time: p.time, dataHex: p.dataHex }).raw;
    const r = checkCollateralTx(lookup.raw, raw, { expectedTxid: p.collateralTxid.toLowerCase() });
    steps.push(
      r.valid
        ? { id: 'collateral', status: 'ok', label: 'OP_RETURN and outputs', detail: `output ${r.opReturnIndex} burns ${(Number(r.tx!.vout[r.opReturnIndex!]!.value) / DUFFS_PER_DASH).toFixed(8)} DASH to the gov hash; every output is P2PKH or OP_RETURN; txid matches` }
        : { id: 'collateral', status: 'fail', label: 'OP_RETURN and outputs', detail: `${r.failure}: ${r.message ?? ''}` },
    );
  } else {
    steps.push({ id: 'collateral', status: 'skip', label: 'OP_RETURN and outputs', detail: 'skipped: no hash to look for' });
  }

  // A ChainLock proof gives a floor for the confirmations; without it the number is the node's claim.
  const cl = proof.chainLock;
  const proven = lookup.chainLocked === 'verified' && cl && cl.verifiedConfirmations >= GOVERNANCE_FEE_CONFIRMATIONS ? cl.verifiedConfirmations : null;
  if (proven !== null) {
    steps.push({ id: 'confirmations', status: 'ok', basis: 'verified', label: 'Confirmations', detail: `at least ${num(proven)} (Core needs ${GOVERNANCE_FEE_CONFIRMATIONS}), proven by the ChainLock; the node claims ${num(lookup.confirmations)}` });
  } else {
    const confOk = lookup.confirmations >= GOVERNANCE_FEE_CONFIRMATIONS;
    steps.push({ id: 'confirmations', status: confOk ? 'ok' : 'fail', basis: 'reported', label: 'Confirmations', detail: `${num(lookup.confirmations)} (Core needs ${GOVERNANCE_FEE_CONFIRMATIONS}), node-reported` });
  }
  const why = proof.notes.length ? ` (${proof.notes.join('; ')})` : '';
  steps.push(
    lookup.chainLocked === 'verified' && cl
      ? {
          id: 'chainlock',
          status: 'ok',
          basis: 'verified',
          label: 'ChainLock',
          detail: `BLS-valid ChainLock on block ${num(cl.height)} covers the block through a header chain of ${num(cl.verifiedConfirmations)} X11-checked headers; ${cl.exact ? 'signed by the quorum Core selects' : 'signed by a quorum from the masternode list (Core\'s exact choice could not be reproduced)'}`,
        }
      : lookup.chainLocked === 'claimed'
        ? { id: 'chainlock', status: 'ok', basis: 'reported', label: 'ChainLock', detail: `block is ChainLocked (node-reported; the signature was not verified${why})` }
        : { id: 'chainlock', status: 'warn', basis: 'reported', label: 'ChainLock', detail: `node reports no ChainLock yet${why}` },
  );
  if (p.collateralHeight) {
    const same = lookup.height === p.collateralHeight;
    steps.push({
      id: 'height',
      status: same ? 'ok' : 'warn',
      basis: proof.merkle ? 'verified' : 'reported',
      label: 'Collateral height',
      detail: same ? `block ${num(lookup.height)}${proof.merkle ? ' (committed in the block\'s coinbase)' : ''}` : `chain says ${num(lookup.height)}, published ${num(p.collateralHeight)}`,
    });
  }
  const critical: Step['id'][] = ['hash', 'fields', 'tx', 'collateral', 'confirmations'];
  const ok = steps.filter((s) => critical.includes(s.id)).every((s) => s.status === 'ok') && !steps.some((s) => s.status === 'fail');
  const chain: ChainFacts = { height: lookup.height, merkle: proof.merkle, chainLocked: lookup.chainLocked, provenConfirmations: proven, confirmations: lookup.confirmations };
  return { ok, steps, chain, ...(govHashComputed ? { govHashComputed } : {}) };
}
