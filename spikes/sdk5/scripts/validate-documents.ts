// Document-level validation of every v1 document type, with the DPP builds that include validation.
//
//   npm run validate:docs
//
// For each type it generates (from the schema) a MAX document (every field at its maximum),
// a MIN document (required fields at their minimum) and, per bounded field, an OVER-LIMIT
// variant that must be rejected. Each is validated with `ExtendedDocument.validate(version)` and
// the MAX document is also wrapped in a batch state transition and re-parsed with full validation
// (state-transition size <= 20,480 B, field value <= 5,120 B).
//
// Engines: wasm-dpp 4.1.1 @ PV13, wasm-dpp 5.0.0-rc.8 @ PV13, wasm-dpp 5.0.0-rc.8 @ PV14.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import loadDpp4 from 'dpp4';
import loadDpp5 from 'dpp5';
import { contractsDir, errText, saveResult } from './lib.ts';

const OWNER = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';
const OWNER_BYTES = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const NAMES = ['gov', 'forum', 'badge', 'mod'] as const;
const mods = { 'wasm-dpp 4.1.1': await loadDpp4(), 'wasm-dpp 5.0.0-rc.8': await loadDpp5() } as Record<string, any>;
const engines: { label: string; mod: any; version: number }[] = [
  { label: '4.1.1 @PV13', mod: mods['wasm-dpp 4.1.1'], version: 13 },
  { label: 'rc.8 @PV13', mod: mods['wasm-dpp 5.0.0-rc.8'], version: 13 },
  { label: 'rc.8 @PV14', mod: mods['wasm-dpp 5.0.0-rc.8'], version: 14 },
];

type Mode = 'max' | 'min';
function valueFor(def: any, mode: Mode, over = false): unknown {
  if (def.const !== undefined) return def.const;
  if (def.enum) return def.enum[0];
  if (def.type === 'boolean') return true;
  if (def.type === 'integer') return over ? (def.maximum ?? 0) + 1 : mode === 'max' ? def.maximum : (def.minimum ?? 0);
  if (def.type === 'string') {
    const n = over ? def.maxLength + 1 : mode === 'max' ? def.maxLength : (def.minLength ?? 1);
    return 'x'.repeat(n);
  }
  if (def.type === 'array') {
    const n = over ? def.maxItems + 1 : mode === 'max' ? def.maxItems : def.minItems;
    return Buffer.alloc(n, 7);
  }
  throw new Error(`unsupported ${JSON.stringify(def)}`);
}
function underValue(def: any): unknown | undefined {
  if (def.const !== undefined || def.enum) return undefined;
  if (def.type === 'string' && (def.minLength ?? 0) >= 1) return 'x'.repeat(def.minLength - 1);
  if (def.type === 'array' && def.minItems >= 1) return Buffer.alloc(def.minItems - 1, 7);
  if (def.type === 'integer' && def.minimum !== undefined) return def.minimum - 1;
  return undefined;
}
function sample(def: any, mode: Mode, overField?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries<any>(def.properties)) {
    if (mode === 'min' && !(def.required ?? []).includes(k)) continue;
    out[k] = valueFor(p, mode, k === overField);
  }
  return out;
}

let failures = 0;
const header = ['contract.type', ...engines.map((e) => e.label), 'MAX ST bytes'];
console.log(header.join(' | '));
const table: string[] = [];
for (const cname of NAMES) {
  const schemas = JSON.parse(readFileSync(join(contractsDir, `${cname}.json`), 'utf8'));
  // The legacy wasm-dpp document API cannot set $createdAtCoreBlockHeight, so for the badge types the
  // validated copy drops it from `required` (the testnet round created these with it, see testnet-costs).
  for (const def of Object.values<any>(schemas)) def.required = (def.required ?? []).filter((r: string) => r !== '$createdAtCoreBlockHeight');
  for (const [type, def] of Object.entries<any>(schemas)) {
    const cells: string[] = [];
    let stBytes = '';
    for (const e of engines) {
      const dpp = new e.mod.DashPlatformProtocol({ generate: () => crypto.getRandomValues(new Uint8Array(32)) }, e.version);
      const dc = dpp.dataContract.create(OWNER_BYTES, 1n, schemas);
      const mk = (data: Record<string, unknown>) => {
        const d = dpp.document.create(dc, OWNER, type, data);
        return d;
      };
      const errs: string[] = [];
      for (const mode of ['max', 'min'] as Mode[]) {
        try {
          const r = mk(sample(def, mode)).validate(e.version);
          if (!r.isValid()) errs.push(`${mode}: ${r.getErrors().map((x: any) => String(x.message).slice(0, 80)).join('; ')}`);
        } catch (x) { errs.push(`${mode}: threw ${errText(x).slice(0, 80)}`); }
      }
      // every bounded field, one past the limit, must be rejected
      for (const [k, p] of Object.entries<any>(def.properties)) {
        const bounded = p.const !== undefined || p.type === 'string' || p.type === 'array' || (p.type === 'integer' && p.maximum !== undefined && !p.enum);
        if (!bounded) continue;
        let rejected = false;
        try {
          const bad = sample(def, 'max'); // const fields: a different value; bounded fields: one past the limit
          if (p.const !== undefined) bad[k] = 'WRONG'; else bad[k] = valueFor(p, 'max', true);
          rejected = !mk(bad).validate(e.version).isValid();
        } catch (x) {
          // identifier-typed fields are converted to 32-byte identifiers while the document is built: a wrong length is rejected right there
          if (p.contentMediaType && /byte length/.test(errText(x))) rejected = true;
          else { errs.push(`over-limit ${k} THREW (not a validation result): ${errText(x).slice(0, 60)}`); continue; }
        }
        if (!rejected) errs.push(`over-limit ${k} ACCEPTED`);
      }
      // every field with a lower bound: one below it must be rejected
      for (const [k, p] of Object.entries<any>(def.properties)) {
        const bad = underValue(p);
        if (bad === undefined) continue;
        let rejected = false;
        try { const d = sample(def, 'max'); d[k] = bad; rejected = !mk(d).validate(e.version).isValid(); } catch (x) {
          if (p.contentMediaType && /byte length/.test(errText(x))) rejected = true;
          else { errs.push(`under-limit ${k} THREW: ${errText(x).slice(0, 60)}`); continue; }
        }
        if (!rejected) errs.push(`under-limit ${k} ACCEPTED`);
      }
      // MAX document through a batch transition with full validation
      try {
        const doc = mk(sample(def, 'max'));
        const st = dpp.document.createStateTransition({ create: [doc] }, { [OWNER]: { [dc.getId().toString()]: '1' } });
        const buf: Uint8Array = st.toBuffer();
        if (e === engines[0]) stBytes = String(buf.length);
        await dpp.stateTransition.createFromBuffer(buf, { skipValidation: false });
      } catch (x) { errs.push(`ST: ${errText(x).slice(0, 100)}`); }
      cells.push(errs.length ? `FAIL (${errs.join(' | ')})` : 'PASS');
      failures += errs.length ? 1 : 0;
    }
    const line = `${cname}.${type} | ${cells.join(' | ')} | ${stBytes}`;
    console.log(line);
    table.push(line);
  }
}
// Multi-byte strings: maxLength counts characters but a field value is capped at 5,120 BYTES.
{
  const schemas = JSON.parse(readFileSync(join(contractsDir, 'forum.json'), 'utf8'));
  console.log('\nMulti-byte comment.body (euro sign = 3 bytes), wasm-dpp 4.1.1 @PV13:');
  const e = engines[0];
  const dpp = new e.mod.DashPlatformProtocol({ generate: () => crypto.getRandomValues(new Uint8Array(32)) }, e.version);
  const dc = dpp.dataContract.create(OWNER_BYTES, 1n, schemas);
  for (const n of [1700, 1707]) {
    const body = '\u20ac'.repeat(n);
    const doc = dpp.document.create(dc, OWNER, 'comment', { govHash: Buffer.alloc(32, 1), body, fmt: 1 });
    const docOk = doc.validate(e.version).isValid();
    let stOk = true;
    try { const st = dpp.document.createStateTransition({ create: [doc] }, { [OWNER]: { [dc.getId().toString()]: '1' } }); await dpp.stateTransition.createFromBuffer(st.toBuffer(), { skipValidation: false }); } catch { stOk = false; }
    const expectDoc = Buffer.byteLength(body) <= 5120;
    if (docOk !== expectDoc) failures++;
    console.log(`  ${n} chars = ${Buffer.byteLength(body)} B: ExtendedDocument.validate ${docOk ? 'accepts' : 'rejects'}; batch-ST createFromBuffer(full validation) ${stOk ? 'accepts' : 'rejects'}`);
  }
}
saveResult('validate-documents.json', { at: new Date().toISOString(), engines: engines.map((e) => e.label), rows: table, failures });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL DOCUMENT TYPES VALID (max, min, over-limit rejected, ST round trip) ON ALL ENGINES');
process.exit(failures ? 1 : 0);
