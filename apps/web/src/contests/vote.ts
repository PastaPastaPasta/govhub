// Masternode votes on Platform: username contests and masternode polls (decisions/). Each vote is a Platform state transition signed
// in this browser with the masternode's voting key and sent straight to Platform: no relay and no Core. The voter is the masternode's voting identity, which Platform
// derives from the proTxHash and the voting key (it needs no credits). A vote is signed with an explicit identity nonce, so it can
// be kept and sent later (the "spread out" option): what is kept is the signed vote, never the key.
import { hash160, sha256d, signCompactHash } from '@govhub/verify';
import { hexToBytes } from '@govhub/auth';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base58 } from '@scure/base';
import { errText } from '../lib/format.ts';
import { DPNS_POLL, PARENT_DOMAIN } from './model.ts';

/**
 * A masternode's answer. On a contest: a contender (on a multiple choice poll, a choice's document id), abstain or lock (on a poll,
 * "none of the choices"). On a yes/no poll: yes, no or abstain.
 */
export type Choice = { kind: 'contender'; identityId: string } | { kind: 'abstain' } | { kind: 'lock' } | { kind: 'yes' } | { kind: 'no' };

export const choiceKey = (c: Choice): string => (c.kind === 'contender' ? `c:${c.identityId}` : c.kind);
export const sameChoice = (a: Choice, b: Choice): boolean => choiceKey(a) === choiceKey(b);

/** HASH160 of the compressed public key: the voting key's id on Platform (key 0 of the voter identity, ECDSA_HASH160). */
export const votingKeyHash = (privateKey: Uint8Array): Uint8Array => hash160(secp256k1.getPublicKey(privateKey, true));

/** The masternode's voting identity: SHA-256(proTxHash ‖ HASH160(voting key)), proTxHash in the order Core prints it. */
export function voterIdOf(proTxHash: string, keyHash: Uint8Array): string {
  const pro = hexToBytes(proTxHash);
  if (pro.length !== 32 || keyHash.length !== 20) throw new Error('bad proTxHash or voting key hash');
  const buf = new Uint8Array(52);
  buf.set(pro);
  buf.set(keyHash, 32);
  return base58.encode(sha256(buf));
}

/** Platform stores an identity nonce with the gaps of out-of-order nonces in its top 24 bits; the nonce itself is the low 40. */
export const NONCE_MASK = 0xff_ffff_ffffn;
/** Platform takes a nonce at most this far past the current one (and no further behind): the most votes one masternode can have waiting. */
export const NONCE_WINDOW = 24n;

type EvoModule = typeof import('@dashevo/evo-sdk');

export interface VoteToSign {
  proTxHash: string;
  privateKey: Uint8Array;
  compressed: boolean;
  /** the voter identity's next nonce */
  nonce: bigint;
}

type Vote = InstanceType<EvoModule['Vote']>;

/**
 * Signs one masternode vote here (secp256k1 in JS: the key never enters the SDK's WASM memory) the way Platform signs: a compact
 * recoverable signature over the double SHA-256 of the signable bytes. `vote` is built by the caller with the SDK and consumed here.
 * Returns the signed transition's bytes.
 */
export function signMasternodeVote(mod: EvoModule, v: VoteToSign, vote: Vote): Uint8Array {
  const owned: Array<{ free(): void }> = [vote];
  const keep = <T extends { free(): void }>(o: T): T => (owned.push(o), o);
  try {
    // Core voting keys are compressed; the old uncompressed form would hash to another key id than the one Platform holds
    if (!v.compressed) throw new Error('This voting key is in the old uncompressed form, which Platform does not accept for votes.');
    const voterId = voterIdOf(v.proTxHash, votingKeyHash(v.privateKey));
    const mvt = keep(new mod.MasternodeVoteTransition({ proTxHash: hexToBytes(v.proTxHash), voterIdentityId: base58.decode(voterId), vote, nonce: v.nonce }));
    const st = keep(mvt.toStateTransition());
    st.signaturePublicKeyId = 0;
    st.signature = signCompactHash(sha256d(st.getSignableBytes()), v.privateKey);
    return st.toBytes();
  } finally {
    for (const o of owned) {
      try {
        o.free();
      } catch {
        // consumed by the SDK already
      }
    }
  }
}

/** A contest choice as the SDK's resource vote choice (on a multiple choice poll, `contender` carries the choice's document id). */
export function resourceChoice(mod: EvoModule, c: Choice): ReturnType<EvoModule['ResourceVoteChoice']['Abstain']> {
  if (c.kind === 'contender') return mod.ResourceVoteChoice.TowardsIdentity(c.identityId);
  if (c.kind === 'lock') return mod.ResourceVoteChoice.Lock();
  if (c.kind === 'abstain') return mod.ResourceVoteChoice.Abstain();
  throw new Error('Yes and no are answers on a yes/no poll, not in a contest.');
}

/** A vote on a username contest, signed (see signMasternodeVote). */
export function signVote(mod: EvoModule, v: VoteToSign & { label: string; choice: Choice }): Uint8Array {
  const poll = new mod.VotePoll({ contractId: DPNS_POLL.dataContractId, documentTypeName: DPNS_POLL.documentTypeName, indexName: DPNS_POLL.indexName, indexValues: [PARENT_DOMAIN, v.label] });
  return signMasternodeVote(mod, v, new mod.Vote(poll, resourceChoice(mod, v.choice)));
}

/** A vote choice as Platform's JSON gives it: `{ $type: 'towardsIdentity', identity }`, `{ $type: 'abstain' }` or `{ $type: 'lock' }`. */
export function choiceFromJson(j: unknown): Choice | null {
  const x = j as { $type?: unknown; identity?: unknown } | null;
  if (x?.$type === 'towardsIdentity' && typeof x.identity === 'string') return { kind: 'contender', identityId: x.identity };
  if (x?.$type === 'abstain') return { kind: 'abstain' };
  if (x?.$type === 'lock') return { kind: 'lock' };
  return null;
}

/**
 * What a failed send means. `check`: the nonce is already used, by this very vote (an answer lost on the way back) or by another vote
 * of this masternode, so the vote is read back. `retry`: Platform could not be reached; anything else Platform says is `final`.
 */
export interface SendOutcome {
  kind: 'final' | 'retry' | 'check' | 'same';
  text: string;
  /** `check` only: the vote may still be in the mempool, so a read-back that does not see it yet is no answer */
  pending?: boolean;
}

/** Platform's consensus code: the SDK error's own (-1 when it is not a consensus error); only an error without one is searched. */
const codeOf = (e: unknown): number | null => {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = Number((e as { code: unknown }).code);
    return Number.isFinite(c) && c > 0 ? c : null;
  }
  const m = /\b(40[0-9]{3}|20002)\b/.exec(errText(e));
  return m ? Number(m[1]) : null;
};

/**
 * Platform's answer to a vote, in words (consensus errors 40300-40308, 40204 for the nonce, 20002 for the signature). `on` names what
 * was voted on: a username contest ('name') or a masternode poll ('poll').
 */
export function classifySendError(e: unknown, on: 'name' | 'poll' = 'name'): SendOutcome {
  const code = codeOf(e);
  const msg = errText(e);
  switch (code) {
    case 40300:
      return { kind: 'final', text: 'Platform does not list this masternode.' };
    case 40301:
      return { kind: 'final', text: `Platform has no vote on this ${on}.` };
    case 40302:
    case 40308:
      return { kind: 'final', text: `Voting on this ${on} had closed.` };
    case 40303:
      return { kind: 'final', text: `This masternode has used all its vote changes on this ${on}.` };
    case 40304:
      return { kind: 'same', text: 'This masternode already votes this way.' };
    case 40305:
    case 40306:
      return { kind: 'final', text: "This masternode's voting key changed on the network. Add its new voting key." };
    case 40307:
      return { kind: 'final', text: `This choice is not allowed on this ${on}.` };
    case 40204:
      if (/too far in future/i.test(msg)) return { kind: 'final', text: 'Too many votes of this masternode were waiting at once. Vote again.' };
      if (/too far in past/i.test(msg)) return { kind: 'final', text: 'Newer votes of this masternode went out first, so Platform no longer takes this one. Vote again.' };
      return { kind: 'check', text: 'This masternode voted from somewhere else meanwhile.' };
    case 20002:
      return { kind: 'final', text: 'Platform did not accept the signature.' };
  }
  // any other consensus error will not go away by asking again
  if (code !== null) return { kind: 'final', text: `Platform refused this vote: ${msg}` };
  // already in the mempool (a re-send after a lost answer): it may count, so it is read back
  // (WasmSdkError: `kind` is a number, `name` the kind's name)
  const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
  if (name === 'AlreadyExists') return { kind: 'check', text: 'This vote was already sent.', pending: true };
  // everything else (no node answered, a timeout, the browser offline) may pass: tried again, until voting closes
  return { kind: 'retry', text: msg || 'Platform could not be reached.' };
}
