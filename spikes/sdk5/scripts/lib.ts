// Shared helpers for the sdk5 spike scripts. No key material is ever printed from here.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const contractsDir = join(here, '../../../packages/contracts-v1');
export const resultsDir = join(here, '../results');

/** WASM SDK errors are not Error instances: they carry `.message` and `.code`. */
export function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; code?: unknown };
    const m = o.message !== undefined ? String(o.message) : String(e);
    return o.code !== undefined && o.code !== -1 ? `${m} [code ${String(o.code)}]` : m;
  }
  return String(e);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t) };
}

/** JSON-safe rendering of SDK values (bigint, bytes, objects with toJSON/toString). */
export function plain(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (depth > 6) return '[deep]';
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), plain(x, depth + 1)]));
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  const o = v as { toJSON?: () => unknown };
  if (typeof o.toJSON === 'function') {
    try { return plain(o.toJSON(), depth + 1); } catch { /* fall through */ }
  }
  if (typeof (v as { toString?: unknown }).toString === 'function' && (v as object).constructor !== Object) {
    const s = String(v);
    if (s !== '[object Object]') return s;
  }
  return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, plain(x, depth + 1)]));
}

export function saveResult(name: string, data: unknown): string {
  mkdirSync(resultsDir, { recursive: true });
  const p = join(resultsDir, name);
  writeFileSync(p, JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  return p;
}

/** Poll-index values arrive as bincode-serialised platform Values: 0x12 text tag, length byte, UTF-8. */
export function decodeIndexValue(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  let bytes: Uint8Array | undefined;
  if (raw instanceof Uint8Array) bytes = raw;
  else if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) bytes = Uint8Array.from(raw as number[]);
  if (!bytes || bytes.length < 2 || bytes[0] !== 0x12 || bytes[1] !== bytes.length - 2) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(2)); } catch { return undefined; }
}

export const DPNS_CONTRACT_ID = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';
export const DPNS_POLL = { dataContractId: DPNS_CONTRACT_ID, documentTypeName: 'domain', indexName: 'parentNameAndLabel' } as const;

export const CREDITS_PER_DASH = 100_000_000_000n; // 1 DASH = 1e8 duffs = 1e11 credits
export const dash = (credits: bigint | number): string => {
  const c = BigInt(credits);
  const neg = c < 0n;
  const a = neg ? -c : c;
  const whole = a / CREDITS_PER_DASH;
  const frac = (a % CREDITS_PER_DASH).toString().padStart(11, '0').slice(0, 8);
  return `${neg ? '-' : ''}${whole}.${frac}`;
};
