// Endpoint registry (PLAN §1.1): every backend is replaceable by the user. Persisted in
// localStorage, exportable/importable as JSON, loadable from `?config=` (base64url JSON or an
// https URL to a JSON file). Core and Platform networks are separate settings because phase 1
// reads mainnet Core data but publishes into a testnet contract; production uses one network.
import type { CoreNetwork } from '../data/types.ts';

export interface BridgeEndpoint {
  name: string;
  /** Base URL of the bridge HTTP API, e.g. https://bridge.example.org (no trailing slash). */
  httpBase: string;
  govContractId: string;
  bridgeIdentityId: string;
  enabled: boolean;
}

export interface NamedUrl {
  name: string;
  url: string;
}

export interface Registry {
  version: 1;
  coreNetwork: CoreNetwork;
  platformNetwork: CoreNetwork;
  /** Core-side DAPI (grpc-web on evonodes) for collateral and SML checks, on `coreNetwork`. */
  dapi: { source: 'quorum' | 'manual'; quorumUrl: string; nodes: string[] };
  /** evo-sdk connection for Platform reads, on `platformNetwork`. Empty addresses = SDK defaults. */
  platform: { trusted: boolean; addresses: string[] };
  /** The `gov` contract to read proposals, tallies and cycles from. */
  govContractId: string;
  bridges: BridgeEndpoint[];
  relays: NamedUrl[];
  priceFeed: NamedUrl | null;
  /** The `forum` contract (comments, reactions, the passkey `vault`), on `platformNetwork`. */
  forumContractId: string;
  /** Central login (accounts service, PLAN 4.2). Not built yet: the interface is in @govhub/auth `central.ts`. */
  accounts: NamedUrl | null;
  /** Starter-voucher faucet (PLAN 4.3). Vouchers are pasted as links; the app never calls the mainnet invitation endpoint itself. */
  faucet: NamedUrl | null;
}

export const QUORUM_SERVICE: Record<CoreNetwork, string> = {
  mainnet: 'https://quorums.mainnet.networks.dash.org/masternodes',
  testnet: 'https://quorums.testnet.networks.dash.org/masternodes',
};

/** Testnet `gov` contract from phase 0 (owner = the bridge identity). */
export const TESTNET_GOV_CONTRACT = '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ';
export const TESTNET_BRIDGE_IDENTITY = '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv';
/** Testnet `forum` contract from phase 0 (holds `vault`). */
export const TESTNET_FORUM_CONTRACT = 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw';
export const DEFAULT_FAUCET: NamedUrl = { name: 'faucet.dashhq.org', url: 'https://faucet.dashhq.org' };

function envBridges(): BridgeEndpoint[] {
  const url = import.meta.env?.VITE_GOVHUB_BRIDGE_URL as string | undefined;
  if (!url) return [];
  return [{ name: 'govhub bridge', httpBase: url.replace(/\/+$/, ''), govContractId: TESTNET_GOV_CONTRACT, bridgeIdentityId: TESTNET_BRIDGE_IDENTITY, enabled: true }];
}

export function defaultRegistry(): Registry {
  return {
    version: 1,
    coreNetwork: 'mainnet',
    platformNetwork: 'testnet',
    dapi: { source: 'quorum', quorumUrl: QUORUM_SERVICE.mainnet, nodes: [] },
    platform: { trusted: true, addresses: [] },
    govContractId: TESTNET_GOV_CONTRACT,
    bridges: envBridges(),
    relays: [],
    priceFeed: { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=dash&vs_currencies=usd' },
    forumContractId: TESTNET_FORUM_CONTRACT,
    accounts: null,
    faucet: DEFAULT_FAUCET,
  };
}

const STORAGE_KEY = 'govhub.registry.v1';
const B58_ID = /^[1-9A-HJ-NP-Za-km-z]{42,44}$/;
const HOST_PORT = /^[a-zA-Z0-9.-]+:\d{1,5}$/;

function httpsUrl(s: unknown, field: string, errors: string[], allowEmpty = false): string {
  if (allowEmpty && s === '') return '';
  if (typeof s !== 'string') {
    errors.push(`${field} must be a string`);
    return '';
  }
  try {
    const u = new URL(s);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) errors.push(`${field} must be an https URL`);
  } catch {
    errors.push(`${field} is not a URL`);
  }
  return s.replace(/\/+$/, '');
}

const network = (v: unknown, field: string, errors: string[]): CoreNetwork => {
  if (v === 'mainnet' || v === 'testnet') return v;
  errors.push(`${field} must be "mainnet" or "testnet"`);
  return 'mainnet';
};

/** Validates untrusted JSON into a Registry. Unknown keys are dropped. */
export function parseRegistry(input: unknown): { registry: Registry; errors: string[] } {
  const errors: string[] = [];
  const d = defaultRegistry();
  if (!input || typeof input !== 'object') return { registry: d, errors: ['settings must be a JSON object'] };
  const o = input as Record<string, unknown>;
  if (o.version !== 1) errors.push('version must be 1');
  const dapi = (o.dapi ?? {}) as Record<string, unknown>;
  const platform = (o.platform ?? {}) as Record<string, unknown>;
  const nodes = Array.isArray(dapi.nodes) ? dapi.nodes.filter((n): n is string => typeof n === 'string') : [];
  for (const n of nodes) if (!HOST_PORT.test(n)) errors.push(`DAPI node "${n}" must be host:port`);
  const addresses = Array.isArray(platform.addresses) ? platform.addresses.filter((n): n is string => typeof n === 'string') : [];
  for (const a of addresses) httpsUrl(a, `Platform address ${a}`, errors);
  const govContractId = typeof o.govContractId === 'string' ? o.govContractId : '';
  if (!B58_ID.test(govContractId)) errors.push('govContractId must be a base58 identifier');
  const bridges: BridgeEndpoint[] = (Array.isArray(o.bridges) ? o.bridges : []).map((b: unknown, i: number) => {
    const x = (b ?? {}) as Record<string, unknown>;
    const govId = typeof x.govContractId === 'string' ? x.govContractId : '';
    const idId = typeof x.bridgeIdentityId === 'string' ? x.bridgeIdentityId : '';
    if (govId && !B58_ID.test(govId)) errors.push(`bridge ${i + 1}: govContractId must be base58`);
    if (idId && !B58_ID.test(idId)) errors.push(`bridge ${i + 1}: bridgeIdentityId must be base58`);
    return {
      name: typeof x.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 60) : `bridge ${i + 1}`,
      httpBase: httpsUrl(x.httpBase, `bridge ${i + 1} URL`, errors),
      govContractId: govId,
      bridgeIdentityId: idId,
      enabled: x.enabled !== false,
    };
  });
  const named = (v: unknown, what: string): NamedUrl[] =>
    (Array.isArray(v) ? v : []).map((r: unknown, i: number) => {
      const x = (r ?? {}) as Record<string, unknown>;
      return { name: typeof x.name === 'string' && x.name ? x.name.slice(0, 60) : `${what} ${i + 1}`, url: httpsUrl(x.url, `${what} ${i + 1} URL`, errors) };
    });
  const pf = o.priceFeed as Record<string, unknown> | null | undefined;
  // Fields added in phase 2: absent in older saved settings, so they default instead of failing.
  const forumContractId = o.forumContractId === undefined ? d.forumContractId : typeof o.forumContractId === 'string' ? o.forumContractId : '';
  if (!B58_ID.test(forumContractId)) errors.push('forumContractId must be a base58 identifier');
  const optionalNamed = (v: unknown, fallback: NamedUrl | null, what: string): NamedUrl | null => {
    if (v === undefined) return fallback;
    if (!v || typeof v !== 'object') return null;
    const x = v as Record<string, unknown>;
    return { name: typeof x.name === 'string' && x.name ? x.name.slice(0, 60) : what, url: httpsUrl(x.url, `${what} URL`, errors) };
  };
  const registry: Registry = {
    version: 1,
    coreNetwork: network(o.coreNetwork, 'coreNetwork', errors),
    platformNetwork: network(o.platformNetwork, 'platformNetwork', errors),
    dapi: {
      source: dapi.source === 'manual' ? 'manual' : 'quorum',
      quorumUrl: httpsUrl(dapi.quorumUrl ?? d.dapi.quorumUrl, 'DAPI quorum service URL', errors),
      nodes,
    },
    platform: { trusted: platform.trusted !== false, addresses },
    govContractId,
    bridges,
    relays: named(o.relays, 'relay'),
    priceFeed: pf && typeof pf === 'object' ? { name: typeof pf.name === 'string' ? pf.name : 'price feed', url: httpsUrl(pf.url, 'price feed URL', errors) } : null,
    forumContractId,
    accounts: optionalNamed(o.accounts, d.accounts, 'accounts service'),
    faucet: optionalNamed(o.faucet, d.faucet, 'faucet'),
  };
  if (registry.dapi.source === 'manual' && nodes.length === 0) errors.push('manual DAPI source needs at least one node');
  return { registry, errors };
}

export function loadRegistry(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Registry {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return defaultRegistry();
    const { registry, errors } = parseRegistry(JSON.parse(raw));
    return errors.length ? defaultRegistry() : registry;
  } catch {
    return defaultRegistry();
  }
}

export function saveRegistry(r: Registry, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  storage?.setItem(STORAGE_KEY, JSON.stringify(r));
}

export function resetRegistry(storage: Pick<Storage, 'removeItem'> | undefined = globalThis.localStorage): Registry {
  storage?.removeItem(STORAGE_KEY);
  return defaultRegistry();
}

export const exportRegistry = (r: Registry): string => JSON.stringify(r, null, 2);

function b64urlToText(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

export function textToB64url(s: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Share link for a registry: the current origin + `?config=<base64url JSON>`. */
export function shareLink(r: Registry, origin: string): string {
  return `${origin}/?config=${textToB64url(JSON.stringify(r))}`;
}

/**
 * Resolves a `?config=` value: an https URL to fetch, or base64url JSON. The result is NOT applied:
 * the UI asks the user first, because a link could point them at a lying bridge.
 */
export async function resolveConfigParam(value: string, fetcher: typeof fetch = fetch): Promise<{ registry: Registry; errors: string[] }> {
  let json: unknown;
  try {
    if (/^https:\/\//.test(value)) {
      const res = await fetcher(value, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) return { registry: defaultRegistry(), errors: [`config URL answered HTTP ${res.status}`] };
      json = await res.json();
    } else {
      json = JSON.parse(b64urlToText(value));
    }
  } catch (e) {
    return { registry: defaultRegistry(), errors: [`config could not be read: ${(e as Error).message}`] };
  }
  return parseRegistry(json);
}

export const enabledBridges = (r: Registry): BridgeEndpoint[] => r.bridges.filter((b) => b.enabled && b.httpBase);
