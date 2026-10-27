// Masternode votes on username contests. Each vote is a Platform state transition signed in this browser with the masternode's
// voting key and sent straight to Platform: no relay and no Core. The voter is the masternode's voting identity, which Platform
// derives from the proTxHash and the voting key (it needs no credits). A vote is signed with an explicit identity nonce, so it can
// be kept and sent later (the "spread out" option): what is kept is the signed vote, never the key.
import { hash160, sha256d, signCompactHash } from '@govhub/verify';
import { hexToBytes } from '@govhub/auth';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base58 } from '@scure/base';
import { errText } from '../lib/format.ts';
import { DPNS_POLL, PARENT_DOMAIN } from './model.ts';

export type Choice = { kind: 'contender'; identityId: string } | { kind: 'abstain' } | { kind: 'lock' };

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
  label: string;
  choice: Choice;
  /** the voter identity's next nonce */
  nonce: bigint;
}

/**
 * Builds one vote with the SDK and signs it here (secp256k1 in JS: the key never enters the SDK's WASM memory) the way Platform
 * signs: a compact recoverable signature over the double SHA-256 of the signable bytes. Returns the signed transition's bytes.
 */
export function signVote(mod: EvoModule, v: VoteToSign): Uint8Array {
  // Core voting keys are compressed; the old uncompressed form would hash to another key id than the one Platform holds
  if (!v.compressed) throw new Error('This voting key is in the old uncompressed form, which Platform does not accept for votes.');
  const keyHash = votingKeyHash(v.privateKey);
  const voterId = voterIdOf(v.proTxHash, keyHash);
  const owned: Array<{ free(): void }> = [];
  const keep = <T extends { free(): void }>(o: T): T => (owned.push(o), o);
  try {
    const poll = new mod.VotePoll({ contractId: DPNS_POLL.dataContractId, documentTypeName: DPNS_POLL.documentTypeName, indexName: DPNS_POLL.indexName, indexValues: [PARENT_DOMAIN, v.label] });
    const choice = v.choice.kind === 'contender' ? mod.ResourceVoteChoice.TowardsIdentity(v.choice.identityId) : v.choice.kind === 'lock' ? mod.ResourceVoteChoice.Lock() : mod.ResourceVoteChoice.Abstain();
    const vote = new mod.Vote(poll, choice);
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

/** Platform's answer to a vote, in words (consensus errors 40300-40307, 40204 for the nonce, 20002 for the signature). */
export function classifySendError(e: unknown): SendOutcome {
  const code = codeOf(e);
  const msg = errText(e);
  switch (code) {
    case 40300:
      return { kind: 'final', text: 'Platform does not list this masternode.' };
    case 40301:
      return { kind: 'final', text: 'Platform has no vote on this name.' };
    case 40302:
      return { kind: 'final', text: 'Voting on this name had closed.' };
    case 40303:
      return { kind: 'final', text: 'This masternode has used all its vote changes on this name.' };
    case 40304:
      return { kind: 'same', text: 'This masternode already votes this way.' };
    case 40305:
    case 40306:
      return { kind: 'final', text: "This masternode's voting key changed on the network. Add its new voting key." };
    case 40307:
      return { kind: 'final', text: 'This choice is not allowed on this name.' };
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
  if (name === 'AlreadyExists') return { kind: 'check', text: 'This vote was already sent.' };
  // everything else (no node answered, a timeout, the browser offline) may pass: tried again, until voting closes
  return { kind: 'retry', text: msg || 'Platform could not be reached.' };
}
