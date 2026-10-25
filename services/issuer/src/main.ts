// `issuer run`: wires config, Core, Platform, the token store, the epoch manager and the HTTP server, and (when
// STARTER_ISSUER_IDENTITY_ID is set) the starter store, manager and service on the same Core, Platform, timer and server.
import { serve } from '@hono/node-server';
import { EPOCH_PARAMS } from '@govhub/badge';
import { Challenges } from './challenge.ts';
import { loadConfig, readIdentityKeyFile, readSecretFile } from './config.ts';
import { createCoreView, createRpc, MnLists, ProposalCache } from './core.ts';
import { openTokenStore } from './db.ts';
import { EpochManager } from './epochs.ts';
import { errText, log } from './log.ts';
import { connectPlatform, type IssuerPlatform } from './platform.ts';
import { createApp, type StarterDeps } from './server.ts';
import { RecoveryBudget, TokenService } from './service.ts';
import { openStarterStore, type StarterStore } from './starter-db.ts';
import { StarterManager } from './starter-epochs.ts';
import { StarterService } from './starter.ts';

export async function runService(): Promise<void> {
  // The issuer writes its own (policy-checked) lines through log.ts. Libraries that print to the console, e.g. the HTTP server
  // on an aborted or failed response, could write request details to stdout, which Docker keeps: silence them all.
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) console[m] = () => undefined;
  const cfg = loadConfig();
  const params = EPOCH_PARAMS[cfg.network];
  const core = createCoreView(createRpc({ url: cfg.core.rpcUrl, user: cfg.core.rpcUser, password: cfg.core.rpcPassword, timeoutMs: cfg.core.rpcTimeoutMs }), cfg.network);
  const store = openTokenStore(cfg.dbPath);
  const lists = new MnLists(core);
  // Readers flag an issuer without a valid issuerReport and clients post no badge without one, so the report key is required (N7).
  if (!cfg.reportKeyFile || !readSecretFile(cfg.reportKeyFile, 'ISSUER_REPORT_KEY_FILE')) throw new Error('ISSUER_REPORT_KEY_FILE (the issuer identity\'s HIGH key) is required: without issuerReport documents readers flag the issuer');
  const reportKey = readIdentityKeyFile(cfg.reportKeyFile);
  if (reportKey.identityId !== cfg.issuerId) throw new Error('ISSUER_REPORT_KEY_FILE belongs to another identity');
  let platform: IssuerPlatform | null = null;
  const connect = async () => {
    try {
      platform ??= await connectPlatform(cfg.platformNetwork, cfg.contractId);
    } catch (e) {
      log.warn('Platform not reachable yet', { error: errText(e) });
    }
  };
  await connect();
  // Badge and starter keys must never be the same RSA key (blind signatures are separated by key only): each side refuses the other's.
  let starter: (StarterDeps & { manager: StarterManager; service: StarterService; store: StarterStore }) | null = null;
  const starterSide = () => (starter ? { label: 'starter', issuerId: starter.issuerId, activeKeyIds: () => starter?.manager.activeKeyIds() ?? [] } : null);
  const epochs = new EpochManager({ params, issuerId: cfg.issuerId, keyDir: cfg.keyDir, maxStagedKeys: cfg.maxStagedKeys, core, lists, store, platform: () => platform, reportKey, other: starterSide, maxTipLead: cfg.maxTipLead });
  const challenges = new Challenges(cfg.hmacSecret, `${cfg.network}|${cfg.issuerId}`, cfg.challengeTtlSec);
  if (!cfg.hmacSecret) log.warn('ISSUER_HMAC_SECRET_FILE not set: challenges are invalidated by a restart');
  const nowSec = () => Math.floor(Date.now() / 1000);
  // one CPU backstop for both services: signature recoveries are the same cost whoever asks
  const budget = new RecoveryBudget(cfg.maxTokenRequestsPerSec);
  const service = new TokenService({ network: cfg.network, params, issuerId: cfg.issuerId, core, lists, store, challenges, activeKey: (e) => epochs.activeKey(e), nowSec, budget });

  if (cfg.starter) {
    const sc = cfg.starter;
    const sStore = openStarterStore(sc.dbPath);
    const proposals = new ProposalCache(core);
    const manager = new StarterManager({ network: cfg.network, params, contractId: cfg.contractId, issuerId: sc.issuerId, keyDir: sc.keyDir, maxStagedKeys: sc.maxStagedKeys, core, proposals, store: sStore, platform: () => platform, other: () => ({ label: 'badge', issuerId: cfg.issuerId, activeKeyIds: () => epochs.activeKeyIds() }), maxTipLead: cfg.maxTipLead });
    // the same secret as the badge challenges, its own domain: a badge challenge is useless here and the reverse
    const sChallenges = new Challenges(cfg.hmacSecret, `starter|${cfg.network}|${sc.issuerId}`, sc.challengeTtlSec);
    const sService = new StarterService({ network: cfg.network, params, issuerId: sc.issuerId, core, lists, proposals, store: sStore, challenges: sChallenges, activeKey: (e) => manager.activeKey(e), nowSec, proposalGraceDays: sc.proposalGraceDays, budget });
    starter = { issuerId: sc.issuerId, manager, service: sService, store: sStore, challengeTtlSec: sc.challengeTtlSec };
  }
  const counters = new Map<string, number>();
  const app = createApp({ network: cfg.network, params, issuerId: cfg.issuerId, contractId: cfg.contractId, service, epochs, challengeTtlSec: cfg.challengeTtlSec, counters, starter });

  let running = false;
  const tick = async () => {
    service.prune(); // drops the per-MN rate-limit counts of a past minute (within one tick of it ending) when no request comes
    starter?.service.prune();
    if (running) return;
    running = true;
    try {
      if (!platform) await connect();
      // first: it refreshes the MN list the starter service authenticates against
      await epochs.tick();
    } catch (e) {
      log.error('tick failed', { error: errText(e) });
    }
    try {
      await starter?.manager.tick();
    } catch (e) {
      log.error('starter tick failed', { error: errText(e) });
    } finally {
      running = false;
    }
  };
  await tick();
  const timer = setInterval(tick, cfg.tickSec * 1000);
  // Aggregate counts only, hourly: no per-request records with timestamps.
  const stats = setInterval(() => {
    if (counters.size) log.info('requests in the last hour', { ...Object.fromEntries(counters), status: epochs.status, ...(starter ? { starterStatus: starter.manager.status } : {}) });
    counters.clear();
  }, 3_600_000);

  const server = serve({ fetch: app.fetch, hostname: cfg.http.host, port: cfg.http.port });
  log.info('issuer listening', { host: cfg.http.host, port: cfg.http.port, network: cfg.network, maxTipLead: cfg.maxTipLead, issuerId: cfg.issuerId, contractId: cfg.contractId, status: epochs.status, starter: starter ? { issuerId: starter.issuerId, status: starter.manager.status } : 'off' });
  const stop = () => {
    clearInterval(timer);
    clearInterval(stats);
    server.close();
    store.close();
    starter?.store.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
