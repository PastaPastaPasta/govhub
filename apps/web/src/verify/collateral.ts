// "Content matches on-chain collateral" (PLAN §2): recompute the gov hash from the published
// fields, check the collateral transaction fetched over DAPI, and check that the denormalised
// fields shown in the UI are the ones committed in dataHex.
import { checkCollateralTx, GOVERNANCE_FEE_CONFIRMATIONS, governanceObjectHash, parseProposalData } from '@govhub/verify';
import { DUFFS_PER_DASH } from '../lib/format.ts';
import type { Proposal } from '../data/types.ts';

export interface TxLookup {
  raw: Uint8Array;
  height: number;
  confirmations: number;
  isChainLocked: boolean;
  isInstantLocked: boolean;
  /** DAPI node that answered. */
  node: string;
}

export type StepStatus = 'ok' | 'fail' | 'warn' | 'skip';
export interface Step {
  id: 'hash' | 'fields' | 'tx' | 'collateral' | 'confirmations' | 'chainlock' | 'height';
  status: StepStatus;
  label: string;
  detail: string;
}

export interface CollateralVerdict {
  ok: boolean;
  steps: Step[];
  govHashComputed?: string;
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
  steps.push({ id: 'tx', status: 'ok', label: 'Collateral transaction', detail: `${lookup.raw.length} bytes from DAPI node ${lookup.node}` });

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

  const confOk = lookup.confirmations >= GOVERNANCE_FEE_CONFIRMATIONS;
  steps.push({ id: 'confirmations', status: confOk ? 'ok' : 'fail', label: 'Confirmations', detail: `${lookup.confirmations} (Core needs ${GOVERNANCE_FEE_CONFIRMATIONS}), node-reported` });
  steps.push({
    id: 'chainlock',
    status: lookup.isChainLocked ? 'ok' : 'warn',
    label: 'ChainLock',
    detail: lookup.isChainLocked ? 'block is ChainLocked (node-reported; BLS check not run here)' : 'node reports no ChainLock yet',
  });
  if (p.collateralHeight) {
    const same = lookup.height === p.collateralHeight;
    steps.push({ id: 'height', status: same ? 'ok' : 'warn', label: 'Collateral height', detail: same ? `block ${lookup.height}` : `chain says ${lookup.height}, published ${p.collateralHeight}` });
  }
  const critical: Step['id'][] = ['hash', 'fields', 'tx', 'collateral', 'confirmations'];
  const ok = steps.filter((s) => critical.includes(s.id)).every((s) => s.status === 'ok');
  return { ok, steps, ...(govHashComputed ? { govHashComputed } : {}) };
}
