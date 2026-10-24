// Issuer configuration: environment variables plus mounted secret files (docker compose secrets). Every variable is
// documented in README.md. Secrets (RPC password, HMAC secret, identity key) are only read from files.
import { readFileSync } from 'node:fs';
import { idToBytes, isNetwork, type BadgeNetwork } from '@govhub/badge';

export type PlatformNetwork = 'mainnet' | 'testnet';

export interface IssuerConfig {
  network: BadgeNetwork;
  platformNetwork: PlatformNetwork;
  /** base58 identity id of the issuer (owner of the issuerKey documents) */
  issuerId: string;
  /** the `badge` contract the issuerKey documents and badges live in */
  contractId: string;
  core: { rpcUrl: string; rpcUser: string; rpcPassword: string; rpcTimeoutMs: number };
  /** Directory holding epoch-<E>.pem private keys. Keys for past epochs are destroyed here automatically. */
  keyDir: string;
  /** How many keys for epochs after the one being issued may sit in keyDir (PLAN: the server holds only the current key). */
  maxStagedKeys: number;
  /** 32+ byte secret for the stateless challenges; random per process when unset (challenges then die with a restart). */
  hmacSecret: Uint8Array | null;
  challengeTtlSec: number;
  dbPath: string;
  http: { host: string; port: number };
  /** HIGH key of the issuer identity, used only to publish issuerReport documents. Empty: reports are not published. */
  reportKeyFile: string;
  /** Global cap on token requests per second, a CPU backstop (no per-IP state is kept; per-MN limits apply after authentication). */
  maxTokenRequestsPerSec: number;
  /** Seconds between chain polls (epoch roll-over, key loading, record deletion, reports). */
  tickSec: number;
}

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
export function readSecretFile(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (e) {
    throw new Error(`cannot read ${what} from ${path}: ${(e as Error).message}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IssuerConfig {
  const network = str(env, 'NETWORK', 'mainnet');
  if (!isNetwork(network)) throw new Error('NETWORK must be mainnet, testnet, devnet or regtest');
  const platformNetwork = (network === 'mainnet' ? 'mainnet' : 'testnet') satisfies PlatformNetwork;
  const issuerId = str(env, 'ISSUER_IDENTITY_ID', '');
  const contractId = str(env, 'BADGE_CONTRACT_ID', '');
  for (const [k, v] of [['ISSUER_IDENTITY_ID', issuerId], ['BADGE_CONTRACT_ID', contractId]] as const) {
    try {
      idToBytes(v);
    } catch {
      throw new Error(`${k} must be a base58 identifier`);
    }
  }
  const defaultRpcPort = { mainnet: 9998, testnet: 19998, regtest: 19898, devnet: 19798 }[network];
  let rpcPassword = env.CORE_RPC_PASSWORD ?? '';
  if (env.CORE_RPC_PASSWORD_FILE) rpcPassword = readSecretFile(env.CORE_RPC_PASSWORD_FILE, 'CORE_RPC_PASSWORD_FILE');
  let hmacSecret: Uint8Array | null = null;
  if (env.ISSUER_HMAC_SECRET_FILE) {
    const s = readSecretFile(env.ISSUER_HMAC_SECRET_FILE, 'ISSUER_HMAC_SECRET_FILE');
    if (!/^[0-9a-fA-F]{64,}$/.test(s)) throw new Error('ISSUER_HMAC_SECRET_FILE must hold at least 32 bytes as hex');
    hmacSecret = new Uint8Array(Buffer.from(s, 'hex'));
  }
  return {
    network,
    platformNetwork,
    issuerId,
    contractId,
    core: {
      rpcUrl: str(env, 'CORE_RPC_URL', `http://127.0.0.1:${defaultRpcPort}`),
      rpcUser: str(env, 'CORE_RPC_USER', ''),
      rpcPassword,
      rpcTimeoutMs: int(env, 'CORE_RPC_TIMEOUT_MS', 15_000, 1),
    },
    keyDir: str(env, 'ISSUER_KEY_DIR', './keys'),
    maxStagedKeys: int(env, 'ISSUER_MAX_STAGED_KEYS', 1),
    hmacSecret,
    challengeTtlSec: int(env, 'ISSUER_CHALLENGE_TTL_S', 600, 30),
    dbPath: str(env, 'DB_PATH', './data/issuer.sqlite'),
    http: { host: str(env, 'HTTP_HOST', '127.0.0.1'), port: int(env, 'HTTP_PORT', 8789) },
    reportKeyFile: str(env, 'ISSUER_REPORT_KEY_FILE', ''),
    maxTokenRequestsPerSec: int(env, 'ISSUER_MAX_TOKEN_RPS', 200, 1),
    tickSec: int(env, 'ISSUER_TICK_S', 30, 1),
  };
}

/** {"identityId", "keyId", "privateKeyHex" | "wif"}: one key of the issuer identity (CRITICAL for keys, HIGH for reports). */
export interface IdentityKeyFile {
  identityId: string;
  keyId: number;
  privateKeyHex?: string;
  wif?: string;
}

export function readIdentityKeyFile(path: string): IdentityKeyFile {
  const parsed = JSON.parse(readSecretFile(path, 'identity key file')) as IdentityKeyFile;
  if (typeof parsed.identityId !== 'string' || !Number.isInteger(parsed.keyId)) throw new Error('identity key file needs identityId (base58) and keyId');
  if (!parsed.privateKeyHex && !parsed.wif) throw new Error('identity key file needs privateKeyHex or wif');
  if (parsed.privateKeyHex && !/^[0-9a-fA-F]{64}$/.test(parsed.privateKeyHex)) throw new Error('privateKeyHex must be 64 hex chars');
  return parsed;
}
