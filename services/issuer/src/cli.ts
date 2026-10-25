// issuer CLI.
//   issuer run                                    the HTTP service (env config, README "Configuration")
//   issuer healthcheck                            exit 0 when the local service answers /healthz
//   issuer keygen --dir D --from E --epochs N [--bits 2048|3072]
//                                                 OFFLINE: one RSA key per epoch E..E+N-1 (epoch-<E>.pem 0600 + manifest.json)
//   issuer publish-keys --dir D --identity-file critical.json --contract C --network N [--min-ahead 3]
//                                                 OFFLINE: publish the manifest's issuerKey documents (CRITICAL key)
//   issuer revoke --epoch E [--through E2] --from-height H --identity-file critical.json --contract C --network N [--yes]
//                                                 OFFLINE: publish issuerRevocation documents (CRITICAL key); a dry run without --yes
//   issuer epoch --network N --height H           print the epoch schedule around height H
import { parseArgs } from 'node:util';
import { EPOCH_PARAMS, epochOf, epochStart, fromHex, isNetwork, keyDeadline, toHex, type BadgeNetwork } from '@govhub/badge';
import { readIdentityKeyFile } from './config.ts';
import { keygen, manifestSpki, readManifest } from './keys.ts';
import { errText } from './log.ts';
import { parseEpochRange, revokeEpochs } from './revoke.ts';

const [cmd, ...rest] = process.argv.slice(2);

function net(v: string | undefined): BadgeNetwork {
  if (!isNetwork(v)) throw new Error('--network must be mainnet, testnet, devnet or regtest');
  return v;
}
const num = (v: string | undefined, what: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what} must be a non-negative integer`);
  return n;
};

async function main(): Promise<void> {
  switch (cmd) {
    case 'run': {
      const { runService } = await import('./main.ts');
      await runService();
      return;
    }
    case 'healthcheck': {
      const port = process.env.HTTP_PORT || '8789';
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      process.exit(r?.ok ? 0 : 1);
      return;
    }
    case 'keygen': {
      const { values } = parseArgs({ args: rest, options: { dir: { type: 'string' }, from: { type: 'string' }, epochs: { type: 'string' }, bits: { type: 'string', default: '2048' } } });
      if (!values.dir) throw new Error('--dir is required');
      const bits = Number(values.bits);
      if (bits !== 2048 && bits !== 3072) throw new Error('--bits must be 2048 or 3072');
      const added = await keygen(values.dir, num(values.from, '--from'), num(values.epochs, '--epochs'), bits);
      for (const a of added) console.log(JSON.stringify({ epoch: a.epoch, bits: a.bits, keyId: a.keyId }));
      console.error(`${added.length} new key(s) in ${values.dir}; private keys are epoch-<E>.pem (0600). Copy to the server only the epochs it may hold.`);
      return;
    }
    case 'publish-keys': {
      const { values } = parseArgs({
        args: rest,
        options: { dir: { type: 'string' }, 'identity-file': { type: 'string' }, contract: { type: 'string' }, network: { type: 'string' }, 'min-ahead': { type: 'string', default: '3' } },
      });
      if (!values.dir || !values['identity-file'] || !values.contract) throw new Error('--dir, --identity-file and --contract are required');
      const network = net(values.network);
      const p = EPOCH_PARAMS[network];
      const key = readIdentityKeyFile(values['identity-file']);
      if (key.keyId !== 1) console.error('warning: issuerKey documents need a CRITICAL key (keyId 1 in the standard layout)');
      const { connectPlatform } = await import('./platform.ts');
      const platform = await connectPlatform(network === 'mainnet' ? 'mainnet' : 'testnet', values.contract);
      const manifest = readManifest(values.dir);
      if (!manifest.length) throw new Error(`no manifest.json in ${values.dir}; run keygen first`);
      let height = await platform.coreHeight();
      const issuing = epochOf(p, height); // the current epoch is issued too (Standard mode)
      console.error(`platform core height ${height}: issuing for epoch ${issuing}`);
      for (const m of manifest) {
        const existing = await platform.issuerKey(key.identityId, m.epoch);
        if (existing) {
          const same = toHex(existing.keyId) === m.keyId;
          console.log(JSON.stringify({ epoch: m.epoch, status: same ? 'already published' : 'CONFLICT: a different key is published for this epoch', keyId: m.keyId }));
          continue;
        }
        height = await platform.coreHeight();
        // Readers accept a key only if it was created before S(E-1); leave a few blocks for the write to land.
        if (height + p.boundaryMarginBlocks >= keyDeadline(p, m.epoch)) {
          console.log(JSON.stringify({ epoch: m.epoch, status: 'skipped: too late (must be on Platform before S(E-1))', deadline: keyDeadline(p, m.epoch), height }));
          continue;
        }
        const spki = manifestSpki(m);
        const id = await platform.publishIssuerKey(key, { epoch: m.epoch, spki, keyId: fromHex(m.keyId) });
        const back = await platform.issuerKey(key.identityId, m.epoch);
        console.log(JSON.stringify({ epoch: m.epoch, status: back ? 'published' : 'published (not yet visible)', id, keyId: m.keyId, createdAtCoreBlockHeight: back?.createdAtCoreBlockHeight, deadline: keyDeadline(p, m.epoch) }));
      }
      const minAhead = num(values['min-ahead'], '--min-ahead');
      // Consecutive epochs after the issuing one that already have a key (the issuing epoch itself may predate this issuer).
      let ahead = 0;
      for (let e = issuing + 1; await platform.issuerKey(key.identityId, e); e++) ahead++;
      const now = (await platform.issuerKey(key.identityId, issuing)) ? 'has a key' : 'has NO key (tokens cannot be issued until the next epoch)';
      console.error(`issuing epoch ${issuing} ${now}; ${ahead} consecutive later epoch(s) have keys (${ahead >= minAhead ? 'ok' : `FEWER than ${minAhead}: publish more`})`);
      process.exit(0);
      return;
    }
    case 'revoke': {
      const { values } = parseArgs({
        args: rest,
        options: {
          epoch: { type: 'string' },
          through: { type: 'string' },
          'from-height': { type: 'string' },
          'identity-file': { type: 'string' },
          contract: { type: 'string' },
          network: { type: 'string' },
          yes: { type: 'boolean', default: false },
        },
      });
      if (!values['identity-file'] || !values.contract || values.epoch === undefined || values['from-height'] === undefined) throw new Error('--epoch, --from-height, --identity-file and --contract are required');
      const network = net(values.network);
      const epochs = parseEpochRange(num(values.epoch, '--epoch'), values.through === undefined ? undefined : num(values.through, '--through'));
      const fromHeight = num(values['from-height'], '--from-height');
      const key = readIdentityKeyFile(values['identity-file']);
      if (key.keyId !== 1) console.error('warning: issuerRevocation documents need a CRITICAL key (keyId 1 in the standard layout)');
      const { connectPlatform } = await import('./platform.ts');
      const platform = await connectPlatform(network === 'mainnet' ? 'mainnet' : 'testnet', values.contract);
      const height = await platform.coreHeight();
      console.error(`platform core height ${height}; badges of epoch(s) ${epochs[0]}..${epochs.at(-1)} created at or after ${fromHeight} become void${fromHeight > height ? ' (a height in the future: badges created before it stay valid)' : ''}`);
      if (!values.yes) console.error('dry run: nothing is published. A revocation is immutable and unique per epoch; re-run with --yes to publish.');
      const results = await revokeEpochs(platform, key, { epochs, fromHeight, publish: values.yes });
      for (const r of results) {
        const back = r.status === 'published' ? await platform.issuerRevocation(key.identityId, r.epoch) : null;
        console.log(JSON.stringify(r.status === 'published' ? { ...r, visible: !!back } : r));
      }
      // 1: a publish failed (re-run: published epochs report `already revoked`); 3: a slot holds a later revocation
      process.exit(results.some((r) => r.status === 'error') ? 1 : results.some((r) => r.status === 'conflict') ? 3 : 0);
      return;
    }
    case 'epoch': {
      const { values } = parseArgs({ args: rest, options: { network: { type: 'string' }, height: { type: 'string' } } });
      const p = EPOCH_PARAMS[net(values.network)];
      const h = num(values.height, '--height');
      const e = epochOf(p, h);
      console.log(JSON.stringify({ height: h, epoch: e, S: epochStart(p, e), next: epochStart(p, e + 1), issuingFor: [e, e + 1], keyDeadlineForNext: keyDeadline(p, e + 1), params: p }));
      return;
    }
    default:
      console.error('usage: issuer run | healthcheck | keygen | publish-keys | revoke | epoch   (see src/cli.ts)');
      process.exit(2);
  }
}

main().catch((e) => {
  // straight to stderr: `issuer run` silences `console` (no library may print request details)
  process.stderr.write(`error: ${errText(e)}\n`);
  process.exit(1);
});
