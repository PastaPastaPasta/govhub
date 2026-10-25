// Proposal ownership claims (PLAN §6.3). The highest-ranked valid method wins:
//   1. URL-embedded: the proposal URL is https://<portal>/p/<identityId>/<name>; the URL is part of the data the
//      governance hash commits to, so whoever paid the collateral named that identity. Naming is not consent: the
//      named identity is only the owner once it accepts, by publishing its own `claim` document with method 1 for
//      this govHash (its Platform-proven `$ownerId` is the acceptance; `sig` is required by the schema and ignored).
//      Until then it is reported as `named`, never as the owner.
//   2. Payment-address signature: `signmessage <paymentAddress> "govhub-claim|<net>|<govHash>|<identityId>"`.
//   3. Collateral-input signature: the same message signed by the key that spent an input of the collateral tx.
//   4. A `claimAttestation` by the hosting team (P2SH payouts, multisig, lost keys). Trusted, and labelled so.
// Soundness rules this file enforces:
//   - Nothing is read from denormalised fields: the URL and payment address come from `dataHex`, and only after the
//     governance hash recomputed from (parentHash, revision, time, dataHex) equals the claimed govHash.
//   - The identity a signature is checked for is the claim document's `$ownerId` (proven by Platform), never a value
//     inside the claim, so a signature copied into someone else's claim document does not verify.
//   - The message binds the Core network, so a testnet signature cannot claim a mainnet proposal with the same hash.
//   - Method 3 needs the collateral transaction's bytes to have been verified by the caller (txid and OP_RETURN);
//     without them method 3 is unavailable rather than assumed.
import { base58 } from '@scure/base';
import { decodeAddress, type Network } from './address.ts';
import { bytesToHex, hash160 } from './bytes.ts';
import { governanceObjectHash } from './govhash.ts';
import { recoverMessageSigner, verifyMessage } from './message.ts';
import { parseProposalData } from './proposal.ts';
import { parseTransaction } from './tx.ts';

export const CLAIM_METHODS = { url: 1, paymentAddress: 2, collateralInput: 3, attestation: 4 } as const;
export type ClaimMethodId = (typeof CLAIM_METHODS)[keyof typeof CLAIM_METHODS];

/** Upper bound on signature recoveries per proposal (each claim document costs its author ~0.00036 DASH). */
export const MAX_SIGNATURE_CHECKS = 50;
/**
 * Signature checks one identity gets on a proposal, across all methods (a typo then a correct signature must still work).
 * Only checks that cost a recovery count, here and against MAX_SIGNATURE_CHECKS: unknown methods, wrong lengths and
 * methods that cannot apply are rejected for free.
 */
export const MAX_TRIES_PER_IDENTITY = 3;

export const CLAIM_METHOD_LABEL: Record<ClaimMethodId, string> = {
  1: 'identity embedded in the proposal URL',
  2: 'signature from the payment address',
  3: 'signature from the collateral input key',
  4: 'attestation by the hosting team',
};

/** The exact string to sign: `govhub-claim|<net>|<govHash display hex>|<identityId base58>`. */
export function claimMessage(network: Network, govHash: string, identityId: string): string {
  return `govhub-claim|${network}|${govHash.toLowerCase()}|${identityId}`;
}

function isIdentityId(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/**
 * Method 1: the identity id in `https://<portal>/p/<identityId>/<name>`, or null. Strict: https, a configured portal
 * host (exact, case-insensitive), no credentials, query or fragment, exactly these three path segments, and the
 * name segment equal (case-insensitively, like Core's name rule) to the proposal's own name.
 */
export function urlClaimIdentity(url: string, name: string, portals: readonly string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  if (!portals.some((p) => p.toLowerCase() === u.host.toLowerCase())) return null;
  const parts = u.pathname.split('/');
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 'p') return null;
  const [, , id, slug] = parts as [string, string, string, string];
  if (!isIdentityId(id) || slug.toLowerCase() !== name.toLowerCase()) return null;
  return id;
}

/**
 * hash160s (hex) of the public keys that signed P2PKH-style inputs of a transaction: scriptSig = <sig> <pubkey>,
 * with a 33-byte compressed or 65-byte uncompressed key. Other input types contribute nothing.
 */
export function inputKeyIds(rawTx: Uint8Array): string[] {
  const out = new Set<string>();
  for (const vin of parseTransaction(rawTx).vin) {
    const pushes = scriptPushes(vin.scriptSig);
    if (!pushes || pushes.length !== 2) continue;
    const pk = pushes[1]!;
    const ok = (pk.length === 33 && (pk[0] === 2 || pk[0] === 3)) || (pk.length === 65 && pk[0] === 4);
    if (ok) out.add(bytesToHex(hash160(pk)));
  }
  return [...out];
}

/** Data pushes of a push-only script, or null if it contains anything else. */
function scriptPushes(s: Uint8Array): Uint8Array[] | null {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < s.length) {
    const op = s[i++]!;
    let n: number;
    if (op >= 1 && op <= 75) n = op;
    else if (op === 0x4c) n = s[i++] ?? -1;
    else if (op === 0x4d) {
      n = (s[i] ?? 0) | ((s[i + 1] ?? 0) << 8);
      i += 2;
    } else return null;
    if (n < 0 || i + n > s.length) return null;
    out.push(s.subarray(i, i + n));
    i += n;
  }
  return out;
}

export interface ClaimDoc {
  id: string;
  /** Platform-proven `$ownerId`: the identity being claimed for */
  ownerId: string;
  method: number;
  sig: Uint8Array;
  createdAt: number;
}

export interface AttestationDoc {
  id: string;
  ownerId: string;
  identityId: string;
  note?: string;
}

export interface ClaimInput {
  network: Network;
  /** display hex, as stored on Platform */
  govHash: string;
  parentHash: string;
  revision: number;
  time: number;
  dataHex: string;
  claims: readonly ClaimDoc[];
  attestations: readonly AttestationDoc[];
  /** identities whose attestations count (the hosting team: the gov contract owner / bridge identity) */
  attestors: readonly string[];
  /** hosts accepted for method 1 */
  portals: readonly string[];
  /** inputKeyIds() of the collateral tx, when the caller verified that tx; null/undefined = method 3 unavailable */
  collateralInputKeys?: readonly string[] | null;
}

export interface ValidClaim {
  identityId: string;
  method: ClaimMethodId;
  /** the claim/attestation document (for method 1: the named identity's acceptance) */
  docId?: string;
  createdAt?: number;
  detail: string;
}

export interface RejectedClaim {
  docId: string;
  ownerId: string;
  method: number;
  reason: string;
}

export interface NamedIdentity {
  identityId: string;
  /** the named identity published its method-1 acceptance: it is then the owner (nothing outranks method 1) */
  accepted: boolean;
  url: string;
}

export interface ClaimVerdict {
  /** the winning claim, or null */
  owner: ValidClaim | null;
  /** every valid claim, best first (all but the first are valid but outranked by `owner`) */
  valid: ValidClaim[];
  /** the identity the hashed proposal URL names, accepted or not; null when the URL names none */
  named: NamedIdentity | null;
  rejected: RejectedClaim[];
  /** false when dataHex does not hash to govHash: methods 1-3 are then unusable */
  dataCommitted: boolean;
  paymentAddress: string | null;
}

const rankOrder = (a: ValidClaim, b: ValidClaim) => a.method - b.method || (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.docId ?? '').localeCompare(b.docId ?? '');

export function verifyClaims(input: ClaimInput): ClaimVerdict {
  const valid: ValidClaim[] = [];
  const rejected: RejectedClaim[] = [];
  let committed = false;
  try {
    committed = governanceObjectHash({ parentHash: input.parentHash, revision: input.revision, time: input.time, dataHex: input.dataHex }).display === input.govHash.toLowerCase();
  } catch {
    committed = false;
  }
  const fields = committed ? parseProposalData(input.dataHex).fields : null;
  const paymentAddress = fields?.paymentAddress ?? null;
  const urlId = fields ? urlClaimIdentity(fields.url, fields.name, input.portals) : null;
  let accepted = false;

  const p2pkh = paymentAddress ? decodeAddress(paymentAddress, input.network)?.type === 'p2pkh' : false;
  const inputs = input.collateralInputKeys ? new Set(input.collateralInputKeys.map((k) => k.toLowerCase())) : null;
  // Claim documents are cheap to spam and a signature check costs a public-key recovery, so: oldest first, at most
  // MAX_TRIES_PER_IDENTITY recoveries per identity across all methods, and at most MAX_SIGNATURE_CHECKS in total. Claims that
  // need no recovery (method 1, unknown methods, malformed or inapplicable ones) are settled for free and use no budget.
  // Every valid claim is reported (later ones as valid but outranked); whatever is skipped is reported, never silently trusted.
  const perIdentity = new Map<string, number>();
  let checks = 0;
  const ordered = [...input.claims].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const c of ordered) {
    const reject = (reason: string) => rejected.push({ docId: c.id, ownerId: c.ownerId, method: c.method, reason });
    if (!fields) {
      reject('the proposal data does not match its hash');
      continue;
    }
    if (c.method === CLAIM_METHODS.url) {
      if (!urlId) reject('the proposal URL does not name an identity');
      else if (c.ownerId !== urlId) reject('the proposal URL names a different identity');
      else if (accepted) reject('a repeat: this identity already accepted');
      else {
        accepted = true;
        valid.push({ identityId: c.ownerId, method: 1, docId: c.id, createdAt: c.createdAt, detail: `the hashed proposal URL ${fields.url} names this identity, and it accepted` });
      }
      continue;
    }
    if (c.method !== CLAIM_METHODS.paymentAddress && c.method !== CLAIM_METHODS.collateralInput) {
      reject(`unknown claim method ${c.method}`);
      continue;
    }
    if (c.sig.length !== 65) {
      reject('signature is not 65 bytes');
      continue;
    }
    if (c.method === CLAIM_METHODS.paymentAddress && !p2pkh) {
      reject(`the payment address ${paymentAddress} is not a P2PKH address on ${input.network}, so it cannot sign`);
      continue;
    }
    if (c.method === CLAIM_METHODS.collateralInput && !inputs) {
      reject('the collateral transaction has not been verified here');
      continue;
    }
    const tries = (perIdentity.get(c.ownerId) ?? 0) + 1;
    if (tries > MAX_TRIES_PER_IDENTITY) {
      reject(`not checked: more than ${MAX_TRIES_PER_IDENTITY} signature claims by this identity`);
      continue;
    }
    if (checks >= MAX_SIGNATURE_CHECKS) {
      reject(`not checked: more than ${MAX_SIGNATURE_CHECKS} signature claims on this proposal`);
      continue;
    }
    perIdentity.set(c.ownerId, tries);
    checks++;
    const msg = claimMessage(input.network, input.govHash, c.ownerId);
    if (c.method === CLAIM_METHODS.paymentAddress) {
      if (!verifyMessage(paymentAddress!, c.sig, msg, input.network)) reject(`signature does not verify for ${paymentAddress}`);
      else valid.push({ identityId: c.ownerId, method: 2, docId: c.id, createdAt: c.createdAt, detail: `signed by the payment address ${paymentAddress}` });
    } else {
      const signer = recoverMessageSigner(c.sig, msg, input.network);
      if (!signer) reject('signature is malformed');
      else if (!inputs!.has(bytesToHex(signer.keyId))) reject(`signer ${signer.address} did not sign an input of the collateral transaction`);
      else valid.push({ identityId: c.ownerId, method: 3, docId: c.id, createdAt: c.createdAt, detail: `signed by ${signer.address}, which spent an input of the collateral` });
    }
  }

  const attestors = new Set(input.attestors);
  for (const a of input.attestations) {
    if (!attestors.has(a.ownerId)) rejected.push({ docId: a.id, ownerId: a.ownerId, method: 4, reason: 'attestation is not by the configured hosting team' });
    else if (!isIdentityId(a.identityId)) rejected.push({ docId: a.id, ownerId: a.ownerId, method: 4, reason: 'attested identity id is malformed' });
    else valid.push({ identityId: a.identityId, method: 4, docId: a.id, detail: `attested by ${a.ownerId}${a.note ? `: ${a.note}` : ''}` });
  }

  valid.sort(rankOrder);
  const named = urlId && fields ? { identityId: urlId, accepted, url: fields.url } : null;
  return { owner: valid[0] ?? null, valid, named, rejected, dataCommitted: committed, paymentAddress };
}

/**
 * Whether a claim published now with `method` could become the owner: claims rank by method, then by age, so a new one
 * wins only with a strictly stronger method than the current owner's. The UI warns before a claim that cannot.
 */
export function canOutrank(owner: Pick<ValidClaim, 'method'> | null, method: ClaimMethodId): boolean {
  return !owner || method < owner.method;
}

/** True when `sig` (base64 or bytes) is a valid claim signature by `address` for this identity: the UI's pre-check. */
export function checkClaimSignature(address: string, sig: string | Uint8Array, network: Network, govHash: string, identityId: string): boolean {
  return verifyMessage(address, sig, claimMessage(network, govHash, identityId), network);
}

