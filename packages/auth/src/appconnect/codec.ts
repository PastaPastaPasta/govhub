// App Connect request body and `dashpay://connect` URI (DIP pasta-app-connect, "URIs" and "Request Body").
//
//   body  = 0x02 ‖ appEphPub (33) ‖ appId (32) ‖ labelLen (1) ‖ label ‖ field*
//   field = type (1) ‖ length (1) ‖ value
//   uri   = dashpay://connect?v=2&n=<m|t|d>&r=<base64url(body)>[&cb=<percent-encoded https URL>]
//
// The decoder exists so the tests can hold the encoder to the DIP's own rules and vectors; govhub only ever emits requests.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base64urlnopad } from '@scure/base';
import { concatBytes, hash160, sha256d, toBase58 } from '../bytes.ts';

export const REQUEST_VERSION = 2;
export const MAX_BODY_BYTES = 1024;
export const MAX_URI_BYTES = 4096;
export const MAX_LABEL_BYTES = 64;
export const MAX_AUTH_BINDINGS = 4;
export const MAX_ENC_BINDINGS = 8;
export const MAX_CALLBACK_CHARS = 512;
const MAX_R_CHARS = 1366;

export const Field = { IDENTITY_HINT: 0x01, AUTH_BINDING: 0x02, CONNECTION_ID: 0x03, ENC_BINDING: 0x04, MODE: 0x05, CREATED_AT: 0x06 } as const;
const KNOWN_FIELDS: ReadonlySet<number> = new Set(Object.values(Field));
const FIXED_LENGTH: Partial<Record<number, number>> = { 0x01: 32, 0x03: 16, 0x04: 33, 0x05: 1, 0x06: 8 };
const ONCE: ReadonlySet<number> = new Set([Field.IDENTITY_HINT, Field.CONNECTION_ID, Field.MODE, Field.CREATED_AT]);

/** Wire tags of AUTH_BINDING kinds: Platform's `ContractBounds` bincode tags. */
export const BINDING_KINDS = ['singleContract', 'documentType', 'contractGroup'] as const;
export type BindingKind = (typeof BINDING_KINDS)[number];

export const NETWORK_LETTER = { mainnet: 'm', testnet: 't', devnet: 'd' } as const;
export type ConnectNetwork = keyof typeof NETWORK_LETTER;

export interface AuthBinding {
  kind: BindingKind;
  /** 1 CRITICAL or 2 HIGH. */
  securityLevel: number;
  /** Contract id, or the group id of a contractGroup binding (32 bytes). */
  id: Uint8Array;
  /** documentType only. */
  documentTypeName?: string;
  /** Proposed lifetime budget in credits; absent (0 on the wire) means no proposal. */
  totalBudget?: bigint;
  /** Proposed expiry, block time in ms; absent (0 on the wire) means no proposal. */
  expiresAt?: number;
}

export interface EncBinding {
  contractId: Uint8Array;
  /** 1 ENCRYPTION, 2 DECRYPTION. */
  purpose: number;
}

export interface ConnectRequest {
  appEphemeralPubKey: Uint8Array;
  appId: Uint8Array;
  label: string;
  authBindings: AuthBinding[];
  encBindings: EncBinding[];
  /** ms since the Unix epoch. */
  createdAt: number;
  identityHint?: Uint8Array;
  connectionId?: Uint8Array;
  renew?: boolean;
}

export type RequestErrorCode = 'unsupported' | 'invalid';

export class RequestError extends Error {
  constructor(
    readonly code: RequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppConnectRequestError';
  }
}

const invalid = (m: string): never => {
  throw new RequestError('invalid', m);
};
const unsupported = (m: string): never => {
  throw new RequestError('unsupported', m);
};

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const DOC_TYPE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
// C0, U+007F, C1 and Unicode Bidi_Control (U+061C, U+200E-F, U+202A-E, U+2066-9).
// eslint-disable-next-line no-control-regex
const LABEL_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_U64 = (1n << 64n) - 1n;

// ---- base64url (RFC 4648 section 5, no padding, canonical) ---------------------------------------------------------------------

export const toBase64url = (bytes: Uint8Array): string => base64urlnopad.encode(bytes);

/** Decodes canonical base64url only: no `=`, `+` or `/`, no length of 1 mod 4, no non-zero trailing bits. */
export function fromBase64url(text: string): Uint8Array {
  try {
    return base64urlnopad.decode(text);
  } catch {
    return invalid('not canonical base64url');
  }
}

// ---- body ----------------------------------------------------------------------------------------------------------------------

/** `hash160(appEphPub)`: what the wallet's `loginKeyResponse` is stored under. */
export const requestHash = (r: Pick<ConnectRequest, 'appEphemeralPubKey'>): Uint8Array => hash160(r.appEphemeralPubKey);

/** The DIP-14 leaf the wallet derives a binding's session key at: `hash256(appEphPub ‖ u8(bindingIndex))`. */
export const sessionKeyRequestId = (appEphemeralPubKey: Uint8Array, bindingIndex: number): Uint8Array => sha256d(concatBytes(appEphemeralPubKey, Uint8Array.of(bindingIndex)));

const len = (b: unknown, n: number, what: string) => {
  if (!(b instanceof Uint8Array) || b.length !== n) invalid(`${what} must be ${n} bytes`);
};

/** The rules every request obeys, run by the encoder before writing and by the decoder after reading. */
export function validateRequest(r: ConnectRequest): void {
  len(r.appEphemeralPubKey, 33, 'app ephemeral public key');
  try {
    secp256k1.Point.fromBytes(r.appEphemeralPubKey);
  } catch {
    invalid('app ephemeral public key is not a compressed secp256k1 point');
  }
  len(r.appId, 32, 'app id');
  if (utf8.encode(r.label).length > MAX_LABEL_BYTES) invalid(`label is longer than ${MAX_LABEL_BYTES} bytes`);
  if (LABEL_FORBIDDEN.test(r.label)) invalid('label contains control or bidirectional formatting characters');

  if (r.authBindings.length < 1 || r.authBindings.length > MAX_AUTH_BINDINGS) invalid(`expected 1 to ${MAX_AUTH_BINDINGS} auth bindings`);
  const seen = new Set<string>();
  for (const b of r.authBindings) {
    if (!BINDING_KINDS.includes(b.kind)) unsupported(`unknown binding kind ${String(b.kind)}`);
    len(b.id, 32, 'binding id');
    if (b.kind === 'documentType') {
      if (b.documentTypeName === undefined || !DOC_TYPE_NAME.test(b.documentTypeName)) invalid('a documentType binding needs a name of 1-64 [A-Za-z0-9_-]');
    } else if (b.documentTypeName !== undefined) invalid(`a ${b.kind} binding carries no document type name`);
    if (b.securityLevel !== 1 && b.securityLevel !== 2) invalid(`security level ${b.securityLevel} is not CRITICAL or HIGH`);
    if (b.totalBudget !== undefined && (b.totalBudget <= 0n || b.totalBudget > MAX_U64)) invalid('total budget must be 1 to 2^64-1 credits');
    if (b.kind === 'contractGroup' && b.totalBudget === undefined) invalid('a contractGroup binding must carry a budget');
    if (b.expiresAt !== undefined && (!Number.isSafeInteger(b.expiresAt) || b.expiresAt <= 0)) invalid('expires-at must be a positive safe integer');
    const k = `${b.kind}:${toBase58(b.id)}:${b.documentTypeName ?? ''}`;
    if (seen.has(k)) invalid('duplicate auth binding');
    seen.add(k);
  }

  if (r.encBindings.length > MAX_ENC_BINDINGS) invalid(`at most ${MAX_ENC_BINDINGS} encryption bindings`);
  const seenEnc = new Set<string>();
  for (const e of r.encBindings) {
    len(e.contractId, 32, 'encryption binding contract id');
    if (e.purpose !== 1 && e.purpose !== 2) invalid(`encryption binding purpose ${e.purpose} is not ENCRYPTION or DECRYPTION`);
    const k = `${toBase58(e.contractId)}:${e.purpose}`;
    if (seenEnc.has(k)) invalid('duplicate encryption binding');
    seenEnc.add(k);
  }

  if (!Number.isSafeInteger(r.createdAt) || r.createdAt <= 0) invalid('created-at must be a positive safe integer');
  if (r.identityHint !== undefined) len(r.identityHint, 32, 'identity hint');
  if (r.connectionId !== undefined) len(r.connectionId, 16, 'connection id');
}

const u64 = (v: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v);
  return b;
};

export function encodeRequest(r: ConnectRequest): Uint8Array {
  validateRequest(r);
  const label = utf8.encode(r.label);
  const parts: Uint8Array[] = [Uint8Array.of(REQUEST_VERSION), r.appEphemeralPubKey, r.appId, Uint8Array.of(label.length), label];
  const field = (type: number, value: Uint8Array) => parts.push(Uint8Array.of(type, value.length), value);
  if (r.identityHint) field(Field.IDENTITY_HINT, r.identityHint);
  for (const b of r.authBindings) {
    const name = b.documentTypeName === undefined ? new Uint8Array(0) : concatBytes(Uint8Array.of(b.documentTypeName.length), utf8.encode(b.documentTypeName));
    field(Field.AUTH_BINDING, concatBytes(Uint8Array.of(BINDING_KINDS.indexOf(b.kind), b.securityLevel), b.id, u64(b.totalBudget ?? 0n), u64(BigInt(b.expiresAt ?? 0)), name));
  }
  if (r.connectionId) field(Field.CONNECTION_ID, r.connectionId);
  for (const e of r.encBindings) field(Field.ENC_BINDING, concatBytes(e.contractId, Uint8Array.of(e.purpose)));
  if (r.renew) field(Field.MODE, Uint8Array.of(1));
  field(Field.CREATED_AT, u64(BigInt(r.createdAt)));
  const body = concatBytes(...parts);
  if (body.length > MAX_BODY_BYTES) invalid(`body is longer than ${MAX_BODY_BYTES} bytes`);
  return body;
}

const u64At = (v: Uint8Array, at: number): bigint => new DataView(v.buffer, v.byteOffset, v.byteLength).getBigUint64(at);

function readTime(v: Uint8Array, at: number, what: string): number | undefined {
  const x = u64At(v, at);
  if (x === 0n) return undefined;
  if (x > MAX_SAFE) invalid(`${what} is above 2^53-1`);
  return Number(x);
}

function decodeAuthBinding(v: Uint8Array): AuthBinding {
  if (v.length < 50) invalid('auth binding is truncated');
  const kind = BINDING_KINDS[v[0]!] ?? unsupported(`unknown auth binding kind ${v[0]}`);
  const b: AuthBinding = { kind, securityLevel: v[1]!, id: v.slice(2, 34) };
  const budget = u64At(v, 34);
  if (budget > 0n) b.totalBudget = budget;
  const exp = readTime(v, 42, 'expires-at');
  if (exp !== undefined) b.expiresAt = exp;
  const rest = v.subarray(50);
  if (kind === 'documentType') {
    if (rest.length < 1 || rest[0]! + 1 !== rest.length) invalid('document type name length does not match');
    try {
      b.documentTypeName = strictUtf8.decode(rest.subarray(1));
    } catch {
      invalid('document type name is not UTF-8');
    }
  } else if (rest.length) invalid(`a ${kind} binding carries trailing bytes`);
  return b;
}

export function decodeRequest(body: Uint8Array): ConnectRequest {
  if (body.length < 1) invalid('empty body');
  if (body[0] !== REQUEST_VERSION) unsupported(`request version ${body[0]}`);
  if (body.length > MAX_BODY_BYTES) invalid(`body is longer than ${MAX_BODY_BYTES} bytes`);
  if (body.length < 67) invalid('body is truncated');
  let o = 67;
  const labelLen = body[66]!;
  if (labelLen > MAX_LABEL_BYTES) invalid('label is too long');
  if (o + labelLen > body.length) invalid('body is truncated');
  let label = '';
  try {
    label = strictUtf8.decode(body.subarray(o, o + labelLen));
  } catch {
    invalid('label is not UTF-8');
  }
  o += labelLen;
  const r: ConnectRequest = { appEphemeralPubKey: body.slice(1, 34), appId: body.slice(34, 66), label, authBindings: [], encBindings: [], createdAt: 0 };
  let prev = 0;
  let sawCreatedAt = false;
  while (o < body.length) {
    if (o + 2 > body.length) invalid('field header is truncated');
    const type = body[o]!;
    const n = body[o + 1]!;
    o += 2;
    if (o + n > body.length) invalid(`field 0x${type.toString(16)} is truncated`);
    const v = body.subarray(o, o + n);
    o += n;
    // only an unknown optional (odd) type may repeat besides the bindings
    if (type < prev || (type === prev && ONCE.has(type))) invalid(`field 0x${type.toString(16)} is out of order or repeated`);
    prev = type;
    const fixed = FIXED_LENGTH[type];
    if (fixed !== undefined && n !== fixed) invalid(`field 0x${type.toString(16)} must be ${fixed} bytes`);
    switch (type) {
      case Field.IDENTITY_HINT:
        r.identityHint = v.slice();
        break;
      case Field.AUTH_BINDING:
        if (r.authBindings.length === MAX_AUTH_BINDINGS) invalid('too many auth bindings');
        r.authBindings.push(decodeAuthBinding(v));
        break;
      case Field.CONNECTION_ID:
        r.connectionId = v.slice();
        break;
      case Field.ENC_BINDING:
        if (r.encBindings.length === MAX_ENC_BINDINGS) invalid('too many encryption bindings');
        r.encBindings.push({ contractId: v.slice(0, 32), purpose: v[32]! });
        break;
      case Field.MODE:
        if (v[0] !== 1) invalid(`unknown mode ${v[0]}`);
        r.renew = true;
        break;
      case Field.CREATED_AT:
        r.createdAt = readTime(v, 0, 'created-at') ?? invalid('created-at is zero');
        sawCreatedAt = true;
        break;
      default:
        if (!KNOWN_FIELDS.has(type) && type % 2 === 0) unsupported(`unknown mandatory field 0x${type.toString(16)}`);
    }
  }
  if (!sawCreatedAt) invalid('request has no created-at');
  validateRequest(r);
  return r;
}

// ---- URI -----------------------------------------------------------------------------------------------------------------------

function checkCallback(cb: string): void {
  if (cb.length > MAX_CALLBACK_CHARS) invalid('return link is too long');
  let u: URL;
  try {
    u = new URL(cb);
  } catch {
    return invalid('return link is not a URL');
  }
  if (u.protocol !== 'https:' || u.username || u.password) invalid('return link must be https without credentials');
}

export function buildConnectUri(r: ConnectRequest, network: ConnectNetwork, callbackUrl?: string): string {
  let uri = `dashpay://connect?v=${REQUEST_VERSION}&n=${NETWORK_LETTER[network]}&r=${toBase64url(encodeRequest(r))}`;
  if (callbackUrl !== undefined) {
    checkCallback(callbackUrl);
    uri += `&cb=${encodeURIComponent(callbackUrl)}`;
  }
  if (utf8.encode(uri).length > MAX_URI_BYTES) invalid('URI is longer than 4096 bytes');
  return uri;
}

export interface ParsedConnectUri {
  request: ConnectRequest;
  body: Uint8Array;
  network: ConnectNetwork;
  callbackUrl?: string;
}

/** A wallet's reading of a `dashpay://connect` URI (the DIP's shared and connect rules). */
export function parseConnectUri(uri: string): ParsedConnectUri {
  if (utf8.encode(uri).length > MAX_URI_BYTES) invalid('URI is longer than 4096 bytes');
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/?)(?:\?([^#]*))?$/.exec(uri);
  if (!m) invalid('not a URI of the form dashpay://connect?...');
  const [, scheme, host, , query = ''] = m!;
  if (scheme!.toLowerCase() !== 'dashpay') invalid('scheme is not dashpay');
  if (host!.toLowerCase() !== 'connect') invalid(`verb ${host} is not connect`);
  const params = new Map<string, string>();
  for (const part of query ? query.split('&') : []) {
    const eq = part.indexOf('=');
    const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));
    let name: string;
    let value: string;
    try {
      name = decode(eq < 0 ? part : part.slice(0, eq));
      value = decode(eq < 0 ? '' : part.slice(eq + 1));
    } catch {
      return invalid('query is not form-encoded');
    }
    if (['v', 'n', 'r', 'cb'].includes(name) && params.has(name)) invalid(`parameter ${name} is repeated`);
    if (!params.has(name)) params.set(name, value);
  }
  if (params.get('v') !== String(REQUEST_VERSION)) unsupported(`URI version ${params.get('v') ?? '(none)'}`);
  const letter = params.get('n');
  const network = (Object.keys(NETWORK_LETTER) as ConnectNetwork[]).find((k) => NETWORK_LETTER[k] === letter) ?? invalid(`unknown network ${letter ?? '(none)'}`);
  const rText = params.get('r') ?? invalid('r is missing');
  if (rText.length > MAX_R_CHARS) invalid('r is too long');
  const body = fromBase64url(rText);
  const callbackUrl = params.get('cb');
  if (callbackUrl !== undefined) checkCallback(callbackUrl);
  return { request: decodeRequest(body), body, network, ...(callbackUrl !== undefined ? { callbackUrl } : {}) };
}
