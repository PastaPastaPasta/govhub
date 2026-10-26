// PV13 query-shape linter, shared by every package that queries the v1 contracts. Encodes the rules in
// README.md ("Writing and querying"), because PV13 mainnet answers a bad shape with a silent `[]` instead of an error.
//   R1  equality prefix of ONE index, then at most one range or `in` on the NEXT property, nothing after
//   R1b if the where does not cover every property of that index, orderBy must end on its last property
//   R2  `in` only on the last property of the index
//   R3  orderBy = contiguous run of index properties in index order, ending where you filter/page;
//       it must include the range/`in` property
//   R4  at most MAX_INDEX_DIFFERENCE (2) index properties left unconstrained
//   R5  limit <= 100; `in` lists of 1..100 distinct values
//   R6  value encodings: byteArray -> base64 string of the right length, identifier -> base58 string,
//       integer -> safe integer number, string -> string, boolean -> boolean
//   R7  desc needs a range (or `in`) on the last ordered property
//   R8  no `startAfter` with desc: PV13 mainnet answers it, but evo-sdk 5.0.0-rc.8 rejects the proof ("upright op in a
//       right-to-left walk"), so the read fails. Page a desc list with a range bound instead (`<=` the last key, skipping
//       the ids already seen at that key); asc + startAfter verifies fine.
export type WhereOp = '==' | '<' | '<=' | '>' | '>=' | 'in' | 'startsWith';
export type WhereClause = readonly [string, WhereOp, unknown];
export type OrderClause = readonly [string, 'asc' | 'desc'];

export interface DocQuery {
  documentTypeName: string;
  where: readonly WhereClause[];
  orderBy?: readonly OrderClause[];
  limit?: number;
  startAfter?: string;
}

interface IndexDef {
  name: string;
  unique?: boolean;
  properties: Array<Record<string, 'asc' | 'desc'>>;
}
interface PropDef {
  type?: string;
  byteArray?: boolean;
  minItems?: number;
  maxItems?: number;
  contentMediaType?: string;
}
export interface DocTypeSchema {
  indices?: IndexDef[];
  properties: Record<string, PropDef>;
}
export type ContractSchemas = Record<string, DocTypeSchema>;

const RANGE_OPS = new Set<WhereOp>(['<', '<=', '>', '>=', 'startsWith']);
const MAX_INDEX_DIFFERENCE = 2;
const MAX_LIMIT = 100;
const IDENTIFIER = 'application/x.dash.dpp.identifier';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface LintResult {
  ok: boolean;
  errors: string[];
  /** The index the query is shaped for, when one fits. */
  index?: string;
}

const SYSTEM_IDENTIFIERS = new Set(['$ownerId', '$id']);
const SYSTEM_INTEGERS = new Set(['$createdAt', '$updatedAt', '$createdAtCoreBlockHeight', '$createdAtBlockHeight', '$updatedAtBlockHeight']);

function systemProp(name: string): PropDef | undefined {
  if (SYSTEM_IDENTIFIERS.has(name)) return { type: 'array', byteArray: true, contentMediaType: IDENTIFIER, minItems: 32, maxItems: 32 };
  if (SYSTEM_INTEGERS.has(name)) return { type: 'integer' };
  return undefined;
}

function b64Len(s: string): number {
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

function valueError(field: string, def: PropDef, v: unknown): string | null {
  if (def.byteArray) {
    if (def.contentMediaType === IDENTIFIER) {
      return typeof v === 'string' && B58.test(v) ? null : `${field}: identifier values must be base58 strings (R6)`;
    }
    if (typeof v !== 'string') return `${field}: byteArray values must be base64 strings, not ${v instanceof Uint8Array ? 'Uint8Array' : typeof v} (R6)`;
    if (!B64.test(v) || v.length === 0) return `${field}: "${v.slice(0, 16)}" is not base64 (hex silently matches nothing on PV13) (R6)`;
    const n = b64Len(v);
    if ((def.minItems !== undefined && n < def.minItems) || (def.maxItems !== undefined && n > def.maxItems)) return `${field}: decoded length ${n} outside ${def.minItems}..${def.maxItems} (R6)`;
    return null;
  }
  switch (def.type) {
    case 'integer':
      return typeof v === 'number' && Number.isSafeInteger(v) ? null : `${field}: integer values must be safe JS numbers (R6)`;
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : `${field}: must be a number (R6)`;
    case 'string':
      return typeof v === 'string' ? null : `${field}: must be a string (R6)`;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${field}: must be a boolean (R6)`;
    default:
      return null;
  }
}

/** R5/R6 errors for one where clause's value (or every value of an `in` list). */
function whereValueErrors(field: string, def: PropDef, op: WhereOp, v: unknown): string[] {
  if (op !== 'in') {
    const e = valueError(field, def, v);
    return e ? [e] : [];
  }
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_LIMIT) return [`${field}: in-list must have 1..${MAX_LIMIT} values (R5)`];
  const errors: string[] = [];
  if (new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errors.push(`${field}: in-list has duplicates (R5)`);
  // One bad value is enough to report; the rest would repeat the same message.
  for (const x of v) {
    const e = valueError(field, def, x);
    if (e) {
      errors.push(e);
      break;
    }
  }
  return errors;
}

/** Index properties in order. */
const propsOf = (ix: IndexDef): string[] => ix.properties.map((p) => Object.keys(p)[0]!);

/**
 * Try to read the query as "equality prefix + optional one range/in on the next property" of index `ix`.
 * Returns the position of the range/in property (or -1) and the prefix length, or an error string.
 */
function shapeFor(ix: IndexDef, where: readonly WhereClause[]): { prefix: number; rangePos: number } | string {
  const props = propsOf(ix);
  const eq = where.filter((w) => w[1] === '==').map((w) => w[0]);
  const nonEq = where.filter((w) => w[1] !== '==');
  if (new Set(where.map((w) => w[0])).size !== where.length) return 'a property appears twice in where';
  if (nonEq.length > 1) return 'more than one range/in clause';
  const prefix = eq.length;
  for (let i = 0; i < prefix; i++) if (!eq.includes(props[i]!)) return `equality clauses are not a prefix of [${props.join(', ')}] (gap)`;
  if (nonEq.length === 0) return { prefix, rangePos: -1 };
  const r = nonEq[0]!;
  if (props[prefix] !== r[0]) return `range/in on ${r[0]} is not the property right after the equality prefix of [${props.join(', ')}]`;
  return { prefix, rangePos: prefix };
}

export function lintQuery(schemas: ContractSchemas, q: DocQuery): LintResult {
  const errors: string[] = [];
  const type = schemas[q.documentTypeName];
  if (!type) return { ok: false, errors: [`unknown document type ${q.documentTypeName}`] };

  // R5
  if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > MAX_LIMIT)) errors.push(`limit must be 1..${MAX_LIMIT} (R5)`);

  if (q.startAfter !== undefined && !B58.test(q.startAfter)) errors.push('startAfter must be a base58 document id (R5)');

  // R6
  const defOf = (f: string) => type.properties[f] ?? systemProp(f);
  for (const [f, op, v] of q.where) {
    const def = defOf(f);
    if (!def) {
      errors.push(`${f}: not a property of ${q.documentTypeName}`);
      continue;
    }
    errors.push(...whereValueErrors(f, def, op, v));
  }
  if (q.where.filter((w) => w[1] === 'in').length > 1) errors.push('only one in clause per query (R3)');

  // R1: find the index this query is shaped for. Candidates must contain every where property.
  const indices = type.indices ?? [];
  const orderBy = q.orderBy ?? [];
  const whereProps = new Set(q.where.map((w) => w[0]));
  const orderProps = orderBy.map((o) => o[0]);
  const candidates: Array<{ ix: IndexDef; prefix: number; rangePos: number }> = [];
  const shapeErrors: string[] = [];
  for (const ix of indices) {
    const props = propsOf(ix);
    if (![...whereProps].every((p) => props.includes(p))) continue;
    if (!orderProps.every((p) => props.includes(p))) continue;
    const s = shapeFor(ix, q.where);
    if (typeof s === 'string') shapeErrors.push(`${ix.name}: ${s}`);
    else candidates.push({ ix, ...s });
  }
  if (candidates.length === 0) {
    errors.push(shapeErrors.length ? `no index fits this shape (R1): ${shapeErrors.join('; ')}` : 'no index covers these where/orderBy properties (R1)');
    return { ok: false, errors };
  }

  // Prefer the candidate whose last property the orderBy ends on; otherwise the one the where covers fully.
  const lastOrder = orderProps[orderProps.length - 1];
  const chosen =
    candidates.find((c) => lastOrder !== undefined && propsOf(c.ix).at(-1) === lastOrder) ??
    candidates.find((c) => propsOf(c.ix).length === whereProps.size) ??
    candidates[0]!;
  const props = propsOf(chosen.ix);

  // R1b ambiguity trap: PV13 scores indexes by membership, so any OTHER index that contains every where
  // property competes (ties broken by index name). Pin the intended one with an orderBy ending on its last property.
  const coversAll = props.every((p) => whereProps.has(p));
  const rival = indices.some((ix) => ix !== chosen.ix && [...whereProps].every((p) => propsOf(ix).includes(p)));
  if (!coversAll && rival && lastOrder !== props.at(-1)) {
    errors.push(`where does not cover every property of ${chosen.ix.name} [${props.join(', ')}]: orderBy must end on ${props.at(-1)} (R1b)`);
  }

  // R2
  const inClause = q.where.find((w) => w[1] === 'in');
  if (inClause && props.at(-1) !== inClause[0]) errors.push(`in on ${inClause[0]} must be on the last property of ${chosen.ix.name} (R2)`);

  // R3
  if (orderBy.length) {
    const pos = orderProps.map((p) => props.indexOf(p));
    const contiguous = pos.every((p, i) => i === 0 || p === pos[i - 1]! + 1);
    if (!contiguous) errors.push(`orderBy [${orderProps.join(', ')}] is not a contiguous run of ${chosen.ix.name} in index order (R3)`);
    const start = pos[0]!;
    const end = pos[pos.length - 1]!;
    if (start > chosen.prefix) errors.push('orderBy skips index properties after the equality prefix (R3)');
    if (chosen.rangePos >= 0 && (chosen.rangePos < start || chosen.rangePos > end)) errors.push(`orderBy must include the range/in property ${props[chosen.rangePos]} (R3)`);
    else if (chosen.rangePos >= 0 && end !== chosen.rangePos) errors.push(`orderBy must end on the range/in property ${props[chosen.rangePos]}, nothing after it (R1/R3)`);
  } else if (chosen.rangePos >= 0) {
    errors.push(`range/in on ${props[chosen.rangePos]} needs an orderBy on it (R3)`);
  }

  // R4
  if (props.length - whereProps.size > MAX_INDEX_DIFFERENCE) errors.push(`more than ${MAX_INDEX_DIFFERENCE} properties of ${chosen.ix.name} unconstrained (R4)`);

  // R7
  if (orderBy.some((o) => o[1] === 'desc')) {
    const last = q.where.find((w) => w[0] === lastOrder);
    if (!last || !(RANGE_OPS.has(last[1]) || last[1] === 'in')) errors.push(`desc on PV13 needs a range (or in) on the last ordered property ${lastOrder ?? '?'} (R7)`);
    // R8
    if (q.startAfter !== undefined) errors.push('desc cannot page with startAfter: evo-sdk 5.0.0-rc.8 cannot verify the proof PV13 returns; page with a range bound on the ordered property instead (R8)');
  }

  return { ok: errors.length === 0, errors, index: chosen.ix.name };
}

export function assertQuery(schemas: ContractSchemas, q: DocQuery): void {
  const r = lintQuery(schemas, q);
  if (!r.ok) throw new Error(`query ${q.documentTypeName} violates the PV13 query rules: ${r.errors.join('; ')}`);
}
