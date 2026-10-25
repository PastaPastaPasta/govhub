// PlatformPort on evo-sdk 5.x (spikes/sdk5 patterns). The caller passes the already-loaded module and a connected EvoSDK, so this
// file never pulls the SDK into a bundle by itself. All reads use the proof-verifying calls.
//
// Notes carried over from phase 0:
//  - PV13: the id of a new document is sha256d(contractId || ownerId || type || entropy); PV14 also commits to the identity-contract
//    nonce of its create transition. `new DocumentCreateTransition({ platformVersion })` derives either, so the writer knows the id
//    before it broadcasts.
//  - byteArray `where` values are base64 strings (hex silently matches nothing).
//  - A broadcast through a lagging node can fail with 40101 / nonce errors right after a write: handled by the writer below.
//  - WASM errors are not Error instances: read `.message`, `.code` (consensus code, -1 otherwise) and `.name` (the kind).
import type * as Evo from '@dashevo/evo-sdk';
import { bytesEqual, bytesToHex, fromBase64, identifierBytes, randomBytes, toBase64 } from './bytes.ts';
import { publicKeyOf as evoPub, type IdentityKeyInfo, type Network } from './keys.ts';
import type { AssetLockProofInput, DocValue, DocumentWrite, DocumentWritten, PlatformPort, SigningKey, VaultEntryDoc } from './platform.ts';

type EvoModule = typeof Evo;
type Sdk = InstanceType<EvoModule['EvoSDK']>;

const PURPOSE = ['authentication', 'encryption', 'decryption', 'transfer', 'system', 'voting', 'owner'] as const;
const LEVEL = ['master', 'critical', 'high', 'medium'] as const;
const KTYPE = ['ecdsa_secp256k1', 'bls12_381', 'ecdsa_hash160', 'bip13_script_hash', 'eddsa_25519_hash160'] as const;

const errText = (e: unknown): string => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e));
const errCode = (e: unknown): number => (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : -1);

// ---- identity(-contract) nonces (rs-dpp identity/identity_nonce.rs) ----
const NONCE_VALUE = 0xff_ffff_ffffn; // IDENTITY_NONCE_VALUE_FILTER: the low 40 bits are the nonce
const MISSING_WINDOW = 24n; // MAX_MISSING_IDENTITY_REVISIONS: the high 24 bits flag skipped nonces below the top one

/**
 * Whether nonce `n` can never be applied again, given the stored raw value (top nonce plus the missing-nonce bits): it is the top,
 * it is more than 24 below it, or it lies in the window and its "missing" bit is clear (it was used). A nonce above the top, or one
 * still flagged missing, can still land.
 */
export function nonceConsumed(raw: bigint, n: bigint): boolean {
  const top = raw & NONCE_VALUE;
  if (n > top) return false;
  if (n === top) return true;
  const back = top - n;
  if (back > MISSING_WINDOW) return true;
  return (raw & (1n << (back - 1n + 40n))) === 0n;
}

/**
 * What a failed broadcast tells the writer.
 *  - future:    "nonce too far in future" (the node lags our nonce read): re-send the SAME signed transition later.
 *  - past:      "nonce already present in past / at tip", "nonce too far in past": this nonce is spent; sign again with a fresh one,
 *               unless the spender may have been our own earlier send (settled by a proved read first).
 *  - lag:       40101 document not found: a node that does not have the document yet; re-send the same transition.
 *  - ambiguous: timeouts, transport, ExecutionNotProved, "already exists in cache" and anything else without a consensus code: the
 *               transition may or may not have executed; settled by proved state, never taken as failure.
 *  - refused:   any other consensus error (a unique index, a stale revision, validation), or a local SDK error (bad argument,
 *               serialization, config): never re-sent. A local error can follow an execution (proof result conversion), so the
 *               writer still settles it by proved reads.
 */
export type SendOutcome = 'future' | 'past' | 'lag' | 'ambiguous' | 'refused';
const LOCAL_KINDS = new Set(['InvalidArgument', 'SerializationError', 'Config', 'NonceOverflow', 'NotImplemented', 'MissingDependency']);
/** A consensus refusal: this transition was validated and refused. (A local SDK error can come after the transition executed.) */
const consensusRefusal = (e: unknown) => errCode(e) >= 10000 || (e as { name?: unknown } | null)?.name === 'StateTransitionBroadcastError';
export function classifySend(e: unknown): SendOutcome {
  const m = errText(e);
  const code = errCode(e);
  const name = (e as { name?: unknown } | null)?.name;
  if (/nonce too far in future/i.test(m)) return 'future';
  if (/nonce (already present (in past|at tip)|too far in past)/i.test(m)) return 'past';
  if (code === 40101 || /\b40101\b|document not found/i.test(m)) return 'lag';
  if (code >= 10000 || name === 'StateTransitionBroadcastError' || LOCAL_KINDS.has(String(name))) return 'refused';
  return 'ambiguous';
}

/** Identity updates: a lagging node may not have the identity yet (20000) or still have an older revision (40203). */
function classifyUpdate(e: unknown): SendOutcome {
  const c = classifySend(e);
  const code = errCode(e);
  return c === 'refused' && (code === 20000 || code === 40203) ? 'lag' : c;
}

/** Comparable form of a document value: bytes as hex, integers as decimal strings (the SDK hands back numbers or bigints). */
function norm(v: unknown): unknown {
  if (v instanceof Uint8Array) return `0x${bytesToHex(v)}`;
  if (typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v))) return `n${BigInt(v)}`;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object' && typeof (v as { toBytes?: unknown }).toBytes === 'function') return norm((v as { toBytes(): Uint8Array }).toBytes());
  return v;
}
/** The stored document holds exactly `data`'s user fields (system `$` fields are set or overwritten by Drive). */
function sameData(stored: Record<string, unknown>, data: Record<string, DocValue>): boolean {
  const ours = Object.keys(data).filter((k) => !k.startsWith('$'));
  const theirs = Object.keys(stored).filter((k) => !k.startsWith('$') && stored[k] !== undefined && stored[k] !== null);
  return ours.length === theirs.length && ours.every((k) => JSON.stringify(norm(stored[k])) === JSON.stringify(norm(data[k])));
}

export interface EvoPlatformOptions {
  /** Waits between retries (tests inject a fake). */
  sleep?: (ms: number) => Promise<void>;
  /** The clock of the send budget (tests inject a fake). */
  now?: () => number;
}

/** Broadcast attempts per write; proved reads per settle (backoff 1, 2, 4, 8 s); reads before a delete gives up (about 7 s). */
const MAX_SENDS = 6;
/** No new send starts after this long (the settle reads still run): a write never hangs the UI for many minutes. */
const SEND_BUDGET_MS = 120_000;
const READS = 5;
const PRE_READS = 4;
const sendBackoff = (i: number) => Math.min(2500 * (i + 1), 10_000);
const readBackoff = (i: number) => Math.min(1000 * 2 ** i, 8000);
/**
 * Proved reads alongside a broadcastAndWait that has not answered: the first after 2 s (a write usually executes by then), then every
 * 1.5 s, at most PROVE_READS of them (about 40 s, past the result stream's 30 s timeout); after that the wait alone decides.
 */
const proveDelay = (i: number) => (i === 0 ? 2000 : 1500);
const PROVE_READS = 25;

export function createEvoPlatform(evo: EvoModule, sdk: Sdk, network: Network, opts: EvoPlatformOptions = {}): PlatformPort {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const w = evo as unknown as {
    Identity: new (id: Uint8Array | string) => Evo.Identity;
    Identifier: new (id: Uint8Array | string) => Evo.Identifier;
    IdentityPublicKey: new (o: Evo.IdentityPublicKeyOptions) => Evo.IdentityPublicKey;
    IdentityPublicKeyInCreation: new (o: Evo.IdentityPublicKeyInCreationOptions) => Evo.IdentityPublicKeyInCreation;
    IdentitySigner: new () => Evo.IdentitySigner;
    PrivateKey: typeof Evo.PrivateKey;
    AssetLockProof: typeof Evo.AssetLockProof;
    OutPoint: new (txid: string, vout: number) => Evo.OutPoint;
    ContractBounds: typeof Evo.ContractBounds;
    Document: typeof Evo.Document;
    DocumentCreateTransition: typeof Evo.DocumentCreateTransition;
    DocumentReplaceTransition: typeof Evo.DocumentReplaceTransition;
    DocumentDeleteTransition: typeof Evo.DocumentDeleteTransition;
    BatchedTransition: typeof Evo.BatchedTransition;
    BatchTransition: typeof Evo.BatchTransition;
    PlatformVersion: { latest(): unknown };
  };

  const pk = (priv: Uint8Array) => w.PrivateKey.fromBytes(priv, network);
  const free = (...objs: Array<{ free(): void } | null | undefined>) => {
    // An object the SDK took by value is already consumed; freeing it again is a no-op we ignore.
    for (const o of objs) {
      try {
        o?.free();
      } catch {
        /* already consumed */
      }
    }
  };
  // WASM copies of private keys (PrivateKey objects, the signer's key map) are freed as soon as the call is done (best effort:
  // free() releases the WASM memory; it does not promise zeroing).
  const withKeys = async <T>(keys: readonly SigningKey[], extra: Uint8Array | null, fn: (signer: Evo.IdentitySigner, extraKey: Evo.PrivateKey | null) => Promise<T>): Promise<T> => {
    const s = new w.IdentitySigner();
    const pks = keys.map((k) => pk(k.privateKey));
    const x = extra ? pk(extra) : null;
    try {
      for (const k of pks) s.addKey(k);
      return await fn(s, x);
    } finally {
      free(...pks, x, s);
    }
  };
  const proofOf = (p: AssetLockProofInput) =>
    p.kind === 'instant'
      ? w.AssetLockProof.createInstantAssetLockProof(p.isLock, p.tx, p.creditIndex)
      : w.AssetLockProof.createChainAssetLockProof(p.coreChainLockedHeight, new w.OutPoint(p.txid, p.creditIndex));
  const keyInfo = (k: Evo.IdentityPublicKey): IdentityKeyInfo => {
    const o = k.toObject();
    return { id: o.id, purpose: o.purpose, securityLevel: o.securityLevel, type: o.type, data: Uint8Array.from(o.data), disabled: o.disabledAt !== undefined && o.disabledAt !== null, bound: !!o.contractBounds };
  };
  const fetchIdentity = async (id: string) => (await sdk.identities.fetchWithProof(id)).data;

  /**
   * Proved reads until `accept` takes one, backing off between them. `hit` is the accepted value; otherwise `last` is the newest
   * value read and `error` the newest read error (a failed read is a miss, never "absent").
   */
  async function readUntil<T>(read: () => Promise<T>, accept: (v: T) => boolean, tries = READS): Promise<{ hit?: T; last?: T; error?: unknown }> {
    let error: unknown;
    let last: T | undefined;
    for (let i = 0; i < tries; i++) {
      if (i) await sleep(readBackoff(i - 1));
      try {
        const v = await read();
        if (accept(v)) return { hit: v };
        last = v;
      } catch (e) {
        error = e;
      }
    }
    return { last, error };
  }

  const toEntry = (d: Record<string, unknown>): VaultEntryDoc => {
    const b = (k: string): Uint8Array => {
      const v = d[k];
      if (v instanceof Uint8Array) return Uint8Array.from(v);
      if (Array.isArray(v)) return Uint8Array.from(v as number[]);
      return fromBase64(String(v));
    };
    const n = (k: string) => Number(d[k]);
    return {
      id: String(d.$id),
      ownerId: String(d.$ownerId),
      revision: n('$revision'),
      credentialId: b('credentialId'),
      recipientKey: b('recipientKey'),
      version: n('version'),
      authKeyId: n('authKeyId'),
      enc: b('enc'),
      sealed: b('sealed'),
      createdAt: d.$createdAt === undefined ? undefined : n('$createdAt'),
      updatedAt: d.$updatedAt === undefined ? undefined : n('$updatedAt'),
    };
  };
  const queryVault = async (contractId: string, where: unknown[], orderBy?: unknown[]): Promise<VaultEntryDoc[]> => {
    const res = await sdk.documents.queryWithProof({ dataContractId: contractId, documentTypeName: 'vault', where, ...(orderBy ? { orderBy } : {}), limit: 100 } as never);
    return [...res.data.values()].filter((x): x is Evo.Document => !!x).map((x) => toEntry(x.toJSON(w.PlatformVersion.latest() as never) as Record<string, unknown>));
  };

  // ---- the one document writer (govhub's forum writes, the passkey vault) ----
  //
  // Every write is a batch transition built and signed here ONCE per nonce, broadcast with stateTransitions.broadcastAndWait, and
  // settled by proved state whenever the outcome is not a clean success:
  //   create   the id is known before the broadcast (PV13: from the entropy; PV14: from the entropy and the nonce, which is the
  //            proved identity-contract nonce + 1). Done when a proved read finds that id.
  //   replace  done when a proved read shows $revision === op.revision + 1 holding exactly our data.
  //   delete   a proved pre-read must find the document (height H0); done when a proved read shows it absent at a height > H0.
  // "Too far in future", 40101 and ambiguous errors re-send the same signed transition. A spent nonce ("already present", "too far
  // in past") signs again with a fresh proved nonce; for a create only once proved reads show our own transition did not spend it
  // (its nonce is used, and its id is absent at a later height), so a create is never stored twice. Integers go to the SDK as bigint.
  const toSdk = (data: Record<string, DocValue>) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'number' ? BigInt(v) : v]));
  type Check = 'done' | 'pending' | 'no';
  interface Plan {
    /** The unsigned batch transition for this identity-contract nonce at protocol `pv` (a create learns its id here). */
    build(nonce: bigint, pv: number): Evo.StateTransition;
    /** One proved read of the state this write wants ('no': our transition can no longer apply; stop reading and sending). */
    check(): Promise<{ state: Check; height: bigint }>;
    /** Signing again with another nonce cannot apply the write twice (replace and delete; a create would make a second document). */
    idempotent: boolean;
    /** A consensus refusal of a first send is final without a read (create, delete); a replace is still checked (an earlier call may have landed). */
    readOnFirstRefusal: boolean;
    /** Why a 'no' check ends the write. */
    noMessage: string;
    /** The error when nothing could be confirmed (default: the write may still appear). */
    unconfirmed?: () => string | undefined;
    result(): DocumentWritten;
  }

  async function writeDocument({ ownerId, key: callerKey, op }: { ownerId: string; key: SigningKey; op: DocumentWrite }): Promise<DocumentWritten> {
    // A private copy for the duration of the write: signing out mid-write wipes the session's key, not this one (wiped below).
    if (callerKey.privateKey.every((b) => b === 0)) throw new Error('This session has ended. Sign in again.');
    const key: SigningKey = { ...callerKey, privateKey: callerKey.privateKey.slice() };
    try {
      return await write(ownerId, key, op);
    } catch (e) {
      throw e instanceof Error ? e : new Error(errText(e)); // WASM errors are not Error instances
    } finally {
      key.privateKey.fill(0);
    }
  }

  async function write(ownerId: string, key: SigningKey, op: DocumentWrite): Promise<DocumentWritten> {
    // Right after addKeys a lagging node can serve the identity without the new key: read again before giving up.
    const found = await readUntil(() => fetchIdentity(ownerId), (i) => !!i?.getPublicKeyById(key.id));
    const idKey = found.hit?.getPublicKeyById(key.id);
    if (!idKey) throw new Error(found.error && !found.last ? errText(found.error) : 'signing key not found on the identity');
    const owner = identifierBytes(ownerId);
    const contract = identifierBytes(op.contractId);
    const latest = w.PlatformVersion.latest() as never;
    /** A proved read reduced to plain values (the WASM document is freed). */
    const readDoc = async <T>(id: string, view: (d: Evo.Document) => T) => {
      const r = await sdk.documents.getWithProof(op.contractId, op.type, id);
      const height = BigInt(r.metadata.height);
      if (!r.data) return { found: false as const, height };
      try {
        return { found: true as const, height, value: view(r.data) };
      } finally {
        free(r.data);
      }
    };
    const batch = (t: { toDocumentTransition(): Evo.DocumentTransition; free(): void }) => {
      try {
        return w.BatchTransition.fromBatchedTransitions([new w.BatchedTransition(t.toDocumentTransition() as never)], ownerId, 0).toStateTransition();
      } finally {
        free(t);
      }
    };

    let plan: Plan;
    if (op.action === 'create') {
      const entropy = randomBytes(32);
      let id = '';
      plan = {
        build(nonce, pv) {
          const document = w.Document.fromObject(
            { $formatVersion: '0', $id: new Uint8Array(32), $ownerId: owner, $dataContractId: contract, $type: op.type, $revision: 1n, $entropy: entropy, ...toSdk(op.data) } as never,
            latest,
          );
          const t = new w.DocumentCreateTransition({ document, identityContractNonce: nonce, platformVersion: pv });
          id = t.base.id.toString();
          free(document);
          return batch(t);
        },
        async check() {
          const r = await readDoc(id, () => true);
          return { state: r.found ? 'done' : 'pending', height: r.height };
        },
        idempotent: false,
        readOnFirstRefusal: false,
        noMessage: '',
        result: () => ({ id, revision: 1 }),
      };
    } else if (op.action === 'replace') {
      let absent = false;
      plan = {
        build(nonce) {
          // The transition carries the document's revision + 1.
          const document = w.Document.fromObject(
            { $formatVersion: '0', $id: identifierBytes(op.id), $ownerId: owner, $dataContractId: contract, $type: op.type, $revision: BigInt(op.revision), ...toSdk(op.data) } as never,
            latest,
          );
          const t = new w.DocumentReplaceTransition({ document, identityContractNonce: nonce });
          free(document);
          return batch(t);
        },
        async check() {
          const r = await readDoc(op.id, (d) => ({ rev: BigInt(d.revision ?? 0n), ours: sameData(d.properties, op.data) }));
          // Absent may be a node that does not have the document yet: pending, but remembered for the final message.
          absent = !r.found;
          if (!r.found) return { state: 'pending', height: r.height };
          const want = BigInt(op.revision + 1);
          const { rev, ours } = r.value;
          if (rev < want) return { state: 'pending', height: r.height };
          return { state: rev === want && ours ? 'done' : 'no', height: r.height };
        },
        idempotent: true,
        readOnFirstRefusal: true,
        noMessage: 'This document was changed on Platform meanwhile (that may include this change). Reload and check.',
        unconfirmed: () => (absent ? 'This document is not on Platform (deleted, or not visible yet); this change was not confirmed. Reload and try again.' : undefined),
        result: () => ({ id: op.id, revision: op.revision + 1 }),
      };
    } else {
      // The document must be there before the delete (a lagging node may not have it yet: read again while absent).
      let doc: Evo.Document | undefined;
      let h0 = 0n;
      const pre = await readUntil(
        async () => {
          const r = await sdk.documents.getWithProof(op.contractId, op.type, op.id);
          doc = r.data;
          h0 = BigInt(r.metadata.height);
          return !!doc;
        },
        (present) => present,
        PRE_READS,
      );
      if (!pre.hit || !doc) throw new Error(pre.last === false ? 'Nothing to delete: this document is not on Platform (it may already be deleted).' : errText(pre.error));
      const stored = doc;
      plan = {
        build: (nonce) => batch(new w.DocumentDeleteTransition({ document: stored, identityContractNonce: nonce })),
        async check() {
          const r = await readDoc(op.id, () => true);
          return { state: !r.found && r.height > h0 ? 'done' : 'pending', height: r.height };
        },
        idempotent: true,
        readOnFirstRefusal: false,
        noMessage: '',
        result: () => ({ id: op.id }),
      };
      try {
        return await send(ownerId, op.contractId, key, idKey, plan);
      } finally {
        free(stored);
      }
    }
    return send(ownerId, op.contractId, key, idKey, plan);
  }

  async function send(ownerId: string, contractId: string, key: SigningKey, idKey: Evo.IdentityPublicKey, plan: Plan): Promise<DocumentWritten> {
    // The protocol version comes from the proved read: right after connect, sdk.version() can still be the SDK's starting version
    // (13) on a PV14 network, and the create id rule differs between them.
    const readNonce = async () => {
      const r = await sdk.identities.contractNonceWithProof(ownerId, contractId);
      return { raw: BigInt(r.data ?? 0n), height: BigInt(r.metadata.height), pv: Math.max(Number(r.metadata.protocolVersion) || 0, sdk.version()) };
    };
    const first = await readUntil(readNonce, () => true);
    if (!first.hit) throw new Error(errText(first.error));
    let pv = first.hit.pv;
    const sign = (nonce: bigint) => {
      const st = plan.build(nonce, pv);
      const p = pk(key.privateKey);
      try {
        st.sign(p, idKey);
      } finally {
        free(p);
      }
      return st;
    };
    const tryCheck = () => plan.check().catch(() => ({ state: 'pending' as Check, height: -1n }));
    /** Proved reads until the write shows as done (or definitely not ours). */
    const settled = async () => (await readUntil(tryCheck, (c) => c.state !== 'pending')).hit?.state === 'done';
    const deadline = now() + SEND_BUDGET_MS;
    let last: unknown;
    const unconfirmed = () => new Error(plan.unconfirmed?.() ?? `Platform did not confirm this write (${errText(last)}). It may still appear; reload before trying again.`);

    /**
     * broadcastAndWait, settled early by proved state. A node's result stream can stay silent until its timeout (about 30 s) although
     * the transition executed in about 2 s (govhub QA D-041), so proved reads run alongside the wait and the write is done as soon as
     * one shows it. True when a proved read settled it; otherwise it resolves or throws as broadcastAndWait does.
     */
    const broadcastOrProved = (wait: Promise<unknown>): Promise<boolean> => {
      let answered = false;
      const waited = wait.finally(() => (answered = true)).then(() => false);
      const proved = (async () => {
        await Promise.resolve(); // a wait that answers at once (tests, refusals) never starts the reads
        for (let i = 0; i < PROVE_READS && !answered; i++) {
          await sleep(proveDelay(i));
          if (!answered && (await tryCheck()).state === 'done') return true;
        }
        return new Promise<boolean>(() => {}); // never settles: `waited` alone decides the race
      })();
      return Promise.race([waited, proved]);
    };

    let nonce = (first.hit.raw & NONCE_VALUE) + 1n;
    let st = sign(nonce);
    let sent = false; // an earlier send of ours may have executed
    let held: Promise<unknown> | null = null; // the SDK may still hold `st` after a proved read settled the write
    try {
      for (let i = 0; i < MAX_SENDS && (i === 0 || now() < deadline); i++) {
        try {
          const wait = sdk.stateTransitions.broadcastAndWait(st);
          held = wait;
          await broadcastOrProved(wait);
          return plan.result();
        } catch (e) {
          last = e;
          const outcome = classifySend(e);
          if (outcome === 'refused') {
            // Only a consensus refusal of a first send is final without a read: a local SDK error can follow an execution.
            if (!sent && !plan.readOnFirstRefusal && consensusRefusal(e)) throw e;
            if (await settled()) return plan.result();
            if (consensusRefusal(e)) throw e;
            throw unconfirmed(); // a local error that may have followed an execution: "may still appear", not a plain failure
          }
          sent = true;
          const seen = await tryCheck();
          if (seen.state === 'done') return plan.result();
          if (seen.state === 'no') throw new Error(plan.noMessage);
          const lastTry = i === MAX_SENDS - 1 || now() >= deadline;
          if (outcome === 'past' && !lastTry) {
            // This nonce is spent. Sign again with a fresh one, unless the spender may have been our own transition (a create): then
            // only when a proved read shows the nonce used and, at a height at or above that read, our document absent.
            const fresh = await readNonce().catch(() => null);
            if (fresh) {
              let resign = plan.idempotent;
              if (!resign && nonceConsumed(fresh.raw, nonce)) {
                const c = await tryCheck();
                if (c.state === 'done') return plan.result();
                resign = c.height >= fresh.height;
              }
              if (resign) {
                const top = fresh.raw & NONCE_VALUE;
                pv = fresh.pv;
                nonce = (top > nonce ? top : nonce) + 1n;
                free(st);
                st = sign(nonce);
                continue;
              }
            }
          }
          if (!lastTry) await sleep(sendBackoff(i));
        }
      }
      if (await settled()) return plan.result();
      throw unconfirmed();
    } finally {
      const signed = st;
      if (held) held.then(() => free(signed), () => free(signed));
      else free(signed);
    }
  }

  return {
    network,
    async identityByUniqueKeyHash(h) {
      const r = await sdk.identities.byPublicKeyHashWithProof(Uint8Array.from(h) as never);
      return r.data ? r.data.id.toString() : null;
    },
    async identitiesByNonUniqueKeyHash(h) {
      const r = await sdk.identities.byNonUniquePublicKeyHashWithProof(Uint8Array.from(h) as never);
      return r.data.map((i: Evo.Identity) => i.id.toString());
    },
    async identityKeys(id) {
      const i = await fetchIdentity(id);
      return i ? i.publicKeys.map(keyInfo) : null;
    },
    async balance(id) {
      const r = await sdk.identities.balanceWithProof(id);
      return r.data ?? null;
    },
    async coreChainLockedHeight() {
      const r = await sdk.system.totalCreditsInPlatformWithProof();
      return Number((r as unknown as { metadata: { coreChainLockedHeight: number } }).metadata.coreChainLockedHeight);
    },
    async createIdentity({ proof, assetLockKey, keys }) {
      const alp = proofOf(proof);
      const identity = new w.Identity(alp.createIdentityId().toString());
      for (const k of keys) {
        identity.addPublicKey(
          new w.IdentityPublicKey({ keyId: k.id, purpose: PURPOSE[k.purpose]!, securityLevel: LEVEL[k.securityLevel]!, keyType: KTYPE[k.type]!, isReadOnly: false, data: evoPub(k.privateKey) }),
        );
      }
      await withKeys(keys, assetLockKey, (signer, alk) => sdk.identities.create({ identity, assetLockProof: alp, signer, assetLockPrivateKey: alk! }));
    },
    async topUpIdentity({ identityId, proof, assetLockKey }) {
      const identity = await fetchIdentity(identityId);
      if (!identity) throw new Error('identity not found');
      await withKeys([], assetLockKey, (_s, alk) => sdk.identities.topUp({ identity, assetLockProof: proofOf(proof), assetLockPrivateKey: alk! }));
    },
    async addKeys({ identityId, master, keys }) {
      // The SDK builds the IdentityUpdate (identity nonce from its cache). Retried on a lagging node (identity not there yet 20000,
      // older revision 40203), nonce errors and ambiguous outcomes. Done when a proved read shows every key with our public key data
      // (they come from the user's own seed, so that is the end state), at a revision above the first one we sent from: a retry after an
      // update that landed is success, not a duplicate-key failure, and keys already there before any send need no update.
      const wanted = keys.map((k) => ({ id: k.id, data: evoPub(k.privateKey) }));
      let sentFrom: bigint | undefined;
      let ambiguous = false; // an earlier update may have executed
      const landed = (i: Evo.Identity | undefined) =>
        !!i && (sentFrom === undefined || BigInt(i.revision) > sentFrom) && wanted.every((k) => { const p = i.getPublicKeyById(k.id); const ki = p && keyInfo(p); return !!ki && !ki.disabled && bytesEqual(ki.data, k.data); });
      // Read patiently after an ambiguous outcome, a duplicate-key refusal (40206, 40207: the keys may be there already) or a local SDK
      // error (it can follow an update that executed); a first other consensus refusal needs one read.
      const patient = (e: unknown) => ambiguous || [40206, 40207].includes(errCode(e)) || !consensusRefusal(e);
      const settled = async (e?: unknown) => (await readUntil(() => fetchIdentity(identityId), landed, patient(e) ? READS : 1)).hit !== undefined;
      const creation = () =>
        keys.map(
          (k) =>
            new w.IdentityPublicKeyInCreation({
              keyId: k.id,
              purpose: PURPOSE[k.purpose]!,
              securityLevel: LEVEL[k.securityLevel]!,
              keyType: KTYPE[k.type]!,
              isReadOnly: false,
              data: evoPub(k.privateKey),
              ...(k.bound ? { contractBounds: w.ContractBounds.SingleContractDocumentType(k.bound.contractId, k.bound.documentType) } : {}),
            } as Evo.IdentityPublicKeyInCreationOptions),
        );
      await withKeys([master, ...keys], null, async (signer) => {
        let last: unknown = new Error('identity not found');
        const deadline = now() + SEND_BUDGET_MS;
        for (let i = 0; i < MAX_SENDS && (i === 0 || now() < deadline); i++) {
          if (i) await sleep(sendBackoff(i - 1));
          const read = await readUntil(() => fetchIdentity(identityId), (x) => !!x);
          if (i && now() >= deadline) break;
          const identity = read.hit;
          if (!identity) {
            last = read.error ?? new Error('identity not found');
            continue;
          }
          if (landed(identity)) return;
          sentFrom ??= BigInt(identity.revision);
          try {
            await sdk.identities.update({ identity, addPublicKeys: creation(), signer });
            return;
          } catch (e) {
            last = e;
            const outcome = classifyUpdate(e);
            if (outcome === 'refused') {
              if (await settled(e)) return;
              throw new Error(errText(e));
            }
            ambiguous = true;
            // A spent identity nonce: make the SDK fetch it again on the next update (see the README: refreshIdentityNonce).
            if (outcome === 'past') await sdk.wasm.refreshIdentityNonce(new w.Identifier(identityId)).catch(() => undefined);
          }
        }
        if (sentFrom !== undefined && (await settled())) return;
        throw new Error(errText(last));
      });
    },
    writeDocument,
    vault: {
      list: (contractId, ownerId) => queryVault(contractId, [['$ownerId', '==', ownerId]], [['$ownerId', 'asc'], ['credentialId', 'asc']]),
      async byCredential(contractId, ownerId, credentialId) {
        const r = await queryVault(contractId, [['$ownerId', '==', ownerId], ['credentialId', '==', toBase64(credentialId)]]);
        return r[0] ?? null;
      },
      async put({ contractId, ownerId, key, entry, existing }) {
        const t = Date.now();
        const data = { credentialId: entry.credentialId, recipientKey: entry.recipientKey, version: entry.version, authKeyId: entry.authKeyId, enc: entry.enc, sealed: entry.sealed, $updatedAt: t };
        await writeDocument({
          ownerId,
          key,
          op: existing ? { action: 'replace', contractId, type: 'vault', id: existing.id, revision: existing.revision, data } : { action: 'create', contractId, type: 'vault', data: { ...data, $createdAt: t } },
        });
      },
      async remove({ contractId, ownerId, key, entry }) {
        await writeDocument({ ownerId, key, op: { action: 'delete', contractId, type: 'vault', id: entry.id } });
      },
    },
  };
}
