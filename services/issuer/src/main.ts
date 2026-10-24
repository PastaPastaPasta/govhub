// `issuer run`: wires config, Core, Platform, the token store, the epoch manager and the HTTP server.
import { serve } from '@hono/node-server';
import { EPOCH_PARAMS } from '@govhub/badge';
import { Challenges } from './challenge.ts';
import { loadConfig, readIdentityKeyFile, readSecretFile } from './config.ts';
import { createCoreView, createRpc, MnLists } from './core.ts';
import { openTokenStore } from './db.ts';
import { EpochManager } from './epochs.ts';
import { errText, log } from './log.ts';
import { connectPlatform, type IssuerPlatform } from './platform.ts';
import { createApp } from './server.ts';
import { TokenService } from './service.ts';

export async function runService(): Promise<void> {
  const cfg = loadConfig();
  const params = EPOCH_PARAMS[cfg.network];
  const core = createCoreView(createRpc({ url: cfg.core.rpcUrl, user: cfg.core.rpcUser, password: cfg.core.rpcPassword, timeoutMs: cfg.core.rpcTimeoutMs }), cfg.network);
  const store = openTokenStore(cfg.dbPath);
  const lists = new MnLists(core);
  // Readers flag an issuer without a valid issuerReport and clients post no badge without one, so the report key is required (N7).
  if (!cfg.reportKeyFile || !readSecretFile(cfg.reportKeyFile, 'ISSUER_REPORT_KEY_FILE')) throw new Error('ISSUER_REPORT_KEY_FILE (the issuer identity\'s HIGH key) is required: without issuerReport documents readers flag the issuer');
  const reportKey = readIdentityKeyFile(cfg.reportKeyFile);
  if (reportKey && reportKey.identityId !== cfg.issuerId) throw new Error('ISSUER_REPORT_KEY_FILE belongs to another identity');
  let platform: IssuerPlatform | null = null;
  const connect = async () => {
    try {
      platform ??= await connectPlatform(cfg.platformNetwork, cfg.contractId);
    } catch (e) {
      log.warn('Platform not reachable yet', { error: errText(e) });
    }
  };
  await connect();
  const epochs = new EpochManager({ params, issuerId: cfg.issuerId, keyDir: cfg.keyDir, maxStagedKeys: cfg.maxStagedKeys, core, lists, store, platform: () => platform, reportKey });
  const challenges = new Challenges(cfg.hmacSecret, `${cfg.network}|${cfg.issuerId}`, cfg.challengeTtlSec);
  if (!cfg.hmacSecret) log.warn('ISSUER_HMAC_SECRET_FILE not set: challenges are invalidated by a restart');
  const service = new TokenService({ network: cfg.network, params, issuerId: cfg.issuerId, core, lists, store, challenges, activeKey: (e) => epochs.activeKey(e), nowSec: () => Math.floor(Date.now() / 1000), maxRecoveriesPerSec: cfg.maxTokenRequestsPerSec });
  const counters = new Map<string, number>();
  const app = createApp({ network: cfg.network, params, issuerId: cfg.issuerId, contractId: cfg.contractId, service, epochs, challengeTtlSec: cfg.challengeTtlSec, counters });

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (!platform) await connect();
      await epochs.tick();
    } catch (e) {
      log.error('tick failed', { error: errText(e) });
    } finally {
      running = false;
    }
  };
  await tick();
  const timer = setInterval(tick, cfg.tickSec * 1000);
  // Aggregate counts only, hourly: no per-request records with timestamps.
  const stats = setInterval(() => {
    if (counters.size) log.info('requests in the last hour', { ...Object.fromEntries(counters), status: epochs.status });
    counters.clear();
  }, 3_600_000);

  const server = serve({ fetch: app.fetch, hostname: cfg.http.host, port: cfg.http.port });
  log.info('issuer listening', { host: cfg.http.host, port: cfg.http.port, network: cfg.network, issuerId: cfg.issuerId, contractId: cfg.contractId, status: epochs.status });
  const stop = () => {
    clearInterval(timer);
    clearInterval(stats);
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
