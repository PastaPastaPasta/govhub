// Offline validation of the govhub v1 contracts.
//
//   npm run validate
//
// Two independent engines, because the evo-sdk's own `new DataContract({fullValidation:true})`
// turned out NOT to run the "validation"-feature checks (indexed string maxLength <= 63,
// indexed byteArray <= 255, meta-schema, keyword allow-list ...) in the 4.1.1 or 5.0.0-rc.8 WASM:
//
//  A. @dashevo/wasm-dpp (the DPP build WITH validation): `dataContract.create`,
//     `createFromObject(skipValidation:false)` and a full create-transition round trip through
//     `stateTransition.createFromBuffer(skipValidation:false)`.
//       - wasm-dpp 4.1.1  @ protocol 13  (what mainnet runs today)
//       - wasm-dpp 5.0.0-rc.8 @ protocol 13 and 14
//  B. @dashevo/evo-sdk (what the app ships): DataContract ctor with fullValidation=true,
//     toBytes/fromBytes(full) round trip and create-transition build, at the same versions.
//
// Negative controls prove engine A really enforces the PV13 rules. Exit code != 0 on failure.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { saveResult } from './lib.ts';
import { dirname, join } from 'node:path';
import * as evo4 from 'evo4';
import * as evo5 from 'evo5';
import loadDpp4 from 'dpp4';
import loadDpp5 from 'dpp5';

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, '../../../packages/contracts-v1');
const NAMES = ['gov', 'forum', 'badge', 'mod'] as const;
const OWNER_BYTES = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
// DPNS contract id: any valid 32-byte identifier works as a dummy owner for the evo-sdk engine.
const OWNER_B58 = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';

export const errText = (e: unknown): string => {
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; code?: unknown; getMessage?: () => string };
    const m = o.message ?? (typeof o.getMessage === 'function' ? o.getMessage() : String(e));
    return `${m}${o.code !== undefined ? ` [code ${o.code}]` : ''}`;
  }
  return String(e);
};

interface Outcome { ok: boolean; stBytes?: number; docTypes?: number; error?: string }
type Engine = { label: string; version: number; run: (schemas: object) => Promise<Outcome> };

function dppEngine(label: string, mod: any, version: number): Engine {
  return {
    label, version,
    async run(schemas) {
      try {
        const dpp = new mod.DashPlatformProtocol({ generate: () => crypto.getRandomValues(new Uint8Array(32)) }, version);
        const c = dpp.dataContract.create(OWNER_BYTES, 1n, schemas);
        await dpp.dataContract.createFromObject(c.toObject(), { skipValidation: false });
        const st = dpp.dataContract.createDataContractCreateTransition(c);
        const buf: Uint8Array = st.toBuffer();
        await dpp.stateTransition.createFromBuffer(buf, { skipValidation: false });
        return { ok: true, stBytes: buf.length, docTypes: Object.keys(c.getDocumentSchemas()).length };
      } catch (e) {
        return { ok: false, error: errText(e) };
      }
    },
  };
}

function evoEngine(label: string, sdk: typeof evo5, version: number): Engine {
  return {
    label, version,
    async run(schemas) {
      let contract: InstanceType<typeof evo5.DataContract> | undefined;
      let again: InstanceType<typeof evo5.DataContract> | undefined;
      try {
        contract = new sdk.DataContract({ ownerId: OWNER_B58, identityNonce: 1n, schemas, fullValidation: true, platformVersion: version });
        again = sdk.DataContract.fromBytes(contract.toBytes(version), true, version);
        const t = new sdk.DataContractCreateTransition(contract, 1n, version);
        const stBytes = t.toBytes().length;
        t.free();
        return { ok: true, stBytes, docTypes: Object.keys(contract.schemas).length };
      } catch (e) {
        return { ok: false, error: errText(e) };
      } finally {
        try { contract?.free(); } catch { /* ignore */ }
        try { again?.free(); } catch { /* ignore */ }
      }
    },
  };
}

async function main() {
  await evo4.ensureInitialized();
  await evo5.ensureInitialized();
  const dpp4 = await loadDpp4();
  const dpp5 = await loadDpp5();

  const dppEngines = [
    dppEngine('wasm-dpp 4.1.1 @PV13', dpp4, 13),
    dppEngine('wasm-dpp 5.0.0-rc.8 @PV13', dpp5, 13),
    dppEngine('wasm-dpp 5.0.0-rc.8 @PV14', dpp5, 14),
  ];
  const evoEngines = [
    evoEngine('evo-sdk 4.1.1 @PV13', evo4 as unknown as typeof evo5, 13),
    evoEngine('evo-sdk 5.0.0-rc.8 @PV13', evo5, 13),
    evoEngine('evo-sdk 5.0.0-rc.8 @PV14', evo5, 14),
  ];

  let failures = 0;
  const schemasByName: Record<string, Record<string, any>> = {};
  for (const n of NAMES) schemasByName[n] = JSON.parse(readFileSync(join(contractsDir, `${n}.json`), 'utf8'));

  // ---- own lints (the rules in the task brief, independent of any engine) ----
  const lint: string[] = [];
  for (const n of NAMES) {
    for (const [type, def] of Object.entries<any>(schemasByName[n])) {
      const idx = def.indices ?? [];
      if (idx.length > 10) lint.push(`${n}.${type}: ${idx.length} indexes (>10)`);
      if (def.documentsKeepHistory) lint.push(`${n}.${type}: documentsKeepHistory`);
      if (/-/.test(type)) lint.push(`${n}.${type}: '-' in type name`);
      const txt = JSON.stringify(def);
      for (const kw of ['refersTo', 'distinctFrom', 'ttl', 'rankedCountable', 'countable', 'rangeCountable', 'indexOnly', 'propertyConstraints', 'maxBytes']) {
        if (txt.includes(`"${kw}"`)) lint.push(`${n}.${type}: PV14-only keyword ${kw}`);
      }
      const props = def.properties as Record<string, any>;
      for (const [pn, p] of Object.entries<any>(props)) {
        if (pn.includes('-')) lint.push(`${n}.${type}.${pn}: '-' in property name`);
        if (p.type === 'array' && !p.byteArray) lint.push(`${n}.${type}.${pn}: typed array`);
        if (p.maxItems > 5120 || p.maxLength > 5120) lint.push(`${n}.${type}.${pn}: field limit >5120`);
      }
      const positions = Object.values<any>(props).map((p) => p.position).sort((a, b) => a - b);
      if (positions.some((p, i) => p !== i)) lint.push(`${n}.${type}: positions not contiguous ${positions}`);
      for (const ix of idx) {
        for (const part of ix.properties) {
          const [name] = Object.keys(part);
          if (name.startsWith('$')) {
            if (['$createdAt', '$updatedAt'].includes(name) && !def.required?.includes(name)) lint.push(`${n}.${type}.${ix.name}: ${name} indexed but not required`);
            continue;
          }
          const p = props[name];
          if (!p) { lint.push(`${n}.${type}.${ix.name}: unknown property ${name}`); continue; }
          if (p.type === 'string' && !(p.maxLength <= 63)) lint.push(`${n}.${type}.${ix.name}.${name}: indexed string maxLength ${p.maxLength}`);
          if (p.byteArray && !(p.maxItems <= 255)) lint.push(`${n}.${type}.${ix.name}.${name}: indexed byteArray maxItems ${p.maxItems}`);
          if (!def.required?.includes(name)) lint.push(`${n}.${type}.${ix.name}.${name}: indexed property is optional`);
        }
      }
    }
  }
  console.log(lint.length ? `LINT FAILURES:\n  ${lint.join('\n  ')}` : 'lint: ok (<=10 indexes, indexed string<=63 / byteArray<=255, field<=5120, no PV14 keywords, positions contiguous, no "-", indexed props required)');
  failures += lint.length;

  // ---- real validation ----
  console.log('\nContract validation:');
  const rows: string[] = [];
  for (const n of NAMES) {
    const cells: string[] = [];
    for (const e of [...dppEngines, ...evoEngines]) {
      const r = await e.run(schemasByName[n]);
      if (!r.ok) failures++;
      const cell = r.ok ? `PASS (${r.docTypes} types, create-ST ${r.stBytes} B)` : `FAIL: ${r.error}`;
      cells.push(r.ok ? `PASS (${r.stBytes} B)` : 'FAIL');
      console.log(`  ${n.padEnd(6)} ${e.label.padEnd(28)} ${cell}`);
    }
    rows.push(`| ${n} | ${cells.join(' | ')} |`);
  }

  // ---- negative controls (engine A must reject these at PV13) ----
  console.log('\nNegative controls (wasm-dpp engines; expectation in brackets):');
  const clone = () => JSON.parse(JSON.stringify(schemasByName.forum));
  const variant = (mut: (c: any) => void) => { const c = clone(); mut(c); return c; };
  const controls: { label: string; schemas: object; expect13: 'reject' | 'accept'; expect14: 'reject' | 'accept'; rc8At13?: 'reject' | 'accept' }[] = [
    { label: 'indexed string maxLength 100', schemas: variant((c) => { c.profile.properties.displayName.maxLength = 100; c.profile.indices.push({ name: 'x', properties: [{ displayName: 'asc' }] }); }), expect13: 'reject', expect14: 'reject' },
    { label: 'indexed byteArray maxItems 300', schemas: variant((c) => { c.reaction.properties.target.maxItems = 300; }), expect13: 'reject', expect14: 'reject' },
    { label: '11 indexes', schemas: variant((c) => { for (let i = 0; i < 9; i++) c.comment.properties[`n${i}`] = { type: 'integer', minimum: 0, maximum: 9, position: 4 + i }; c.comment.required.push(...Array.from({ length: 9 }, (_, i) => `n${i}`)); for (let i = 0; i < 9; i++) c.comment.indices.push({ name: `n${i}`, properties: [{ [`n${i}`]: 'asc' }] }); }), expect13: 'reject', expect14: 'reject' },
    { label: 'refersTo keyword', schemas: variant((c) => { c.comment.properties.parentId.refersTo = { type: 'identity' }; }), expect13: 'reject', expect14: 'accept' },
    { label: 'typed array', schemas: variant((c) => { c.blockSubs.properties.lists = { type: 'array', items: { type: 'integer' }, maxItems: 3, position: 0 }; }), expect13: 'reject', expect14: 'accept' },
    // QUIRK: wasm-dpp rc.8 `createFromObject` re-validates with the PV14 meta-schema even when constructed for PV13,
    // while `create` and the transition path honour 13. (evo-sdk does not run the meta-schema at all.)
    { label: '"-" in property name', schemas: variant((c) => { c.profile.properties['display-name'] = { type: 'string', maxLength: 5, position: 3 }; }), expect13: 'accept', expect14: 'reject', rc8At13: 'reject' },
    { label: 'unknown keyword on a type', schemas: variant((c) => { c.profile.foo = 1; }), expect13: 'reject', expect14: 'reject' },
  ];
  for (const ctl of controls) {
    const outs = await Promise.all(dppEngines.map(async (e) => ({ e, r: await e.run(ctl.schemas) })));
    const verdicts = outs.map(({ e, r }) => {
      const want = e.version === 14 ? ctl.expect14 : e.label.includes('rc.8') && ctl.rc8At13 ? ctl.rc8At13 : ctl.expect13;
      const got = r.ok ? 'accept' : 'reject';
      if (got !== want) failures++;
      return `${e.label.replace('wasm-dpp ', '')}=${got}${got === want ? '' : ' (UNEXPECTED, wanted ' + want + ')'}`;
    });
    console.log(`  ${ctl.label.padEnd(32)} ${verdicts.join('   ')}`);
    for (const { e, r } of outs) if (!r.ok) console.log(`      ${e.label}: ${r.error?.slice(0, 150)}`);
  }

  // Yappr's published vault shape is PV14-style; show how each engine treats it.
  try {
    const yappr = JSON.parse(readFileSync(join(here, 'fixtures/yappr-passkey-vault-contract.json'), 'utf8'));
    console.log('\nYappr passkey vault contract as published (reference, expected to need PV13 edits):');
    for (const e of [...dppEngines, ...evoEngines]) {
      const r = await e.run(yappr);
      console.log(`  ${e.label.padEnd(28)} ${r.ok ? 'accepted' : `rejected: ${r.error?.slice(0, 160)}`}`);
    }
  } catch { /* fixture optional */ }

  saveResult('validate-contracts.json', { at: new Date().toISOString(), engines: [...dppEngines, ...evoEngines].map((e) => e.label), rows, failures });
  console.log('\nTable rows: | contract | wasm-dpp 4.1.1 PV13 | wasm-dpp rc.8 PV13 | wasm-dpp rc.8 PV14 | evo-sdk 4.1.1 PV13 | evo-sdk rc.8 PV13 | evo-sdk rc.8 PV14 |\n' + rows.join('\n'));
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CONTRACTS VALID ON ALL TARGETS; ALL NEGATIVE CONTROLS BEHAVED AS EXPECTED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(errText(e)); process.exit(2); });
