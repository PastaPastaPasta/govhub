// issuer CLI.
//   issuer run                                    the HTTP service (env config, README "Configuration")
//   issuer healthcheck                            exit 0 when the local service answers /healthz
//   issuer keygen --dir D --from E --epochs N [--bits 2048|3072]
//                                                 OFFLINE: one RSA key per epoch E..E+N-1 (epoch-<E>.pem 0600 + manifest.json)
//   issuer publish-keys --dir D --identity-file critical.json --contract C --network N [--min-ahead 3]
//                                                 OFFLINE: publish the manifest's issuerKey documents (CRITICAL key)
//   issuer epoch --network N --height H           print the epoch schedule around height H
import { parseArgs } from 'node:util';
import { EPOCH_PARAMS, epochStart, fromHex, isNetwork, issuingEpochAt, keyDeadline, type BadgeNetwork } from '@govhub/badge';
import { readIdentityKeyFile } from './config.ts';
import { keygen, manifestSpki, readManifest } from './keys.ts';
import { errText } from './log.ts';

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
      const issuing = issuingEpochAt(p, height);
      console.error(`platform core height ${height}: issuing for epoch ${issuing}`);
      for (const m of manifest) {
        const existing = await platform.issuerKey(key.identityId, m.epoch);
        if (existing) {
          const same = Buffer.from(existing.keyId).toString('hex') === m.keyId;
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
    case 'epoch': {
      const { values } = parseArgs({ args: rest, options: { network: { type: 'string' }, height: { type: 'string' } } });
      const p = EPOCH_PARAMS[net(values.network)];
      const h = num(values.height, '--height');
      const e = issuingEpochAt(p, h) - 1;
      console.log(JSON.stringify({ height: h, epoch: e, S: epochStart(p, e), next: epochStart(p, e + 1), issuingFor: e + 1, keyDeadlineForIssuing: keyDeadline(p, e + 1), params: p }));
      return;
    }
    default:
      console.error('usage: issuer run | healthcheck | keygen | publish-keys | epoch   (see src/cli.ts)');
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(`error: ${errText(e)}`);
  process.exit(1);
});
