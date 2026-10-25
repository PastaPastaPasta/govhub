// relay CLI: run | healthcheck
import { serve } from '@hono/node-server';
import { createApp } from './api/server.ts';
import { Broadcaster } from './broadcaster.ts';
import { describeConfig, loadConfig } from './config.ts';
import { CoreRpc } from './core/rpc.ts';
import { openDb, Store } from './db.ts';
import { errText, log, nowS } from './log.ts';
import { Relay } from './relay.ts';

const USAGE = `usage: relay <command>

commands:
  run          HTTP API + broadcaster + confirmer + held-proposal worker, until SIGTERM
  healthcheck  exit 0 if GET /v1/status on HTTP_PORT answers 200

configuration: environment variables (see README.md "Configuration")`;

async function main(): Promise<number> {
  const [cmd] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  if (cmd === 'healthcheck') {
    const port = Number(process.env.HTTP_PORT || 8788);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/status`, { signal: AbortSignal.timeout(5000) });
      return r.ok ? 0 : 1;
    } catch {
      return 1;
    }
  }
  if (cmd !== 'run') {
    console.error(`unknown command ${cmd}\n\n${USAGE}`);
    return 2;
  }

  const cfg = loadConfig();
  log.info('config', describeConfig(cfg));
  const store = new Store(openDb(cfg.dbPath));
  const core = new CoreRpc({ url: cfg.core.rpcUrl, user: cfg.core.rpcUser, password: cfg.core.rpcPassword, timeoutMs: cfg.core.rpcTimeoutMs, retries: 2 });
  const relay = new Relay(cfg, store, core, nowS);
  const broadcaster = new Broadcaster({ cfg, store, core, mns: relay.mns, clock: nowS });
  const app = createApp(relay);
  // overrideGlobalObjects: false, as in the bridge: keep the platform's own Request/Response.
  const server = serve({ fetch: app.fetch, port: cfg.http.port, hostname: cfg.http.host, overrideGlobalObjects: false });
  broadcaster.start();
  relay.proposer.start();
  log.info('http api listening', { host: cfg.http.host, port: cfg.http.port });

  const shutdown = (sig: string) => {
    log.info('shutting down', { signal: sig });
    broadcaster.stop();
    relay.proposer.stop();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return 0;
}

main().then(
  (code) => {
    if (process.argv[2] !== 'run') process.exit(code);
  },
  (e) => {
    log.error('fatal', { error: errText(e) });
    process.exit(1);
  },
);
