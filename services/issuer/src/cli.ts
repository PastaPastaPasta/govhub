// issuer CLI.
//   issuer run                                    the HTTP service (env config, README "Configuration")
//   issuer healthcheck                            exit 0 when the local service answers /healthz
//   issuer keygen --dir D --from E --epochs N [--bits 2048|3072] [--purpose badge|starter]
//                                                 OFFLINE: one RSA key per epoch E..E+N-1 (epoch-<E>.pem 0600 + manifest.json)
//   issuer publish-keys --dir D --identity-file critical.json --contract C --network N [--min-ahead 3] [--purpose badge|starter]
//                                                 OFFLINE: publish the manifest's issuerKey documents (CRITICAL key), the current
//                                                 epoch's too while it can land before S(E+1) - margin (src/publish.ts)
//   issuer revoke --epoch E [--through E2] --from-height H --identity-file critical.json --contract C --network N [--yes]
//                                                 OFFLINE: publish issuerRevocation documents (CRITICAL key); a dry run without --yes
//   issuer epoch --network N --height H           print the epoch schedule around height H
import { parseArgs } from 'node:util';
import { EPOCH_PARAMS, epochOf, epochStart, isNetwork, keyDeadline, type BadgeNetwork } from '@govhub/badge';
import { readIdentityKeyFile } from './config.ts';
import { assertPurpose, bindPublisher, isKeyPurpose, keygen, readManifest, type KeyPurpose } from './keys.ts';
import { errText } from './log.ts';
import { publishExitCode, publishKeys } from './publish.ts';
import { parseEpochRange, revokeEpochs } from './revoke.ts';

const [cmd, ...rest] = process.argv.slice(2);

function net(v: string | undefined): BadgeNetwork {
  if (!isNetwork(v)) throw new Error('--network must be mainnet, testnet, devnet or regtest');
  return v;
}
function purpose(v: string | undefined): KeyPurpose {
  if (!isKeyPurpose(v)) throw new Error('--purpose must be badge or starter');
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
      const { values } = parseArgs({ args: rest, options: { dir: { type: 'string' }, from: { type: 'string' }, epochs: { type: 'string' }, bits: { type: 'string', default: '2048' }, purpose: { type: 'string', default: 'badge' } } });
      if (!values.dir) throw new Error('--dir is required');
      const bits = Number(values.bits);
      if (bits !== 2048 && bits !== 3072) throw new Error('--bits must be 2048 or 3072');
      const added = await keygen(values.dir, num(values.from, '--from'), num(values.epochs, '--epochs'), bits, purpose(values.purpose));
      for (const a of added) console.log(JSON.stringify({ epoch: a.epoch, bits: a.bits, keyId: a.keyId }));
      console.error(`${added.length} new key(s) in ${values.dir}; private keys are epoch-<E>.pem (0600). Copy to the server only the epochs it may hold.`);
      return;
    }
    case 'publish-keys': {
      const { values } = parseArgs({
        args: rest,
        options: { dir: { type: 'string' }, 'identity-file': { type: 'string' }, contract: { type: 'string' }, network: { type: 'string' }, 'min-ahead': { type: 'string', default: '3' }, purpose: { type: 'string', default: 'badge' } },
      });
      if (!values.dir || !values['identity-file'] || !values.contract) throw new Error('--dir, --identity-file and --contract are required');
      const network = net(values.network);
      const p = EPOCH_PARAMS[network];
      const key = readIdentityKeyFile(values['identity-file']);
      if (key.keyId !== 1) console.error('warning: issuerKey documents need a CRITICAL key (keyId 1 in the standard layout)');
      const existing = readManifest(values.dir);
      if (!existing.length) throw new Error(`no manifest.json in ${values.dir}; run keygen first`);
      // a starter key published under the badge identity (or the reverse) would sign the wrong thing: refuse a mixed-up directory,
      // and one published before under another identity (checked offline, before anything connects)
      assertPurpose(existing, purpose(values.purpose));
      const manifest = bindPublisher(values.dir, key.identityId);
      const { connectPlatform } = await import('./platform.ts');
      const platform = await connectPlatform(network === 'mainnet' ? 'mainnet' : 'testnet', values.contract);
      const height = await platform.coreHeight();
      const issuing = epochOf(p, height); // the current epoch is issued too (Standard mode)
      console.error(`platform core height ${height}: issuing for epoch ${issuing}`);
      const results = await publishKeys(platform, key, manifest, p);
      for (const r of results) console.log(JSON.stringify(r));
      const minAhead = num(values['min-ahead'], '--min-ahead');
      // Consecutive epochs after the issuing one that already have a key.
      let ahead = 0;
      for (let e = issuing + 1; await platform.issuerKey(key.identityId, e); e++) ahead++;
      const now = (await platform.issuerKey(key.identityId, issuing))
        ? 'has a key'
        : `has NO key: Standard mode is unavailable until one lands before height ${keyDeadline(p, issuing)}. If manifest.json lacks it, run \`issuer keygen --dir ${values.dir} --from ${issuing} --epochs 1 --purpose ${purpose(values.purpose)}\`, publish again, and copy epoch-${issuing}.pem to the server`;
      console.error(`issuing epoch ${issuing} ${now}; ${ahead} consecutive later epoch(s) have keys (${ahead >= minAhead ? 'ok' : `FEWER than ${minAhead}: publish more`})`);
      process.exit(publishExitCode(results));
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
      console.log(JSON.stringify({ height: h, epoch: e, S: epochStart(p, e), next: epochStart(p, e + 1), issuingFor: [e, e + 1], keyDeadline: keyDeadline(p, e), keyDeadlineForNext: keyDeadline(p, e + 1), params: p }));
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
