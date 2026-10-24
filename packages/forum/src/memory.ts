// In-memory forum/mod/gov store with Drive-like query semantics, for fixtures and tests. It lints every query exactly
// like the live reader would, evaluates where/orderBy/limit/startAfter, and applies DocumentOps with the contract's
// encodings (identifiers base58, other byte arrays base64), uniqueness and owner-only creation, so a fixture session
// exercises the same code paths as a real one.
import { assertQuery, type DocQuery } from '@govhub/contracts-v1/queryLint';
import { base64, bytesToId, pv13DocumentId } from './encoding.ts';
import type { RawDoc } from './convert.ts';
import type { DocData, DocumentOp, DocumentResult } from './ops.ts';
import { SCHEMAS } from './queries.ts';
import type { DocPage, DocReader } from './reader.ts';
import type { ContractKey, ForumContracts } from './types.ts';

const IDENTIFIER = 'application/x.dash.dpp.identifier';

interface PropDef {
  byteArray?: boolean;
  contentMediaType?: string;
}
interface TypeDef {
  properties: Record<string, PropDef>;
  indices?: Array<{ unique?: boolean; properties: Array<Record<string, string>> }>;
  documentsMutable?: boolean;
  canBeDeleted?: boolean;
  creationRestrictionMode?: number;
}

const cmp = (a: unknown, b: unknown): number => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
};

export interface MemoryStoreOptions {
  contracts: ForumContracts;
  /** owners of contracts with owner-only creation (`mod`, `gov`) */
  owners: Partial<Record<ContractKey, string>>;
  now?: () => number;
  /** artificial latency per query, ms */
  latency?: number;
}

export class MemoryStore implements DocReader {
  private readonly docs: Record<ContractKey, RawDoc[]> = { forum: [], mod: [], gov: [] };
  private seq = 0;
  constructor(private readonly opts: MemoryStoreOptions) {}

  private keyOf(contractId: string): ContractKey {
    const k = (Object.keys(this.opts.contracts) as ContractKey[]).find((x) => this.opts.contracts[x] === contractId);
    if (!k) throw new Error(`unknown contract ${contractId}`);
    return k;
  }

  private typeDef(contract: ContractKey, type: string): TypeDef {
    const t = SCHEMAS[contract][type] as TypeDef | undefined;
    if (!t) throw new Error(`unknown document type ${type}`);
    return t;
  }

  /** Document JSON as evo-sdk renders it. */
  private encode(contract: ContractKey, type: string, data: DocData): RawDoc {
    const props = this.typeDef(contract, type).properties;
    const out: RawDoc = {};
    for (const [k, v] of Object.entries(data)) {
      if (v instanceof Uint8Array) out[k] = props[k]?.contentMediaType === IDENTIFIER ? bytesToId(v) : base64.encode(v);
      else out[k] = v;
    }
    return out;
  }

  /** Inserts a document as stored (for seeding fixtures); returns its id. */
  seed(contract: ContractKey, type: string, ownerId: string, data: DocData, meta: { createdAt?: number; id?: string; revision?: number } = {}): string {
    const id = meta.id ?? pv13DocumentId(this.opts.contracts[contract], ownerId, type, Uint8Array.of(...new TextEncoder().encode(`seed-${++this.seq}`)));
    const t = meta.createdAt ?? this.now();
    this.docs[contract].push({ ...this.encode(contract, type, data), $id: id, $ownerId: ownerId, $type: type, $revision: meta.revision ?? 1, $createdAt: t, $updatedAt: t });
    return id;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  async query(contract: ContractKey, q: DocQuery): Promise<DocPage> {
    assertQuery(SCHEMAS[contract], q);
    if (this.opts.latency) await new Promise((r) => setTimeout(r, this.opts.latency));
    let rows = this.docs[contract].filter((d) => d.$type === q.documentTypeName);
    for (const [f, op, v] of q.where) {
      rows = rows.filter((d) => {
        const x = d[f];
        switch (op) {
          case '==':
            return x === v;
          case 'in':
            return (v as unknown[]).includes(x);
          case '>':
            return cmp(x, v) > 0;
          case '>=':
            return cmp(x, v) >= 0;
          case '<':
            return cmp(x, v) < 0;
          case '<=':
            return cmp(x, v) <= 0;
          case 'startsWith':
            return typeof x === 'string' && x.startsWith(String(v));
        }
      });
    }
    const order = q.orderBy ?? [];
    rows = [...rows].sort((a, b) => {
      for (const [f, dir] of order) {
        const c = cmp(a[f], b[f]);
        if (c) return dir === 'desc' ? -c : c;
      }
      return cmp(a.$id, b.$id);
    });
    if (q.startAfter) {
      const i = rows.findIndex((d) => d.$id === q.startAfter);
      rows = i >= 0 ? rows.slice(i + 1) : [];
    }
    return { docs: rows.slice(0, q.limit ?? 100).map((d) => ({ ...d })), height: 1 };
  }

  /** Applies a write as `ownerId` would broadcast it, with the consensus checks that matter to the UI. */
  apply(ownerId: string, op: DocumentOp): DocumentResult {
    const contract = this.keyOf(op.contractId);
    const def = this.typeDef(contract, op.type);
    const list = this.docs[contract];
    if (op.action === 'create') {
      const owner = this.opts.owners[contract];
      if (def.creationRestrictionMode === 1 && owner !== ownerId) throw new Error(`only the contract owner can create ${op.type} documents`);
      const entropy = crypto.getRandomValues(new Uint8Array(32));
      const id = pv13DocumentId(op.contractId, ownerId, op.type, entropy);
      const t = this.now();
      const doc: RawDoc = { ...this.encode(contract, op.type, op.data), $id: id, $ownerId: ownerId, $type: op.type, $revision: 1, $createdAt: t, $updatedAt: t };
      for (const ix of def.indices ?? []) {
        if (!ix.unique) continue;
        const keys = ix.properties.map((p) => Object.keys(p)[0]!);
        if (list.some((d) => d.$type === op.type && keys.every((k) => d[k] === doc[k]))) throw new Error(`duplicate unique index ${keys.join(', ')}`);
      }
      list.push(doc);
      return { id, revision: 1 };
    }
    const i = list.findIndex((d) => d.$id === op.id && d.$type === op.type);
    const cur = list[i];
    if (!cur) throw new Error(`40101 document ${op.id} not found`);
    if (cur.$ownerId !== ownerId) throw new Error('only the owner can change a document');
    if (op.action === 'delete') {
      if (def.canBeDeleted === false) throw new Error(`${op.type} documents cannot be deleted`);
      list.splice(i, 1);
      return { id: op.id };
    }
    if (def.documentsMutable === false) throw new Error(`${op.type} documents are immutable`);
    if (cur.$revision !== op.revision) throw new Error(`revision ${op.revision} is stale (stored ${String(cur.$revision)})`);
    const revision = op.revision + 1;
    list[i] = { ...this.encode(contract, op.type, op.data), $id: cur.$id, $ownerId: cur.$ownerId, $type: op.type, $revision: revision, $createdAt: cur.$createdAt, $updatedAt: this.now() };
    return { id: op.id, revision };
  }
}
