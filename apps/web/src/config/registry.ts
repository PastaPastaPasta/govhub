// Endpoint registry (PLAN §1.1): every backend is replaceable by the user. Persisted in
// localStorage, exportable/importable as JSON, loadable from `?config=` (base64url JSON or an
// https URL to a JSON file).
//
// Settings start from a network PROFILE (Testnet, Dev, Mainnet): one coherent set of Core network, Platform network,
// `gov` contract, bridge, DAPI node source and forum contracts. Any field can still be overridden ("custom") under
// Advanced, but switching profile is one action and never mixes one network's data with another's parameters.
import type { CoreNetwork } from '../data/types.ts';

/**
 * The testnet `gov` contract (Core testnet proposals published on testnet Platform), owned by the testnet bridge identity.
 * Registered 2026-10-24 by the R730 testnet stack (deploy/README.md section 13.1). While empty, the Testnet profile shows
 * "Testnet backend is being set up" and reads nothing.
 */
export const TESTNET_GOV_CONTRACT_ID = '5gMnJLDpcoMaQCQNqmHtBiSqCxRCmroXFAffPNdJ2NJC';
/** The testnet bridge's identity (the owner of TESTNET_GOV_CONTRACT_ID): its claim attestations count. Optional; empty = none. */
export const TESTNET_BRIDGE_IDENTITY_ID = '24tL6v5jMR1H9dtUoTgbedePsMJtYPk4Q4bo6h8jTdK9';
/** The testnet relay (services/relay; deploy/README.md 11.4): masternode votes on Core testnet go through it. */
export const TESTNET_RELAY: NamedUrl = { name: 'gov-relay-testnet.dashhq.org', url: 'https://gov-relay-testnet.dashhq.org' };
/** The mainnet relay: masternode votes on Core mainnet (the Dev profile today, Mainnet later) go through it. */
export const MAINNET_RELAY: NamedUrl = { name: 'gov-relay.dashhq.org', url: 'https://gov-relay.dashhq.org' };

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

/**
 * A source of DIP 175 quorum proofs (Dash Core v24 `getquorumproofchain`): a bridge's `/v1/quorum-proof`, or a quorum list server's
 * `/proofs`. Untrusted: a proof authenticates itself from the checkpoint pinned in the app, so a source can only withhold.
 */
export interface ProofSourceEndpoint extends NamedUrl {
  kind: 'bridge' | 'quorum-list';
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

export type ProfileId = 'testnet' | 'dev' | 'mainnet';

export interface Registry {
  version: 2;
  /** The profile these settings start from; fields that differ from it are "custom" overrides. */
  profile: ProfileId;
  coreNetwork: CoreNetwork;
  platformNetwork: CoreNetwork;
  /** Core-side DAPI (grpc-web on evonodes) for collateral and SML checks, on `coreNetwork`. */
  dapi: { source: 'quorum' | 'manual'; quorumUrl: string; nodes: string[] };
  /** evo-sdk connection for Platform reads, on `platformNetwork`. Empty addresses = SDK defaults. */
  platform: { trusted: boolean; addresses: string[] };
  /** The `gov` contract to read proposals, tallies and cycles from. Empty: no backend for this profile yet (nothing is read). */
  govContractId: string;
  bridges: BridgeEndpoint[];
  relays: NamedUrl[];
  /** Quorum proof sources, tried in order: chain facts anchor on ChainLocks proven from the pinned quorum checkpoint (no proof of work).
   *  When none answers with a valid proof (none listed, dashd older than v24), the app falls back to proof of work and says so. */
  quorumProofs: ProofSourceEndpoint[];
  priceFeed: NamedUrl | null;
  /** Central login (accounts service, PLAN 4.2). Not built yet: the interface is in @govhub/auth `central.ts`. */
  accounts: NamedUrl | null;
  /** Starter-voucher faucet (PLAN 4.3). Vouchers are pasted as links; the app never calls the mainnet invitation endpoint itself. */
  faucet: NamedUrl | null;
  forum: ForumEndpoints;
}

export const QUORUM_SERVICE: Record<CoreNetwork, string> = {
  mainnet: 'https://quorums.mainnet.networks.dash.org/masternodes',
  testnet: 'https://quorums.testnet.networks.dash.org/masternodes',
};

/** The public quorum list servers' proof relays (dashpay/quorum-list-server #15). Testnet serves proofs; mainnet answered 403 (2026-10-24). */
export const QUORUM_PROOF_SERVICE: Record<CoreNetwork, ProofSourceEndpoint> = {
  mainnet: { name: 'quorums.mainnet.networks.dash.org', url: 'https://quorums.mainnet.networks.dash.org/proofs', kind: 'quorum-list' },
  testnet: { name: 'quorums.testnet.networks.dash.org', url: 'https://quorums.testnet.networks.dash.org/proofs', kind: 'quorum-list' },
};

/** Dev profile `gov` contract: MAINNET Core proposals published on testnet Platform (phase 0/1; owner = the Dev bridge identity). */
export const DEV_GOV_CONTRACT_ID = '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ';
export const DEV_BRIDGE_IDENTITY_ID = '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv';
export const DEFAULT_FAUCET: NamedUrl = { name: 'faucet.dashhq.org', url: 'https://faucet.dashhq.org' };

/**
 * Testnet `forum` and `mod` contracts from phase 0, shared by the Testnet and Dev profiles (their documents are keyed by govHash,
 * so the two profiles' proposals never collide). The moderation identity is the phase-0 spike owner (the `mod` contract's owner,
 * the only identity that can create `mod.block`); mainnet uses a separate key.
 */
export const TESTNET_FORUM: ForumEndpoints = {
  contractId: 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw',
  modContractId: 'CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY',
  moderationIdentityId: DEV_BRIDGE_IDENTITY_ID,
  moderationName: 'govhub moderation',
  claimPortals: ['gov.dashhq.org'],
};

export interface NetworkProfile {
  id: ProfileId;
  /** Short label (segmented control, mobile header). */
  label: string;
  /** What the header shows. */
  title: string;
  /** One line for Settings. */
  description: string;
  coreNetwork: CoreNetwork;
  platformNetwork: CoreNetwork;
  govContractId: string;
  /** The profile's bridge, publishing into `govContractId`. */
  bridge: { url: string; identityId: string } | null;
  /** Relays for masternode votes on this profile's Core network (votes never cross networks). */
  relays: NamedUrl[];
  /** Bridges whose dashd serves quorum proofs for this profile's Core network (before the public quorum list server). */
  proofBridges: string[];
  forum: ForumEndpoints | null;
  /** Not deployed: shown, but cannot be selected. */
  deployed: boolean;
}

export const PROFILES: Record<ProfileId, NetworkProfile> = {
  testnet: {
    id: 'testnet',
    label: 'Testnet',
    title: 'Testnet',
    description: 'Core testnet governance (proposals, votes, superblocks every 24 blocks) published on testnet Platform.',
    coreNetwork: 'testnet',
    platformNetwork: 'testnet',
    govContractId: TESTNET_GOV_CONTRACT_ID,
    bridge: { url: 'https://gov-bridge-testnet.dashhq.org', identityId: TESTNET_BRIDGE_IDENTITY_ID },
    relays: [TESTNET_RELAY],
    proofBridges: ['https://gov-bridge-testnet.dashhq.org'],
    forum: TESTNET_FORUM,
    deployed: true,
  },
  dev: {
    id: 'dev',
    label: 'Dev',
    title: 'Dev: mainnet data on testnet Platform',
    description: 'Mainnet governance (real Core mainnet proposals, votes and superblocks) published on testnet Platform, for development.',
    coreNetwork: 'mainnet',
    platformNetwork: 'testnet',
    govContractId: DEV_GOV_CONTRACT_ID,
    bridge: { url: 'https://gov-bridge.dashhq.org', identityId: DEV_BRIDGE_IDENTITY_ID },
    relays: [MAINNET_RELAY],
    // its dashd (23.1.8) has no getquorumproofchain yet: it answers 501 and chain facts use proof of work until it runs v24
    proofBridges: ['https://gov-bridge.dashhq.org'],
    forum: TESTNET_FORUM,
    deployed: true,
  },
  mainnet: {
    id: 'mainnet',
    label: 'Mainnet',
    title: 'Mainnet',
    description: 'Core mainnet governance on mainnet Platform. Not yet deployed.',
    coreNetwork: 'mainnet',
    platformNetwork: 'mainnet',
    govContractId: '',
    bridge: null,
    relays: [],
    proofBridges: [],
    forum: null,
    deployed: false,
  },
};

export const PROFILE_ORDER: readonly ProfileId[] = ['testnet', 'dev', 'mainnet'];

/** The profile the app starts on. */
export const DEFAULT_PROFILE: ProfileId = 'dev';

const isProfileId = (v: unknown): v is ProfileId => typeof v === 'string' && Object.hasOwn(PROFILES, v);

/** Why a profile has nothing to read yet (no `gov` contract), or null when it has one. Never answered with another network's data. */
export function backendNotice(r: Pick<Registry, 'profile' | 'govContractId'>): string | null {
  if (r.govContractId) return null;
  return r.profile === 'testnet' ? 'Testnet backend is being set up' : 'No governance contract is configured';
}

/**
 * Identities whose `claimAttestation` documents count (PLAN §6.3 method 4): the hosting team, i.e. the owner of the
 * gov contract in use. The contract restricts creation to its owner; this list is the reader's own check.
 */
export function attestorsFor(r: Registry): string[] {
  const ids = r.bridges.filter((b) => b.govContractId === r.govContractId && b.bridgeIdentityId).map((b) => b.bridgeIdentityId);
  for (const p of Object.values(PROFILES)) if (p.govContractId && p.govContractId === r.govContractId && p.bridge?.identityId) ids.push(p.bridge.identityId);
  return [...new Set(ids)];
}

/** VITE_GOVHUB_BRIDGE_URL replaces the Dev profile's bridge for a build; empty or `none` builds with no bridge. */
function profileBridges(p: NetworkProfile): BridgeEndpoint[] {
  const env = p.id === 'dev' ? (import.meta.env?.VITE_GOVHUB_BRIDGE_URL as string | undefined)?.trim() : undefined;
  if (env === '' || env === 'none' || !p.bridge) return [];
  const url = (env ?? p.bridge.url).replace(/\/+$/, '');
  return [{ name: url.replace(/^[a-z]+:\/\//i, ''), httpBase: url, govContractId: p.govContractId, bridgeIdentityId: p.bridge.identityId, enabled: true }];
}

const PRICE_FEED: NamedUrl = { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=dash&vs_currencies=usd' };
const EMPTY_FORUM: ForumEndpoints = { contractId: '', modContractId: '', moderationIdentityId: '', moderationName: 'govhub moderation', claimPortals: [] };

/** A profile's settings, with no overrides. */
export function profileRegistry(id: ProfileId): Registry {
  const p = PROFILES[id];
  const forum = p.forum ?? EMPTY_FORUM;
  return {
    version: 2,
    profile: id,
    coreNetwork: p.coreNetwork,
    platformNetwork: p.platformNetwork,
    dapi: { source: 'quorum', quorumUrl: QUORUM_SERVICE[p.coreNetwork], nodes: [] },
    platform: { trusted: true, addresses: [] },
    govContractId: p.govContractId,
    bridges: profileBridges(p),
    relays: p.relays.map((r) => ({ ...r })),
    quorumProofs: [...p.proofBridges.map((url): ProofSourceEndpoint => ({ name: url.replace(/^[a-z]+:\/\//i, ''), url, kind: 'bridge' })), { ...QUORUM_PROOF_SERVICE[p.coreNetwork] }],
    priceFeed: { ...PRICE_FEED },
    accounts: null,
    faucet: { ...DEFAULT_FAUCET },
    forum: { ...forum, claimPortals: [...forum.claimPortals] },
  };
}

export const defaultRegistry = (): Registry => profileRegistry(DEFAULT_PROFILE);

/** Settings that may differ from the profile, in the order Settings shows them. */
export const OVERRIDABLE = ['coreNetwork', 'platformNetwork', 'govContractId', 'dapi', 'platform', 'bridges', 'relays', 'quorumProofs', 'priceFeed', 'accounts', 'faucet', 'forum'] as const;
export type Overridable = (typeof OVERRIDABLE)[number];

/** The fields of `r` that differ from its profile's defaults (shown as "custom"). */
export function customFields(r: Registry): Set<Overridable> {
  const d = profileRegistry(r.profile);
  return new Set(OVERRIDABLE.filter((k) => JSON.stringify(r[k]) !== JSON.stringify(d[k])));
}

/**
 * Switching profile is one action: every network-specific setting becomes the new profile's; only the price feed (not tied to a
 * network) carries over. Overrides made for the old profile do not leak into the new one.
 */
export function registryForProfile(r: Registry, id: ProfileId): Registry {
  if (!PROFILES[id].deployed) throw new Error(`${PROFILES[id].label} is not deployed yet`);
  return { ...profileRegistry(id), priceFeed: r.priceFeed };
}

/** What every cached value of these settings is keyed by: a different profile, network or contract never reads another's cache. */
export const registryScope = (r: Pick<Registry, 'profile' | 'coreNetwork' | 'platformNetwork' | 'govContractId'>): string =>
  `${r.profile}:${r.coreNetwork}:${r.platformNetwork}:${r.govContractId || '-'}`;

// ---- migration -------------------------------------------------------------------------------------------------------------

/**
 * Version 1 settings (separate Core and Platform network selects) to version 2. Core testnet + Platform testnet means the user
 * asked for testnet: they land on the Testnet profile, keeping only what fits it (the Dev contract and its bridge were the reason
 * such settings showed mainnet proposals with testnet superblock maths). Everything else lands on Dev, overrides kept.
 */
export function migrateV1(o: Record<string, unknown>): Record<string, unknown> {
  const wantsTestnet = o.coreNetwork === 'testnet' && o.platformNetwork === 'testnet';
  if (!wantsTestnet) {
    // The Dev contract only makes sense with the Dev networks (mainnet Core, testnet Platform).
    const dev = o.govContractId === undefined || o.govContractId === DEV_GOV_CONTRACT_ID ? { coreNetwork: PROFILES.dev.coreNetwork, platformNetwork: PROFILES.dev.platformNetwork } : {};
    const dapi = (o.dapi ?? {}) as Record<string, unknown>;
    const quorum = dev.coreNetwork && dapi.source !== 'manual' ? { dapi: { ...dapi, source: 'quorum', quorumUrl: QUORUM_SERVICE[dev.coreNetwork] } } : {};
    // Version 1 always saved `relays: []` (it had no relay to offer), so an empty list is the old default, not a choice:
    // drop it so the profile's relays apply.
    const { relays, ...rest } = o;
    const keepRelays = Array.isArray(relays) && relays.length > 0 ? { relays } : {};
    return { ...rest, ...keepRelays, version: 2, profile: 'dev', ...dev, ...quorum };
  }
  const d = profileRegistry('testnet') as unknown as Record<string, unknown>;
  const devContract = (x: unknown) => x === DEV_GOV_CONTRACT_ID;
  const bridges = (Array.isArray(o.bridges) ? o.bridges : []).filter((b: unknown) => {
    const x = (b ?? {}) as Record<string, unknown>;
    return !devContract(x.govContractId) && String(x.httpBase ?? '').replace(/\/+$/, '') !== PROFILES.dev.bridge?.url;
  });
  const ownContract = typeof o.govContractId === 'string' && o.govContractId !== '' && !devContract(o.govContractId);
  const dapi = (o.dapi ?? {}) as Record<string, unknown>;
  const keepDapi = dapi.source === 'manual' || dapi.quorumUrl === QUORUM_SERVICE.testnet;
  return {
    ...d,
    ...(keepDapi ? { dapi: o.dapi } : {}),
    ...(o.platform !== undefined ? { platform: o.platform } : {}),
    ...(o.priceFeed !== undefined ? { priceFeed: o.priceFeed } : {}),
    ...(o.forum !== undefined ? { forum: o.forum } : {}),
    ...(ownContract ? { govContractId: o.govContractId, bridges } : {}),
  };
}

// ---- parsing ---------------------------------------------------------------------------------------------------------------

const STORAGE_KEY = 'govhub.registry.v2';
/** Where version 1 settings were saved; read once and migrated. */
export const LEGACY_STORAGE_KEY = 'govhub.registry.v1';
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

/** Validates untrusted JSON (version 2, or version 1 which is migrated first) into a Registry. Unknown keys are dropped. */
export function parseRegistry(input: unknown): { registry: Registry; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return { registry: defaultRegistry(), errors: ['settings must be a JSON object'] };
  let o = input as Record<string, unknown>;
  if (o.version === 1) o = migrateV1(o);
  if (o.version !== 2) errors.push('version must be 2 (or 1, which is migrated)');
  const profile: ProfileId = isProfileId(o.profile) ? o.profile : DEFAULT_PROFILE;
  if (!isProfileId(o.profile)) errors.push(`profile must be one of ${PROFILE_ORDER.join(', ')}`);
  else if (!PROFILES[profile].deployed) errors.push(`the ${PROFILES[profile].label} profile is not deployed yet`);
  const d = profileRegistry(profile);
  const dapi = (o.dapi ?? {}) as Record<string, unknown>;
  const platform = (o.platform ?? {}) as Record<string, unknown>;
  const nodes = Array.isArray(dapi.nodes) ? dapi.nodes.filter((n): n is string => typeof n === 'string') : [];
  for (const n of nodes) if (!HOST_PORT.test(n)) errors.push(`DAPI node "${n}" must be host:port`);
  const addresses = Array.isArray(platform.addresses) ? platform.addresses.filter((n): n is string => typeof n === 'string') : [];
  for (const a of addresses) httpsUrl(a, `Platform address ${a}`, errors);
  const govContractId = typeof o.govContractId === 'string' ? o.govContractId : '';
  if (govContractId && !B58_ID.test(govContractId)) errors.push('govContractId must be a base58 identifier');
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
  const optionalNamed = (v: unknown, fallback: NamedUrl | null, what: string): NamedUrl | null => {
    if (v === undefined) return fallback;
    if (!v || typeof v !== 'object') return null;
    const x = v as Record<string, unknown>;
    return { name: typeof x.name === 'string' && x.name ? x.name.slice(0, 60) : what, url: httpsUrl(x.url, `${what} URL`, errors) };
  };
  const registry: Registry = {
    version: 2,
    profile,
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
    relays: o.relays === undefined ? d.relays.map((r) => ({ ...r })) : named(o.relays, 'relay'),
    // added with quorum-proof anchoring: settings saved before it get the profile's sources
    quorumProofs: o.quorumProofs === undefined
      ? d.quorumProofs.map((q) => ({ ...q }))
      : named(o.quorumProofs, 'quorum proof source').map((q, i): ProofSourceEndpoint => {
        const kind = ((o.quorumProofs as unknown[])[i] as Record<string, unknown> | null)?.kind;
        if (kind !== 'bridge' && kind !== 'quorum-list') errors.push(`quorum proof source ${i + 1}: kind must be "bridge" or "quorum-list"`);
        return { ...q, kind: kind === 'quorum-list' ? 'quorum-list' : 'bridge' };
      }),
    priceFeed: pf && typeof pf === 'object' ? { name: typeof pf.name === 'string' ? pf.name : 'price feed', url: httpsUrl(pf.url, 'price feed URL', errors) } : null,
    accounts: optionalNamed(o.accounts, d.accounts, 'accounts service'),
    faucet: optionalNamed(o.faucet, d.faucet, 'faucet'),
    forum: parseForum(o.forum, d.forum, errors),
  };
  if (registry.dapi.source === 'manual' && nodes.length === 0) errors.push('manual DAPI source needs at least one node');
  // Core network changed from the profile's while the proof sources stayed the profile's defaults: use that network's public source
  // (the profile's bridge serves the other network). A proof for the wrong network would only fail and fall back to proof of work.
  if (registry.coreNetwork !== d.coreNetwork && JSON.stringify(registry.quorumProofs) === JSON.stringify(d.quorumProofs)) {
    registry.quorumProofs = [{ ...QUORUM_PROOF_SERVICE[registry.coreNetwork] }];
  }
  // A profile's contract holds that profile's networks' data: read under other networks it would be computed with the wrong rules.
  for (const p of Object.values(PROFILES)) {
    if (p.govContractId && p.govContractId === govContractId && (registry.coreNetwork !== p.coreNetwork || registry.platformNetwork !== p.platformNetwork)) {
      errors.push(`the ${p.label} governance contract holds Core ${p.coreNetwork} data on Platform ${p.platformNetwork}; choose the ${p.label} profile instead of other networks`);
    }
  }
  return { registry, errors };
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * What is saved: the profile and only the fields the user overrode. Everything else is rebuilt from the profile on load, so a
 * profile that changes in a later build (the Testnet contract id filled in, a new bridge URL) reaches users who saved before.
 */
interface SavedRegistry {
  version: 2;
  profile: ProfileId;
  overrides: Partial<Pick<Registry, Overridable>>;
}

function expand(o: Record<string, unknown>): unknown {
  if (o.version !== 2 || !o.overrides || typeof o.overrides !== 'object' || !isProfileId(o.profile)) return o;
  const overrides = Object.fromEntries(Object.entries(o.overrides as Record<string, unknown>).filter(([k]) => (OVERRIDABLE as readonly string[]).includes(k)));
  return { ...profileRegistry(o.profile), ...overrides };
}

/**
 * Saved settings, or the defaults. Version 1 settings (the legacy key) are migrated once: saved under the new key, the old one
 * removed. Settings that do not validate fall back to the defaults rather than half-applying, and `errors` says why, so the app
 * can tell the user instead of silently showing another profile. They stay saved until the user saves new ones.
 */
export function loadSavedRegistry(storage: Store | undefined = globalThis.localStorage): { registry: Registry; errors: string[] } {
  let raw: string | null | undefined;
  let legacy: string | null | undefined;
  try {
    raw = storage?.getItem(STORAGE_KEY);
    legacy = raw ? null : storage?.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return { registry: defaultRegistry(), errors: [] }; // storage blocked: nothing was saved that could be wrong
  }
  if (!raw && !legacy) return { registry: defaultRegistry(), errors: [] };
  try {
    const { registry, errors } = parseRegistry(expand(JSON.parse((raw ?? legacy)!) as Record<string, unknown>));
    if (errors.length) return { registry: defaultRegistry(), errors };
    if (legacy) {
      saveRegistry(registry, storage);
      storage?.removeItem(LEGACY_STORAGE_KEY);
    }
    return { registry, errors: [] };
  } catch (e) {
    return { registry: defaultRegistry(), errors: [`they could not be read (${(e as Error).message})`] };
  }
}

export const loadRegistry = (storage: Store | undefined = globalThis.localStorage): Registry => loadSavedRegistry(storage).registry;

/** What a failed save says: a full storage quota is not a problem with the settings themselves. */
export function saveErrorText(e: unknown): string {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return "Not saved: this browser's storage for govhub is full. Clear some site data and try again.";
  return `Not saved: ${(e as Error)?.message ?? String(e)}`;
}

/** The largest settings file Import accepts. An export is a few KB; anything near this size is not govhub settings. */
export const MAX_IMPORT_BYTES = 64 * 1024;

/** Why an import of `bytes` is refused before it is read, or null. */
export function importSizeError(bytes: number): string | null {
  if (bytes <= MAX_IMPORT_BYTES) return null;
  const size = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
  return `Too large to be govhub settings: ${size} (the limit is ${MAX_IMPORT_BYTES / 1024} KB). Nothing was imported.`;
}

export function saveRegistry(r: Registry, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  const saved: SavedRegistry = { version: 2, profile: r.profile, overrides: Object.fromEntries([...customFields(r)].map((k) => [k, r[k]])) };
  storage?.setItem(STORAGE_KEY, JSON.stringify(saved));
}

export function resetRegistry(storage: Pick<Storage, 'removeItem'> | undefined = globalThis.localStorage): Registry {
  storage?.removeItem(STORAGE_KEY);
  storage?.removeItem(LEGACY_STORAGE_KEY);
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

/**
 * Share link for a registry: the app's own URL (origin and base path, e.g. https://gov.dashhq.org/ or
 * https://example.github.io/govhub/) + `?config=<base64url JSON>`.
 */
export function shareLink(r: Registry, appUrl: string): string {
  return `${appUrl.replace(/\/*$/, '/')}?config=${textToB64url(JSON.stringify(r))}`;
}

/**
 * The host a `?config=` value would be fetched from, or null for inline (base64url) settings. Such a file is fetched only after
 * the user agrees: the request alone tells that host who opened the link, and when.
 */
export function configParamUrl(value: string): URL | null {
  if (!/^https:\/\//.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Every setting as [label, text], each host, contract and identity included: what a `?config=` offer is compared by. A setting
 * missing here could be changed by a link without the user seeing it.
 */
export function registryRows(r: Registry): Array<[string, string]> {
  const list = (xs: string[]) => xs.join('; ') || 'none';
  return [
    ['Profile', PROFILES[r.profile].title],
    ['Networks', `Core ${r.coreNetwork}, Platform ${r.platformNetwork}`],
    ['Governance contract', r.govContractId || 'none'],
    // both lists, even the one not in use: switching the source in Settings later would use it
    ['DAPI nodes', `from ${r.dapi.source === 'manual' ? 'my own nodes' : 'the quorum service'}; quorum service ${r.dapi.quorumUrl || 'none'}; my own nodes ${list(r.dapi.nodes)}`],
    ['Platform', `${r.platform.trusted ? 'trusted quorum keys' : 'untrusted mode'}, ${r.platform.addresses.length ? `nodes ${list(r.platform.addresses)}` : 'SDK default nodes'}`],
    ['Bridges', list(r.bridges.map((b) => `${b.name} ${b.httpBase} (contract ${b.govContractId || 'any'}, identity ${b.bridgeIdentityId || 'none'}${b.enabled ? '' : ', off'})`))],
    ['Relays', list(r.relays.map((x) => `${x.name} ${x.url}`))],
    ['Quorum proof sources', list(r.quorumProofs.map((q) => `${q.name} ${q.url} (${q.kind})`))],
    ['Price feed', r.priceFeed ? `${r.priceFeed.name} ${r.priceFeed.url}` : 'none'],
    ['Accounts service', r.accounts ? `${r.accounts.name} ${r.accounts.url}` : 'none'],
    ['Faucet', r.faucet ? `${r.faucet.name} ${r.faucet.url}` : 'none'],
    ['Forum contracts', `forum ${r.forum.contractId || 'none'}, mod ${r.forum.modContractId || 'none'}`],
    ['Default block list', `${r.forum.moderationName} (${r.forum.moderationIdentityId || 'none'})`],
    ['Claim portals', list(r.forum.claimPortals)],
  ];
}

/** The settings a `?config=` offer would change, each with its current and offered value; the rest stay as they are. */
export function registryDiff(current: Registry, offered: Registry): Array<{ label: string; now: string; offered: string }> {
  const now = new Map(registryRows(current));
  return registryRows(offered)
    .filter(([k, v]) => now.get(k) !== v)
    .map(([label, v]) => ({ label, now: now.get(label) ?? 'none', offered: v }));
}

/**
 * Resolves a `?config=` value: an https URL to fetch, or base64url JSON. The result is NOT applied:
 * the UI asks the user first, because a link could point them at a lying bridge. A URL is resolved only once the user has
 * agreed to fetch it (configParamUrl).
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

/**
 * Bridges that may be asked for this registry's data: enabled, and publishing into the `gov` contract in use (a bridge for
 * another contract serves another network's or deployment's proposals). No contract, no bridge.
 */
export const enabledBridges = (r: Registry): BridgeEndpoint[] =>
  r.govContractId ? r.bridges.filter((b) => b.enabled && b.httpBase && (!b.govContractId || b.govContractId === r.govContractId)) : [];
