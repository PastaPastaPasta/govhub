// Masternode registration facts shipped with the build (dist/verify/registrations-<network>.bin, scripts/registrations.mjs).
//
// A masternode's type and collateral are set by its ProRegTx and never change (@govhub/dapi protx.ts). On a first visit the browser
// fetched one ProRegTx per masternode it needed (about 1,000 for the funding threshold's older list entries, and the voters of each
// recount: most of the ~3,000), each proven by hashing to its proTxHash: the largest part of a cold check. The build now does that
// same fetch-and-hash once and ships the facts. They are part of the build, served from the app's own origin like its code, so they
// add no trust the code doesn't already carry (docs/TRUST.md). Entries the table lacks (masternodes registered after the build) are
// fetched and proven in the browser as before.
//
// Format (big-endian): "GOVREG1\n" | network u8 (0 mainnet, 1 testnet) | list height u32 | count u32 | count x 69-byte records:
// proTxHash (32, display order) | type u8 | collateral txid (32, display order) | collateral index u32.
import type { ProRegCache, ProRegInfo } from '@govhub/dapi';

const MAGIC = new TextEncoder().encode('GOVREG1\n');
const HEAD = MAGIC.length + 1 + 4 + 4;
const RECORD = 32 + 1 + 32 + 4;
const NETWORKS = ['mainnet', 'testnet'] as const;
export type RegNetwork = (typeof NETWORKS)[number];

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function unhex(s: string, into: Uint8Array, at: number) {
  for (let i = 0; i < 32; i++) into[at + i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
}

export function encodeRegistrations(network: RegNetwork, height: number, entries: ReadonlyMap<string, ProRegInfo>): Uint8Array {
  const rows = [...entries].filter(([h, v]) => /^[0-9a-f]{64}$/.test(h) && /^[0-9a-f]{64}$/.test(v.collateral.txid)).sort(([a], [b]) => (a < b ? -1 : 1));
  const out = new Uint8Array(HEAD + rows.length * RECORD);
  const dv = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[MAGIC.length] = NETWORKS.indexOf(network);
  dv.setUint32(MAGIC.length + 1, height);
  dv.setUint32(MAGIC.length + 5, rows.length);
  rows.forEach(([h, v], i) => {
    const at = HEAD + i * RECORD;
    unhex(h, out, at);
    out[at + 32] = v.type;
    unhex(v.collateral.txid, out, at + 33);
    dv.setUint32(at + 65, v.collateral.index);
  });
  return out;
}

/** The table's facts by proTxHash, or null when the bytes are not a table for `network`. */
export function decodeRegistrations(bytes: Uint8Array, network: RegNetwork): { height: number; entries: Map<string, ProRegInfo> } | null {
  if (bytes.length < HEAD || !MAGIC.every((b, i) => bytes[i] === b) || bytes[MAGIC.length] !== NETWORKS.indexOf(network)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(MAGIC.length + 5);
  if (bytes.length !== HEAD + count * RECORD) return null;
  const entries = new Map<string, ProRegInfo>();
  for (let i = 0; i < count; i++) {
    const at = HEAD + i * RECORD;
    entries.set(hex(bytes.subarray(at, at + 32)), { type: bytes[at + 32]!, collateral: { txid: hex(bytes.subarray(at + 33, at + 65)), index: dv.getUint32(at + 65) } });
  }
  return { height: dv.getUint32(MAGIC.length + 1), entries };
}

/** The table shipped with this build for `network` (empty when there is none: an offline build, or Testnet). Fetched once. */
const tables = new Map<RegNetwork, Promise<Map<string, ProRegInfo>>>();
export function shippedRegistrations(network: RegNetwork, get: (url: string) => Promise<Response> = (u) => fetch(u, { credentials: 'omit' })): Promise<Map<string, ProRegInfo>> {
  let t = tables.get(network);
  if (!t) {
    const base = (import.meta.env?.BASE_URL as string | undefined) ?? '/';
    t = get(`${base.replace(/\/?$/, '/')}verify/registrations-${network}.bin`)
      .then(async (r) => (r.ok ? (decodeRegistrations(new Uint8Array(await r.arrayBuffer()), network)?.entries ?? new Map()) : new Map()))
      .catch(() => new Map<string, ProRegInfo>());
    tables.set(network, t);
  }
  return t;
}

/** A ProRegTx cache that answers from the build's table first, then from `inner` (this browser's own proofs). */
export function withShippedRegistrations(network: string, inner: ProRegCache, table: () => Promise<Map<string, ProRegInfo>> = () => (network === 'mainnet' || network === 'testnet' ? shippedRegistrations(network) : Promise.resolve(new Map()))): ProRegCache {
  return {
    async load(hashes) {
      const shipped = await table();
      const out = new Map<string, ProRegInfo>();
      const rest: string[] = [];
      for (const h of hashes) {
        const v = shipped.get(h);
        if (v) out.set(h, v);
        else rest.push(h);
      }
      if (rest.length) for (const [k, v] of await inner.load(rest)) out.set(k, v);
      return out;
    },
    save: (entries) => inner.save(entries),
  };
}
