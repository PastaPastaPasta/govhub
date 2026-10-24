// bridge CLI: run | backfill | publish --once | verify | healthcheck
import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApi } from './api/server.ts';
import { Bridge } from './bridge.ts';
import { describeConfig, loadConfig } from './config.ts';
import { errText, log } from './log.ts';
import { verifyArchive } from './verify.ts';

const USAGE = `usage: bridge <command> [options]

commands:
  run                      archive + verify + tally + publish (unless PUBLISH=0) + HTTP API, until SIGTERM
  backfill [--govdat F]    one reconciliation pass over RPC (objects, collateral, MN list, budget);
                           --govdat imports objects and signed votes from a COPY of dashd's governance.dat
  publish --once [--force] one refresh + publish pass (--force ignores the replace throttle)
  verify [--no-core]       recompute hashes, signatures, collateral and tallies from the archive and diff against Core
  healthcheck              exit 0 if GET /v1/status on HTTP_PORT answers 200

configuration: environment variables (see README.md "Configuration")`;

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}
function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  if (cmd === 'healthcheck') {
    const port = Number(process.env.HTTP_PORT || 8787);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/status`, { signal: AbortSignal.timeout(5000) });
      return r.ok ? 0 : 1;
    } catch {
      return 1;
    }
  }
  const cfg = loadConfig();
  log.info('config', describeConfig(cfg));

  if (cmd === 'run') {
    const bridge = new Bridge(cfg);
    const app = createApi(bridge);
    // overrideGlobalObjects: false — @hono/node-server otherwise swaps the global Request/Response for its own, which breaks
    // evo-sdk's DAPI/quorum fetches ("Failed to prefetch quorums: HTTP request error").
    const server = serve({ fetch: app.fetch, port: cfg.http.port, hostname: cfg.http.host, overrideGlobalObjects: false });
    log.info('http api listening', { host: cfg.http.host, port: cfg.http.port });
    const shutdown = async (sig: string) => {
      log.info('shutting down', { signal: sig });
      await bridge.stop();
      server.close();
      bridge.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    await bridge.run();
    return 0;
  }

  if (cmd === 'backfill') {
    const bridge = new Bridge({ ...cfg, publish: { ...cfg.publish, enabled: false } });
    try {
      if (!(await bridge.waitForCore(10 * 60_000))) throw new Error(`Core not ready: ${bridge.core.lastError ?? 'chain not synced'}`);
      const govdat = opt(args, '--govdat');
      await bridge.ingest.refreshHeight();
      await bridge.ingest.ensureSnapshot(bridge.ingest.height);
      if (govdat) {
        const r = bridge.ingest.importGovernanceDat(readFileSync(govdat), cfg.coreNetwork);
        log.info('governance.dat imported', r);
      }
      const run = await bridge.refresh({ reconcile: true, compare: true });
      const mism = [...bridge.lastComparisons.values()].filter((c) => !c.match);
      console.log(
        JSON.stringify(
          {
            height: bridge.ingest.height,
            core: bridge.core,
            proposals: run?.tallies.length ?? 0,
            ingest: bridge.ingest.stats,
            coreMismatches: mism.length,
            missingSignedVotes: mism.reduce((a, c) => a + c.missingSigned.length, 0),
            note: mism.length
              ? 'Core counts votes the archive has no signed copy of. Signed votes only come from ZMQ (or governance.dat): run `bridge run`, then re-sync dashd governance (README "Backfill").'
              : 'archive agrees with Core',
          },
          null,
          2,
        ),
      );
    } finally {
      bridge.close();
    }
    return 0;
  }

  if (cmd === 'publish') {
    if (!flag(args, '--once')) {
      console.error('publish needs --once (continuous publishing is part of `bridge run`)');
      return 2;
    }
    if (!cfg.publish.enabled) {
      console.error('PUBLISH=0: nothing to do');
      return 2;
    }
    const bridge = new Bridge(cfg);
    try {
      if (!(await bridge.waitForCore(10 * 60_000))) throw new Error(`Core not ready: ${bridge.core.lastError ?? 'chain not synced'}`);
      await bridge.startPublisher();
      await bridge.refresh({ reconcile: true, compare: true });
      const s = await bridge.publishOnce({ force: flag(args, '--force') });
      console.log(JSON.stringify(s, null, 2));
      return s && s.failed === 0 ? 0 : 1;
    } finally {
      bridge.close();
    }
  }

  if (cmd === 'verify') {
    const bridge = new Bridge({ ...cfg, publish: { ...cfg.publish, enabled: false } });
    try {
      const withCore = !flag(args, '--no-core');
      if (withCore && !(await bridge.waitForCore(60_000))) throw new Error(`Core not ready: ${bridge.core.lastError ?? 'chain not synced'}`);
      const report = await verifyArchive(bridge, { withCore });
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    } finally {
      bridge.close();
    }
  }

  console.error(`unknown command ${cmd}\n\n${USAGE}`);
  return 2;
}

main().then(
  (code) => {
    if (process.argv[2] !== 'run') process.exit(code);
  },
  (e) => {
    log.error('fatal', { error: errText(e), stack: (e as Error)?.stack });
    process.exit(1);
  },
);
