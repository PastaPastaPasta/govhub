// A proposal being created (PLAN 6.1, without the `proposalDraft` Platform document: nothing about a draft is published before the
// user submits). It lives in this browser's localStorage and in a backup file the user downloads BEFORE paying, which resumes it on
// any device. Once the fee is paid it is burned, so everything needed to submit again is saved before any money moves: the exact
// serialized data, the time (both hashed), and then the collateral (its signed bytes before the broadcast, for a browser payment).
// No secret is ever stored: a browser payment's deposit key is derived again from the recovery phrase or the signed-in key.
import { proposalDepositPath, type CollateralFundingRecord } from '@govhub/auth';
import { bytesToHex, gobjectPrepareCommand, gobjectSubmitCommand, lockProposal, parseProposalData, validateProposalData, type LockedProposal } from '@govhub/verify';
import type { CoreNetwork } from '../data/types.ts';

export interface DraftInputs {
  name: string;
  paymentAddress: string;
  /** DASH per payment, as typed. */
  amount: string;
  /** `govhub`: https://gov.dashhq.org/p/<identity>/<name> (needs a sign-in); `custom`: the user's own link. */
  urlMode: 'govhub' | 'custom';
  customUrl: string;
  firstSuperblock: number | null;
  payments: number;
}

/** Fixed when the user locks the proposal: the time is part of the hash, so none of this may change afterwards. */
export interface DraftLock extends LockedProposal {
  name: string;
  url: string;
  paymentAddress: string;
  /** duffs per payment, decimal string */
  paymentDuffs: string;
  startEpoch: number;
  endEpoch: number;
  /** The superblocks the payments are planned for, and every one Core may pay at (wider on testnet). */
  superblocks: number[];
  eligible: number[];
  lockedAt: number;
}

export interface DraftPayment {
  method: 'browser' | 'core';
  /** Browser payments: progress of the deposit and the collateral (public data; the signed tx is saved before its broadcast). */
  funding?: CollateralFundingRecord;
  /** The collateral transaction, once known. */
  txid?: string;
}

export interface RelayReceipt {
  name: string;
  base: string;
  /** The relay's handle for a held proposal (null until it accepted one). */
  id: string | null;
  /** A relay without holding: this page asks it to submit at 6 confirmations. */
  legacy?: boolean;
  status: 'waiting' | 'submitting' | 'submitted' | 'failed' | 'unreachable';
  lastError?: string | null;
  coreMessage?: string | null;
  updatedAt: number;
}

export interface DraftSubmission {
  relays: RelayReceipt[];
  /** Core accepted the object (`gobject submit` returned its hash), and through whom: a relay's name, or `manual`. */
  submittedAt?: number;
  via?: string;
  /** A bridge (another Core node) knows the proposal. */
  seenAt?: number;
  /** The bridge published it to Platform: it is on govhub. */
  publishedAt?: number;
  /** The last confirmation check. */
  confirmations?: { n: number; basis: 'verified' | 'reported'; final: boolean; at: number };
}

export interface ProposalDraft {
  v: 1;
  id: string;
  network: CoreNetwork;
  createdAt: number;
  updatedAt: number;
  /** The identity the govhub URL names (the signed-in one when it was chosen). */
  identityId?: string;
  editStep: 0 | 1 | 2;
  inputs: DraftInputs;
  lock?: DraftLock;
  /** When the backup file was last saved, and how far the payment was then (an earlier backup lacks what came after). */
  backup?: { at: number; milestone: BackupMilestone };
  payment?: DraftPayment;
  submission?: DraftSubmission;
}

export type DraftStage = 'edit' | 'pay' | 'submit' | 'done';

/** What a backup made now would hold: the proposal, plus the deposit address, plus the signed fee transaction, plus its txid. */
export type BackupMilestone = 'locked' | 'deposit' | 'signed' | 'paid';
export function backupMilestone(d: ProposalDraft): BackupMilestone {
  if (d.payment?.txid) return 'paid';
  if (d.payment?.funding?.tx) return 'signed';
  return d.payment?.funding ? 'deposit' : 'locked';
}

/** The unit the fee is shown in. */
export const feeUnit = (network: CoreNetwork): string => (network === 'testnet' ? 'tDASH' : 'DASH');

/** The fee transaction's txid once known: confirmed by the network, or built and saved before its broadcast (it may be out there). */
export const collateralTxid = (d: ProposalDraft): string | undefined => d.payment?.txid ?? d.payment?.funding?.tx?.txid;

/**
 * Why paying the fee now would burn it for nothing (null when it is fine): Core refuses an expired proposal at submission
 * (object.cpp:146-150), and a single payment whose voting deadline has passed can never be made. `tip` null: unknown, not checked.
 */
export function payNowProblem(lock: DraftLock, tip: number | null, now: number, maturityWindow: number): string | null {
  if (lock.endEpoch <= now + 3600) return 'its end date has passed, so Dash Core would refuse it.';
  const first = lock.superblocks[0];
  if (tip !== null && first !== undefined && lock.superblocks.length === 1 && tip >= first - maturityWindow - 6) {
    return 'the voting deadline of its only payment has passed (or is too close to collect 6 confirmations), so it could never be paid.';
  }
  return null;
}

export function draftStage(d: ProposalDraft): DraftStage {
  if (!d.lock) return 'edit';
  if (!d.payment?.txid) return 'pay';
  return d.submission?.publishedAt ? 'done' : 'submit';
}

const STAGE_ORDER: DraftStage[] = ['edit', 'pay', 'submit', 'done'];

export const emptyInputs = (): DraftInputs => ({ name: '', paymentAddress: '', amount: '', urlMode: 'govhub', customUrl: '', firstSuperblock: null, payments: 1 });

export function newDraft(network: CoreNetwork, now = Date.now()): ProposalDraft {
  const id = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
  return { v: 1, id, network, createdAt: now, updatedAt: now, editStep: 0, inputs: emptyInputs() };
}

// ---- storage ---------------------------------------------------------------------------------------------------------------------

export interface DraftStore {
  load(id: string): ProposalDraft | null;
  /** Synchronous and throwing: a draft that could not be saved must stop whatever was about to happen (a payment). */
  save(d: ProposalDraft): void;
  remove(id: string): void;
  list(network?: CoreNetwork): ProposalDraft[];
}

const PREFIX = 'govhub.proposalDraft.';

const isDraft = (x: unknown): x is ProposalDraft => {
  const d = x as ProposalDraft | null;
  return !!d && d.v === 1 && typeof d.id === 'string' && /^[0-9a-f]{16}$/.test(d.id) && (d.network === 'mainnet' || d.network === 'testnet') && typeof d.inputs === 'object' && d.inputs !== null;
};

export function draftStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>): DraftStore {
  const parse = (raw: string | null): ProposalDraft | null => {
    try {
      const d = raw ? (JSON.parse(raw) as unknown) : null;
      return isDraft(d) ? d : null;
    } catch {
      return null;
    }
  };
  return {
    load: (id) => parse(storage.getItem(PREFIX + id)),
    save: (d) => storage.setItem(PREFIX + d.id, JSON.stringify({ ...d, updatedAt: Date.now() })),
    remove: (id) => storage.removeItem(PREFIX + id),
    list: (network) => {
      const out: ProposalDraft[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        const d = k?.startsWith(PREFIX) ? parse(storage.getItem(k)) : null;
        if (d && (!network || d.network === network)) out.push(d);
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },
  };
}

// ---- backup file -----------------------------------------------------------------------------------------------------------------

export const BACKUP_FORMAT = 'govhub-proposal-backup';

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/** Dash Core commands that finish the proposal without govhub. */
export function coreCommands(d: ProposalDraft): { prepare: string; submit: string } | null {
  const l = d.lock;
  if (!l) return null;
  return { prepare: gobjectPrepareCommand(l), submit: gobjectSubmitCommand(l, collateralTxid(d) ?? '<collateral txid>') };
}

/** The backup file's advice on the fee, by how far the payment got. */
function feeStatusNote(d: ProposalDraft): string {
  if (d.payment?.txid) return 'The fee is paid. Once the collateral has 6 confirmations, run the "submit" command below in Dash Core (Window > Console, or dash-cli).';
  if (d.payment?.funding?.tx) {
    return `A fee transaction (${d.payment.funding.tx.txid}) was built and saved, and may already be on the network. DO NOT PAY AGAIN: look the txid up in a block explorer, or resume in govhub with the same sign-in. Once it has 6 confirmations, run the "submit" command below.`;
  }
  if (d.payment?.funding) return 'A one-time deposit address was shown (below). If you sent money to it, do not pay with Dash Core as well: resume in govhub with the same sign-in.';
  return 'If you have not paid yet, the "prepare" command pays the fee from a Dash Core wallet and prints the collateral txid; put that txid into the "submit" command after 6 confirmations.';
}

/** The backup file: the draft itself (to resume in govhub) plus plain instructions and the Core commands (to finish without it). */
export function backupFile(d: ProposalDraft): { name: string; text: string } {
  const cmd = coreCommands(d);
  const f = d.payment?.funding;
  const body = {
    format: BACKUP_FORMAT,
    version: 1,
    savedAt: new Date().toISOString(),
    readme: [
      'This file holds everything needed to finish this Dash governance proposal. It contains no keys and no recovery phrase.',
      'Resume it in govhub: Create a proposal > Restore from a backup file. Or finish it with Dash Core:',
      feeStatusNote(d),
      ...(f
        ? [
            `A browser payment uses the one-time deposit address ${f.address}, derived from your ${f.source.kind === 'seed' ? 'recovery phrase' : 'signed-in identity key'} (${f.source.kind === 'seed' ? `path ${proposalDepositPath(d.network, f.source.index)}` : `govhub key derivation, index ${f.source.index}, identity ${f.source.identityId}`}). Sign in the same way to resume; govhub's recovery tool can return money left there.`,
          ]
        : []),
      'Never change the time or the data: the fee commits to their hash, and a changed proposal needs a new fee.',
    ],
    network: d.network,
    govHash: d.lock?.govHash ?? null,
    collateralTxid: collateralTxid(d) ?? null,
    feePaid: d.payment?.txid ? true : d.payment?.funding?.tx ? 'built and saved; may be on the network' : false,
    commands: cmd,
    draft: d,
  };
  const slug = (d.lock?.name ?? d.inputs.name ?? 'proposal').replace(/[^-_a-zA-Z0-9]/g, '').slice(0, 40) || 'proposal';
  return { name: `govhub-proposal-${slug}-${d.lock ? d.lock.govHash.slice(0, 8) : d.id.slice(0, 8)}${collateralTxid(d) ? '-paid' : ''}.json`, text: JSON.stringify(body, null, 2) + '\n' };
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Reads a backup file back into a draft for `network`. Everything that matters is checked, not trusted: the hash is recomputed from
 * the time and data, the data must be a valid proposal for this network, and the displayed fields must be the hashed ones. Throws
 * BackupError with a message for the user.
 */
export function readBackup(text: string, network: CoreNetwork): ProposalDraft {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new BackupError('This is not a govhub proposal backup (it is not JSON).');
  }
  if (!o || o.format !== BACKUP_FORMAT) throw new BackupError('This is not a govhub proposal backup file.');
  if (o.version !== 1) throw new BackupError(`This backup is version ${String(o.version)}; this govhub reads version 1.`);
  const d = o.draft as ProposalDraft;
  if (!isDraft(d)) throw new BackupError('The backup file is damaged (the proposal draft is missing or malformed).');
  if (d.network !== network) throw new BackupError(`This backup is for Dash ${d.network}; govhub is set to ${network}. Switch the network profile in Settings, then restore it.`);
  if (d.lock) {
    const l = d.lock;
    if (typeof l.dataHex !== 'string' || !Number.isSafeInteger(l.time)) throw new BackupError('The backup file is damaged (time or data).');
    let again: LockedProposal;
    try {
      again = lockProposal(l.dataHex, l.time);
    } catch {
      throw new BackupError('The backup file is damaged (the data cannot be hashed).');
    }
    if (again.govHash !== l.govHash || again.govHashRaw !== l.govHashRaw) throw new BackupError('The backup file was altered: its hash does not match its data and time.');
    if (!validateProposalData(l.dataHex, network).valid) throw new BackupError(`The proposal in this backup is not valid for Dash ${network}.`);
    const f = parseProposalData(l.dataHex).fields;
    if (!f || f.name !== l.name || f.url !== l.url || f.paymentAddress !== l.paymentAddress || f.startEpoch !== l.startEpoch || f.endEpoch !== l.endEpoch || Math.round(f.paymentAmount * 1e8) !== Number(l.paymentDuffs)) {
      throw new BackupError('The backup file was altered: the shown details differ from the hashed data.');
    }
  }
  const p = d.payment;
  if (p) {
    if (!d.lock) throw new BackupError('The backup file is damaged (a payment without a proposal).');
    if (p.txid !== undefined && !HEX64.test(p.txid)) throw new BackupError('The backup file is damaged (collateral txid).');
    if (p.funding && (p.funding.govHashRaw !== d.lock.govHashRaw || p.funding.network !== network)) throw new BackupError('The backup file is damaged (the payment is for another proposal).');
  }
  return d;
}

/** Which of two copies of the same draft to keep: the one further along (a backup can be older than this browser's copy, or newer). */
export function mergeDraft(local: ProposalDraft | null, imported: ProposalDraft): ProposalDraft {
  if (!local) return imported;
  if (local.lock && imported.lock && local.lock.govHash !== imported.lock.govHash) return { ...imported, id: newDraft(imported.network).id };
  const rank = (d: ProposalDraft) => STAGE_ORDER.indexOf(draftStage(d));
  if (rank(imported) > rank(local)) return imported;
  if (rank(imported) < rank(local)) return local;
  // same stage: a browser payment further along wins (it may hold the signed collateral)
  const fl = local.payment?.funding?.tx ? 1 : 0;
  const fi = imported.payment?.funding?.tx ? 1 : 0;
  return fi > fl ? imported : local;
}

/**
 * A deposit index no draft in this browser uses: a random free one among the first `gap` (all within a recovery scan's reach), so two
 * devices with the same sign-in rarely pick the same address; past those, the next free one.
 */
export function nextDepositIndex(drafts: readonly ProposalDraft[], addressAt: (index: number) => string, gap = 20, random = Math.random): number {
  const used = new Set(drafts.map((d) => d.payment?.funding?.address).filter(Boolean));
  const free = Array.from({ length: gap }, (_, i) => i).filter((i) => !used.has(addressAt(i)));
  if (free.length) return free[Math.floor(random() * free.length)]!;
  for (let i = gap; i < 10_000; i++) if (!used.has(addressAt(i))) return i;
  throw new Error('no free deposit index');
}

