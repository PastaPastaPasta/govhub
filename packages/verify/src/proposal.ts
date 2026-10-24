// Proposal data: parse, validate (mirror of Core's governance::ValidateProposal) and build.
// Source of truth: src/governance/object.cpp (limits L33-34, rules L81-L271 (CheckURL L212), ParseProposalJSON L273-L297,
// governance::ValidateProposal L999-L1034).
import { decodeAddress, type Network } from './address.ts';
import { bytesToHex, hexToBytes, isHex, utf8ToBytes } from './bytes.ts';
import { lookup, numToDouble, numToInt64, parseCoreJson, type JVal } from './corejson.ts';

/** MAX_DATA_SIZE / MAX_NAME_SIZE, object.cpp:30-31. */
export const MAX_PROPOSAL_DATA_BYTES = 512;
export const MAX_PROPOSAL_NAME_BYTES = 40;
/** GovernanceObject::PROPOSAL (governance/common.h). */
export const GOVERNANCE_OBJECT_TYPE_PROPOSAL = 1;

export interface ProposalFields {
  /** Must be 1. */
  type: number;
  /** 1..40 bytes of [-_a-z0-9] after ASCII lowercasing. */
  name: string;
  paymentAddress: string;
  /** DASH (not duffs). Must be > 0. */
  paymentAmount: number;
  /** unix seconds */
  startEpoch: number;
  /** unix seconds, must be > startEpoch */
  endEpoch: number;
  /** >= 4 bytes, no whitespace, bracket rule in CheckURL */
  url: string;
}

export interface ValidationResult {
  valid: boolean;
  /** Human readable reasons, one per failed rule (Core's strings are semicolon joined; ours are separate). */
  errors: string[];
}

export interface ValidateOptions {
  /** Core's `gobject check`/`prepare` reject proposals whose end_epoch <= now. Pass `now` (unix seconds) to enable. */
  now?: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rules on "Core style" raw values. A field is `undefined` when Core's GetDataValue would fail (missing / wrong JSON type).
// Strings are binary strings (1 char = 1 byte).

interface RawProposal {
  type?: bigint | undefined;
  name?: string | undefined;
  startEpoch?: bigint | undefined;
  endEpoch?: bigint | undefined;
  paymentAmount?: number | undefined;
  paymentAddress?: string | undefined;
  url?: string | undefined;
}

const isCoreSpace = (c: string): boolean => c === ' ' || c === '\f' || c === '\n' || c === '\r' || c === '\t' || c === '\v';
const hasCoreSpace = (s: string): boolean => {
  for (const c of s) if (isCoreSpace(c)) return true;
  return false;
};

/** object.cpp:246-277 CheckURL(): replicate Python urlparse's ValueError on unbalanced IPv6 brackets. */
export function checkUrl(urlIn: string): boolean {
  let rest = urlIn;
  const colon = rest.indexOf(':');
  if (colon !== -1) rest = rest.slice(colon + 1);
  if (rest.length > 2 && rest.startsWith('//')) {
    rest = rest.slice(2);
    const m = /[/?#]/.exec(rest);
    const netloc = m ? rest.slice(0, m.index) : rest;
    if (netloc.includes('[') && !netloc.includes(']')) return false;
    if (netloc.includes(']') && !netloc.includes('[')) return false;
  }
  return true;
}

const ALLOWED_NAME = /^[-_a-z0-9]+$/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function validateRaw(r: RawProposal, network: Network, opts: ValidateOptions): ValidationResult {
  const errors: string[] = [];

  // ValidateType
  if (r.type === undefined) errors.push('type field not found');
  else if (r.type !== BigInt(GOVERNANCE_OBJECT_TYPE_PROPOSAL)) errors.push(`type is not ${GOVERNANCE_OBJECT_TYPE_PROPOSAL}`);

  // ValidateName (ASCII-only lowercasing like Core's ToLower; length is in bytes)
  if (r.name === undefined) errors.push('name field not found');
  else if (r.name.length > MAX_PROPOSAL_NAME_BYTES) errors.push(`name exceeds ${MAX_PROPOSAL_NAME_BYTES} characters`);
  else if (r.name.length === 0) errors.push('name cannot be empty');
  else if (!ALLOWED_NAME.test(r.name.replace(/[A-Z]/g, (c) => c.toLowerCase()))) errors.push('name contains invalid characters');

  // ValidateStartEndEpoch
  if (r.startEpoch === undefined) errors.push('start_epoch field not found');
  else if (r.endEpoch === undefined) errors.push('end_epoch field not found');
  else if (r.endEpoch <= r.startEpoch) errors.push('end_epoch <= start_epoch');
  else if (opts.now !== undefined && r.endEpoch <= BigInt(Math.floor(opts.now))) errors.push('expired');

  // ValidatePaymentAmount
  if (r.paymentAmount === undefined) errors.push('payment_amount field not found');
  else if (!(r.paymentAmount > 0)) errors.push('payment_amount is negative');

  // ValidatePaymentAddress (fAllowScript = true, the default for ValidateProposal)
  if (r.paymentAddress === undefined) errors.push('payment_address field not found');
  else if (hasCoreSpace(r.paymentAddress)) errors.push("payment_address can't have whitespaces");
  else if (!decodeAddress(r.paymentAddress, network)) errors.push('payment_address is invalid');

  // ValidateURL
  if (r.url === undefined) errors.push('url field not found');
  else if (hasCoreSpace(r.url)) errors.push("url can't have whitespaces");
  else if (r.url.length < 4) errors.push('url too short');
  else if (!checkUrl(r.url)) errors.push('url invalid');

  return { valid: errors.length === 0, errors };
}

/** JS string -> binary string of its UTF-8 bytes. */
function toBinary(s: string): string {
  let out = '';
  for (const b of utf8ToBytes(s)) out += String.fromCharCode(b);
  return out;
}
function fromBinary(s: string): string {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return new TextDecoder('utf-8').decode(b);
}

/**
 * Validate typed fields with Core's ValidateProposal rules (everything except the 512-byte cap and JSON-level quirks,
 * which depend on the serialized form - use `validateProposalData` for those, or check `buildProposalDataHex(fields)`).
 * Epochs and the amount must be finite numbers; epochs must be integers.
 */
export function validateProposal(fields: ProposalFields, network: Network, opts: ValidateOptions = {}): ValidationResult {
  // JS strings with lone surrogates cannot be serialized to valid UTF-8 (Core's parser would reject the document).
  const malformed = (['name', 'paymentAddress', 'url'] as const).filter((k) => typeof fields[k] === 'string' && LONE_SURROGATE.test(fields[k]));
  if (malformed.length) return { valid: false, errors: malformed.map((k) => `${k} is not well-formed Unicode`) };
  const intOrUndef = (n: unknown): bigint | undefined => (typeof n === 'number' && Number.isSafeInteger(n) ? BigInt(n) : undefined);
  return validateRaw(
    {
      type: intOrUndef(fields.type),
      name: typeof fields.name === 'string' ? toBinary(fields.name) : undefined,
      startEpoch: intOrUndef(fields.startEpoch),
      endEpoch: intOrUndef(fields.endEpoch),
      paymentAmount: typeof fields.paymentAmount === 'number' && Number.isFinite(fields.paymentAmount) ? fields.paymentAmount : undefined,
      paymentAddress: typeof fields.paymentAddress === 'string' ? toBinary(fields.paymentAddress) : undefined,
      url: typeof fields.url === 'string' ? toBinary(fields.url) : undefined,
    },
    network,
    opts,
  );
}

export interface ParsedProposalData {
  /** Byte length of the data. */
  dataBytes: number;
  /** false when Core's parser would have returned false (Core still proceeds with the partial object - see corejson.ts). */
  wellFormedJson: boolean;
  /** Present when every field is present with the right JSON type (it may still be invalid, e.g. a bad address). */
  fields: ProposalFields | null;
  /** Decoded text of the whole payload (lossy UTF-8) for display. */
  text: string;
  /** Parse level problems: not an object, too big, empty, missing / mistyped fields. */
  errors: string[];
}

function rawFromJson(root: JVal | undefined): { raw: RawProposal; isObject: boolean } {
  if (!root || root.t !== 'obj') return { raw: {}, isObject: false };
  const get = (k: string) => lookup(root, k);
  const str = (k: string): string | undefined => {
    const v = get(k);
    return v && v.t === 'str' ? v.s : undefined;
  };
  const int = (k: string): bigint | undefined => {
    const v = get(k);
    return v && v.t === 'num' ? numToInt64(v.s) : undefined;
  };
  const amt = (): number | undefined => {
    const v = get('payment_amount');
    return v && v.t === 'num' ? numToDouble(v.s) : undefined;
  };
  return {
    isObject: true,
    raw: {
      type: int('type'),
      name: str('name'),
      startEpoch: int('start_epoch'),
      endEpoch: int('end_epoch'),
      paymentAmount: amt(),
      paymentAddress: str('payment_address'),
      url: str('url'),
    },
  };
}

function decodeData(dataHex: string): { bytes: Uint8Array } | { error: string } {
  if (dataHex.length === 0) return { error: 'empty data' };
  if (!isHex(dataHex)) return { error: 'data is not valid hex' };
  return { bytes: hexToBytes(dataHex) };
}

/** Parses proposal data (hex of JSON) into typed fields using Core-compatible JSON semantics. Never throws. */
export function parseProposalData(dataHex: string): ParsedProposalData {
  const d = decodeData(dataHex);
  if ('error' in d) return { dataBytes: 0, wellFormedJson: false, fields: null, text: '', errors: [d.error] };
  const bytes = d.bytes;
  const text = new TextDecoder('utf-8').decode(bytes);
  const errors: string[] = [];
  if (bytes.length > MAX_PROPOSAL_DATA_BYTES) errors.push(`data exceeds ${MAX_PROPOSAL_DATA_BYTES} characters`);
  const parsed = parseCoreJson(bytes);
  const { raw, isObject } = rawFromJson(parsed.root);
  if (!isObject) errors.push('Proposal must be a JSON object');
  const missing = Object.entries({ type: raw.type, name: raw.name, start_epoch: raw.startEpoch, end_epoch: raw.endEpoch, payment_amount: raw.paymentAmount, payment_address: raw.paymentAddress, url: raw.url })
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);
  if (isObject && missing.length) errors.push(`missing or mistyped fields: ${missing.join(', ')}`);
  let fields: ProposalFields | null = null;
  const unsafe = [raw.type, raw.startEpoch, raw.endEpoch].some((v) => v !== undefined && (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)));
  if (unsafe) errors.push('type/start_epoch/end_epoch outside the JS safe integer range: use validateProposalData, typed fields are unavailable');
  if (isObject && missing.length === 0 && !unsafe) {
    fields = {
      type: Number(raw.type),
      name: fromBinary(raw.name!),
      startEpoch: Number(raw.startEpoch),
      endEpoch: Number(raw.endEpoch),
      paymentAmount: raw.paymentAmount!,
      paymentAddress: fromBinary(raw.paymentAddress!),
      url: fromBinary(raw.url!),
    };
  }
  return { dataBytes: bytes.length, wellFormedJson: parsed.wellFormed, fields, text, errors };
}

/**
 * Full parity with `governance::ValidateProposal(dataHex, err, fCheckExpiration, fAllowScript=true)`:
 * ParseProposalJSON (512-byte cap, Core's lenient JSON, must yield an object) followed by every field rule.
 * `opts.now` enables the expiry rule (Core's `gobject check`/`prepare` pass fCheckExpiration=true; incoming network
 * objects are validated with it disabled, because expired proposals are legitimate history).
 */
export function validateProposalData(dataHex: string, network: Network, opts: ValidateOptions = {}): ValidationResult {
  const d = decodeData(dataHex);
  if ('error' in d) return { valid: false, errors: [d.error] };
  if (d.bytes.length > MAX_PROPOSAL_DATA_BYTES) return { valid: false, errors: [`data exceeds ${MAX_PROPOSAL_DATA_BYTES} characters`] };
  const parsed = parseCoreJson(d.bytes);
  const { raw, isObject } = rawFromJson(parsed.root);
  if (!isObject) return { valid: false, errors: ['Proposal must be a JSON object'] };
  return validateRaw(raw, network, opts);
}

/**
 * Deterministic serializer for new proposals. Core accepts ANY JSON object carrying the required fields (the GUI emits
 * name, payment_address, payment_amount, url, start_epoch, end_epoch, type in that order; proposal.dash.org / DashCentral
 * emit alphabetically sorted keys). We follow the latter: keys sorted alphabetically, compact (no whitespace)
 * `JSON.stringify` output, UTF-8, then hex. The same fields therefore always give the same bytes and the same gov hash.
 *
 * Throws if the fields cannot be represented (non-finite or unsafe numbers) or if the result exceeds 512 bytes.
 */
export function buildProposalDataHex(fields: ProposalFields): string {
  for (const k of ['type', 'startEpoch', 'endEpoch'] as const) {
    if (!Number.isSafeInteger(fields[k])) throw new Error(`${k} must be a safe integer`);
  }
  if (!Number.isFinite(fields.paymentAmount)) throw new Error('paymentAmount must be finite');
  // JSON.stringify never emits exponents for |x| in [1e-6, 1e21); amounts outside are nonsense for a proposal anyway.
  if (fields.paymentAmount !== 0 && (Math.abs(fields.paymentAmount) < 1e-6 || Math.abs(fields.paymentAmount) >= 1e21)) throw new Error('paymentAmount out of representable range');
  const obj = {
    end_epoch: fields.endEpoch,
    name: fields.name,
    payment_address: fields.paymentAddress,
    payment_amount: fields.paymentAmount,
    start_epoch: fields.startEpoch,
    type: fields.type,
    url: fields.url,
  };
  const bytes = utf8ToBytes(JSON.stringify(obj));
  if (bytes.length > MAX_PROPOSAL_DATA_BYTES) throw new Error(`proposal data is ${bytes.length} bytes, max ${MAX_PROPOSAL_DATA_BYTES}`);
  return bytesToHex(bytes);
}
