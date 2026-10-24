// Bridge configuration: environment variables plus optional mounted secret files (docker compose friendly).
// Every variable is documented in README.md ("Configuration"). Secrets are only ever read from files
// (CORE_RPC_PASSWORD_FILE, BRIDGE_IDENTITY_KEY_FILE); CORE_RPC_PASSWORD exists for local development only.
import { readFileSync } from 'node:fs';
import type { Network } from '@govhub/verify';

export type CoreNetwork = Extract<Network, 'mainnet' | 'testnet' | 'regtest' | 'devnet'>;
export type PlatformNetwork = 'mainnet' | 'testnet';

export interface BridgeConfig {
  coreNetwork: CoreNetwork;
  /** Platform network the gov documents are published to. Production uses the same network as Core; dev may differ. */
  platformNetwork: PlatformNetwork;
  core: {
    rpcUrl: string;
    rpcUser: string;
    rpcPassword: string;
    rpcTimeoutMs: number;
    rpcRetries: number;
    /** Empty = no ZMQ (archive only what RPC reconciliation sees: no signed votes). */
    zmqUrl: string;
  };
  dbPath: string;
  http: { host: string; port: number };
  publish: {
    enabled: boolean;
    govContractId: string;
    identityKeyFile: string;
    maxConcurrentWrites: number;
    tallyIntervalSec: number;
    cycleIntervalSec: number;
    minCollateralConfs: number;
    /** Publish a tally even when it disagrees with Core's FundingResult (default false: hold it and log). */
    publishOnMismatch: boolean;
  };
  reconcileIntervalSec: number;
  /** `{hash}` and `{name}` are substituted; used for the DashCentral-compatible `dw_url`. */
  portalProposalUrl: string;
}

const CORE_NETWORKS: readonly CoreNetwork[] = ['mainnet', 'testnet', 'regtest', 'devnet'];

function str(env: NodeJS.ProcessEnv, key: string, def: string): string {
  const v = env[key];
  return v === undefined || v === '' ? def : v;
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min) throw new Error(`${key} must be an integer >= ${min}, got ${JSON.stringify(raw)}`);
  return v;
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${key} must be 0/1/true/false, got ${JSON.stringify(raw)}`);
}

function readSecretFile(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (e) {
    throw new Error(`cannot read ${what} from ${path}: ${(e as Error).message}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const coreNetwork = str(env, 'CORE_NETWORK', 'mainnet') as CoreNetwork;
  if (!CORE_NETWORKS.includes(coreNetwork)) throw new Error(`CORE_NETWORK must be one of ${CORE_NETWORKS.join(', ')}`);
  const platformDefault = coreNetwork === 'mainnet' ? 'mainnet' : 'testnet';
  const platformNetwork = str(env, 'PLATFORM_NETWORK', platformDefault) as PlatformNetwork;
  if (platformNetwork !== 'mainnet' && platformNetwork !== 'testnet') throw new Error('PLATFORM_NETWORK must be mainnet or testnet');

  const defaultRpcPort = { mainnet: 9998, testnet: 19998, regtest: 19898, devnet: 19798 }[coreNetwork];
  let rpcPassword = env.CORE_RPC_PASSWORD ?? '';
  if (env.CORE_RPC_PASSWORD_FILE) rpcPassword = readSecretFile(env.CORE_RPC_PASSWORD_FILE, 'CORE_RPC_PASSWORD_FILE');

  const publishEnabled = bool(env, 'PUBLISH', true);
  const cfg: BridgeConfig = {
    coreNetwork,
    platformNetwork,
    core: {
      rpcUrl: str(env, 'CORE_RPC_URL', `http://127.0.0.1:${defaultRpcPort}`),
      rpcUser: str(env, 'CORE_RPC_USER', ''),
      rpcPassword,
      rpcTimeoutMs: int(env, 'CORE_RPC_TIMEOUT_MS', 60_000, 1),
      rpcRetries: int(env, 'CORE_RPC_RETRIES', 3),
      zmqUrl: env.CORE_ZMQ_URL ?? 'tcp://127.0.0.1:29998',
    },
    dbPath: str(env, 'DB_PATH', './data/bridge.sqlite'),
    http: { host: str(env, 'HTTP_HOST', '127.0.0.1'), port: int(env, 'HTTP_PORT', 8787, 0) },
    publish: {
      enabled: publishEnabled,
      govContractId: str(env, 'GOV_CONTRACT_ID', ''),
      identityKeyFile: str(env, 'BRIDGE_IDENTITY_KEY_FILE', ''),
      maxConcurrentWrites: Math.min(int(env, 'PLATFORM_MAX_CONCURRENT_WRITES', 4, 1), 12),
      tallyIntervalSec: int(env, 'TALLY_PUBLISH_INTERVAL_S', 3600),
      cycleIntervalSec: int(env, 'CYCLE_PUBLISH_INTERVAL_S', 3600),
      minCollateralConfs: int(env, 'MIN_COLLATERAL_CONFS', 6, 1),
      publishOnMismatch: bool(env, 'PUBLISH_ON_MISMATCH', false),
    },
    reconcileIntervalSec: int(env, 'RECONCILE_INTERVAL_S', 600, 10),
    portalProposalUrl: str(env, 'PORTAL_PROPOSAL_URL', 'https://gov.dashhq.org/p/{hash}'),
  };
  if (cfg.publish.enabled) {
    if (!cfg.publish.govContractId) throw new Error('GOV_CONTRACT_ID is required when PUBLISH=1');
    if (!cfg.publish.identityKeyFile) throw new Error('BRIDGE_IDENTITY_KEY_FILE is required when PUBLISH=1');
  }
  return cfg;
}

/** Contents of BRIDGE_IDENTITY_KEY_FILE: the bridge identity and ONE document-signing key (HIGH, AUTHENTICATION). */
export interface IdentityKeyFile {
  identityId: string;
  keyId: number;
  /** 32-byte secp256k1 private key as hex, or `wif`. */
  privateKeyHex?: string;
  wif?: string;
}

export function readIdentityKeyFile(path: string): IdentityKeyFile {
  const parsed = JSON.parse(readSecretFile(path, 'BRIDGE_IDENTITY_KEY_FILE')) as IdentityKeyFile;
  if (typeof parsed.identityId !== 'string' || !Number.isInteger(parsed.keyId)) throw new Error('identity key file needs identityId (base58) and keyId');
  if (!parsed.privateKeyHex && !parsed.wif) throw new Error('identity key file needs privateKeyHex or wif');
  if (parsed.privateKeyHex && !/^[0-9a-fA-F]{64}$/.test(parsed.privateKeyHex)) throw new Error('privateKeyHex must be 64 hex chars');
  return parsed;
}

/** A redacted view for logs and /v1/status. */
export function describeConfig(c: BridgeConfig): Record<string, unknown> {
  return {
    coreNetwork: c.coreNetwork,
    platformNetwork: c.platformNetwork,
    coreRpcUrl: c.core.rpcUrl.replace(/\/\/[^@/]*@/, '//***@'),
    zmqUrl: c.core.zmqUrl || null,
    dbPath: c.dbPath,
    http: c.http,
    publish: { ...c.publish, identityKeyFile: c.publish.identityKeyFile ? '(set)' : '' },
    reconcileIntervalSec: c.reconcileIntervalSec,
  };
}
