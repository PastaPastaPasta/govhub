// Relay configuration: environment variables plus an optional mounted secret file (docker compose friendly).
// Every variable is documented in README.md ("Configuration"). The RPC password is only ever read from
// CORE_RPC_PASSWORD_FILE; CORE_RPC_PASSWORD exists for local development only. An empty value means the default.
import { readFileSync } from 'node:fs';
import type { Network } from '@govhub/verify';

export type CoreNetwork = Extract<Network, 'mainnet' | 'testnet' | 'regtest' | 'devnet'>;

export interface RelayConfig {
  network: CoreNetwork;
  core: { rpcUrl: string; rpcUser: string; rpcPassword: string; rpcTimeoutMs: number };
  dbPath: string;
  http: { host: string; port: number };
  /** A vote is released at max(now, time - releaseMarginS) unless the client asks for another time. */
  releaseMarginS: number;
  /** How far ahead a vote's signed time (and its release) may lie. */
  maxHoldS: number;
  maxHeldPerMn: number;
  rateIpPerMin: number;
  rateMnPerHour: number;
  /** Header carrying the client IP (e.g. `cf-connecting-ip` behind cloudflared). Empty = the socket address. */
  clientIpHeader: string;
  proposalSubmit: boolean;
  minCollateralConfs: number;
  retentionDays: number;
  confirmTimeoutS: number;
  mnListTtlS: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const network = str(env, 'CORE_NETWORK', 'mainnet') as CoreNetwork;
  if (!CORE_NETWORKS.includes(network)) throw new Error(`CORE_NETWORK must be one of ${CORE_NETWORKS.join(', ')}`);
  const defaultRpcPort = { mainnet: 9998, testnet: 19998, regtest: 19898, devnet: 19798 }[network];

  let rpcPassword = env.CORE_RPC_PASSWORD ?? '';
  if (env.CORE_RPC_PASSWORD_FILE) {
    try {
      rpcPassword = readFileSync(env.CORE_RPC_PASSWORD_FILE, 'utf8').trim();
    } catch (e) {
      throw new Error(`cannot read CORE_RPC_PASSWORD_FILE from ${env.CORE_RPC_PASSWORD_FILE}: ${(e as Error).message}`);
    }
  }

  return {
    network,
    core: {
      rpcUrl: str(env, 'CORE_RPC_URL', `http://127.0.0.1:${defaultRpcPort}`),
      rpcUser: str(env, 'CORE_RPC_USER', ''),
      rpcPassword,
      rpcTimeoutMs: int(env, 'CORE_RPC_TIMEOUT_MS', 30_000, 1),
    },
    dbPath: str(env, 'DB_PATH', './data/relay.sqlite'),
    http: { host: str(env, 'HTTP_HOST', '127.0.0.1'), port: int(env, 'HTTP_PORT', 8788, 0) },
    releaseMarginS: int(env, 'RELEASE_MARGIN_S', 60),
    maxHoldS: int(env, 'MAX_HOLD_S', 3_456_000, 1),
    maxHeldPerMn: int(env, 'MAX_HELD_PER_MN', 64, 1),
    rateIpPerMin: int(env, 'RATE_IP_PER_MIN', 30, 1),
    rateMnPerHour: int(env, 'RATE_MN_PER_HOUR', 24, 1),
    clientIpHeader: str(env, 'CLIENT_IP_HEADER', '').toLowerCase(),
    proposalSubmit: bool(env, 'PROPOSAL_SUBMIT', true),
    minCollateralConfs: int(env, 'MIN_COLLATERAL_CONFS', 6, 1),
    retentionDays: int(env, 'RETENTION_DAYS', 7, 1),
    confirmTimeoutS: int(env, 'CONFIRM_TIMEOUT_S', 600, 1),
    mnListTtlS: int(env, 'MN_LIST_TTL_S', 60, 1),
  };
}

/** A redacted view for logs. */
export function describeConfig(c: RelayConfig): Record<string, unknown> {
  return {
    network: c.network,
    coreRpcUrl: c.core.rpcUrl.replace(/\/\/[^@/]*@/, '//***@'),
    dbPath: c.dbPath,
    http: c.http,
    releaseMarginS: c.releaseMarginS,
    maxHoldS: c.maxHoldS,
    maxHeldPerMn: c.maxHeldPerMn,
    rateIpPerMin: c.rateIpPerMin,
    rateMnPerHour: c.rateMnPerHour,
    clientIpHeader: c.clientIpHeader || null,
    proposalSubmit: c.proposalSubmit,
    minCollateralConfs: c.minCollateralConfs,
    retentionDays: c.retentionDays,
    confirmTimeoutS: c.confirmTimeoutS,
    mnListTtlS: c.mnListTtlS,
  };
}
