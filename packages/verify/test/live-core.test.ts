// Live cross-check against a running Dash Core regtest node. SKIPPED unless DASH_CLI is set, e.g.
//   DASH_CLI="/path/dash-cli -datadir=/tmp/x -regtest -rpcport=19877 -rpcuser=gh -rpcpassword=gh" npx vitest run test/live-core.test.ts
// Needs wallet "w" (funded, descriptor or legacy) for the gobject prepare cases.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { buildProposalDataHex, bytesToHex, concatBytes, encodeAddress, encodeWif, governanceObjectHash, hexToBytes, recoverMessageSigner, signMessage, signVote, utf8ToBytes, validateProposalData, voteSignatureString, VOTE_OUTCOME, VOTE_SIGNAL, hash160, type ProposalFields } from '../src/index.ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const CLI = (process.env.DASH_CLI ?? '').split(/\s+/).filter(Boolean);
const live = CLI.length > 0;

function cli(args: string[], wallet?: string): { ok: boolean; out: string } {
  const [bin, ...base] = CLI;
  try {
    const out = execFileSync(bin!, [...base, ...(wallet ? [`-rpcwallet=${wallet}`] : []), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch (e: any) {
    return { ok: false, out: String(e.stderr ?? e.message).trim() };
  }
}

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!live)('live Dash Core cross-check (regtest)', () => {
  const rand = rng(Number(process.env.FUZZ_SEED ?? 0xdec0de));
  const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)]!;
  const randHex20 = () => Uint8Array.from({ length: 20 }, () => Math.floor(rand() * 256));

  it('vote signatures from signVote verify in Core `verifymessage` (message scheme), also with uncompressed keys and high-S twins', () => {
    let n = 0;
    for (let i = 0; i < 12; i++) {
      const priv = secp256k1.utils.randomSecretKey();
      const compressed = i % 4 !== 3;
      const pub = secp256k1.getPublicKey(priv, compressed);
      const address = encodeAddress('p2pkh', hash160(pub), 'regtest');
      const vote = {
        collateralTxid: bytesToHex(Uint8Array.from({ length: 32 }, () => Math.floor(rand() * 256))),
        collateralIndex: Math.floor(rand() * 5),
        govHashDisplay: bytesToHex(Uint8Array.from({ length: 32 }, () => Math.floor(rand() * 256))),
        signal: VOTE_SIGNAL.FUNDING,
        outcome: pick([VOTE_OUTCOME.YES, VOTE_OUTCOME.NO, VOTE_OUTCOME.ABSTAIN]),
        time: 1_760_000_000 + Math.floor(rand() * 1e6),
      };
      const s = signVote({ privKey: priv, vote, network: 'regtest', compressed });
      expect(s.signerAddress).toBe(address);
      const r = cli(['verifymessage', address, s.base64, voteSignatureString(vote)]);
      expect(r, r.out).toEqual({ ok: true, out: 'true' });
      // wrong message must fail in Core too
      expect(cli(['verifymessage', address, s.base64, voteSignatureString({ ...vote, time: BigInt(vote.time) + 1n })]).out).toBe('false');
      // high-S twin (Core's RecoverCompact does not reject it; neither do we by default)
      const sig = s.signature;
      const nOrder = secp256k1.Point.CURVE().n;
      const sBig = BigInt('0x' + bytesToHex(sig.subarray(33)));
      const twin = concatBytes(Uint8Array.of(27 + ((sig[0]! - 27) ^ 1)), sig.subarray(1, 33), hexToBytes((nOrder - sBig).toString(16).padStart(64, '0')));
      const rt = cli(['verifymessage', address, base64.encode(twin), voteSignatureString(vote)]);
      expect(rt.out).toBe('true');
      expect(recoverMessageSigner(twin, voteSignatureString(vote), 'regtest')?.address).toBe(address);
      n++;
    }
    expect(n).toBe(12);
  });

  it('signMessage verifies in Core for random messages incl. unicode and long ones', () => {
    for (let i = 0; i < 10; i++) {
      const priv = secp256k1.utils.randomSecretKey();
      const address = encodeAddress('p2pkh', hash160(secp256k1.getPublicKey(priv, true)), 'regtest');
      const msg = ['badge-request|' + i, 'h\u00e9llo \u2713 ' + i, 'x'.repeat(250 + i * 3), ''][i % 4]!;
      const sig = signMessage(priv, msg);
      expect(cli(['verifymessage', address, sig, msg]).out).toBe('true');
      void encodeWif;
    }
  });

  it('random proposals: our validateProposalData == Core gobject check, and built data hashes like list-prepared', () => {
    const chars = 'abcXYZ019-_.! /\u00e9';
    const now = Math.floor(Date.now() / 1000);
    const addr = encodeAddress('p2pkh', randHex20(), 'regtest');
    let agree = 0;
    for (let i = 0; i < 150; i++) {
      const name = Array.from({ length: Math.floor(rand() * 44) }, () => pick([...chars])).join('');
      const url = pick(['https://a.org/x', 'abc', 'http://[::1]/x', 'http://[::1/', 'ht tp://x', 'a:b', 'x://y]z', '//[', 'mailto:a@b.c', 'http://x.org/\u00a0']);
      const f: ProposalFields = {
        type: pick([1, 1, 1, 2, 0]),
        name,
        paymentAddress: pick([addr, addr, encodeAddress('p2sh', randHex20(), 'regtest'), encodeAddress('p2pkh', randHex20(), 'mainnet'), 'junk', ' ' + addr]),
        paymentAmount: pick([1, 0.5, 123456.789, 0, -3, 1e-8]),
        startEpoch: now + pick([0, 10, -100, 1000]),
        endEpoch: now + pick([0, 1000, 86400 * 400, -5]),
        url,
      };
      let hex: string;
      try {
        hex = buildProposalDataHex(f);
      } catch {
        continue;
      }
      const ours = validateProposalData(hex, 'regtest', { now });
      const core = cli(['gobject', 'check', hex]);
      expect(ours.valid, `${JSON.stringify(f)} ours=${ours.errors} core=${core.out}`).toBe(core.ok);
      agree++;
    }
    expect(agree).toBeGreaterThan(100);
  });

  it('fuzzed JSON bytes: our parser verdict == Core for mutated valid proposals', () => {
    const now = Math.floor(Date.now() / 1000);
    const addr = encodeAddress('p2pkh', randHex20(), 'regtest');
    const base = utf8ToBytes(
      `{"end_epoch":${now + 86400 * 100},"name":"fuzz-me","payment_address":"${addr}","payment_amount":5,"start_epoch":${now},"type":1,"url":"https://a.org/x","extra":[1,{"k":null}]}`,
    );
    let disagreements = 0;
    let valid = 0;
    for (let i = 0; i < Number(process.env.FUZZ_N ?? 400); i++) {
      const b = Array.from(base);
      const nMut = 1 + Math.floor(rand() * 3);
      for (let m = 0; m < nMut; m++) {
        const kind = Math.floor(rand() * 4);
        const at = Math.floor(rand() * b.length);
        if (kind === 0) b[at] = pick([...utf8ToBytes('{}[]",:\\ 0e-.tfnu')]);
        else if (kind === 1) b.splice(at, 1);
        else if (kind === 2) b.splice(at, 0, pick([...utf8ToBytes('{}[]",:\\ 0-.1')]));
        else b.length = Math.max(1, at); // truncate
      }
      const hex = bytesToHex(Uint8Array.from(b));
      const core = cli(['gobject', 'check', hex]).ok;
      const ours = validateProposalData(hex, 'regtest', { now }).valid;
      if (core) valid++;
      if (core !== ours) {
        disagreements++;
        console.error('DISAGREE', Buffer.from(b).toString('latin1'), { core, ours });
      }
    }
    expect(disagreements).toBe(0);
    expect(valid).toBeGreaterThan(20);
  });

  it('gobject prepare of our built data: list-prepared hash == governanceObjectHash', () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 4; i++) {
      const addr = encodeAddress('p2pkh', randHex20(), 'regtest');
      const hex = buildProposalDataHex({ type: 1, name: 'live-' + i, paymentAddress: addr, paymentAmount: 10 + i, startEpoch: now, endEpoch: now + 86400 * 90, url: 'https://x.org/' + i });
      const time = now + 7000 + i;
      const revision = 1 + i;
      const txid = cli(['gobject', 'prepare', '0', String(revision), String(time), hex], 'w');
      expect(txid.ok, txid.out).toBe(true);
      const list = JSON.parse(cli(['gobject', 'list-prepared', '200'], 'w').out) as Array<any>;
      const mine = list.find((o) => o.collateralHash === txid.out)!;
      expect(governanceObjectHash({ parentHash: '0', revision, time, dataHex: hex }).display).toBe(mine.objectHash);
    }
  });
});
