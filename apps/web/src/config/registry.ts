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

/** Social layer endpoints (PLAN §3.1 `forum` and `mod`, §9 moderation). */
export interface ForumEndpoints {
  /** the open `forum` contract: comments, reactions, claims, posts, user block lists */
  contractId: string;
  /** the `mod` contract that holds the default block list */
  modContractId: string;
  /** owner of the default list (only it can write `mod.block`) */
  moderationIdentityId: string;
  /** shown as the default list's name */
  moderationName: string;
  /** hosts accepted for URL-embedded claims, https://<portal>/p/<identityId>/<name> */
  claimPortals: string[];
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
  forum: ForumEndpoints;
}

export const QUORUM_SERVICE: Record<CoreNetwork, string> = {
  mainnet: 'https://quorums.mainnet.networks.dash.org/masternodes',
  testnet: 'https://quorums.testnet.networks.dash.org/masternodes',
};

/** Testnet `gov` contract from phase 0 (owner = the bridge identity). */
export const TESTNET_GOV_CONTRACT = '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ';
export const TESTNET_BRIDGE_IDENTITY = '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv';

/**
 * Testnet `forum` and `mod` contracts from phase 0. The moderation identity on testnet is the phase-0 spike owner
 * (the `mod` contract's owner, the only identity that can create `mod.block`); mainnet uses a separate key.
 */
export const TESTNET_FORUM: ForumEndpoints = {
  contractId: 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw',
  modContractId: 'CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY',
  moderationIdentityId: TESTNET_BRIDGE_IDENTITY,
  moderationName: 'govhub moderation',
  claimPortals: ['gov.dashhq.org'],
};

/**
 * Identities whose `claimAttestation` documents count (PLAN §6.3 method 4): the hosting team, i.e. the owner of the
 * gov contract in use. The contract restricts creation to its owner; this list is the reader's own check.
 */
export function attestorsFor(r: Registry): string[] {
  const ids = r.bridges.filter((b) => b.govContractId === r.govContractId && b.bridgeIdentityId).map((b) => b.bridgeIdentityId);
  if (r.govContractId === TESTNET_GOV_CONTRACT) ids.push(TESTNET_BRIDGE_IDENTITY);
  return [...new Set(ids)];
}

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
    forum: { ...TESTNET_FORUM, claimPortals: [...TESTNET_FORUM.claimPortals] },
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

const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

/** Settings saved before the social layer existed have no `forum` section: they get the defaults. */
function parseForum(v: unknown, d: ForumEndpoints, errors: string[]): ForumEndpoints {
  if (v === undefined) return d;
  const x = (v ?? {}) as Record<string, unknown>;
  const id = (k: 'contractId' | 'modContractId' | 'moderationIdentityId'): string => {
    const s = typeof x[k] === 'string' ? (x[k] as string) : '';
    if (!B58_ID.test(s)) errors.push(`forum.${k} must be a base58 identifier`);
    return s;
  };
  const portals = Array.isArray(x.claimPortals) ? x.claimPortals.filter((p): p is string => typeof p === 'string') : d.claimPortals;
  for (const p of portals) if (!HOST.test(p)) errors.push(`claim portal "${p}" must be a host name`);
  return {
    contractId: id('contractId'),
    modContractId: id('modContractId'),
    moderationIdentityId: id('moderationIdentityId'),
    moderationName: typeof x.moderationName === 'string' && x.moderationName.trim() ? x.moderationName.trim().slice(0, 60) : d.moderationName,
    claimPortals: portals.map((p) => p.toLowerCase()),
  };
}

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
    forum: parseForum(o.forum, d.forum, errors),
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
