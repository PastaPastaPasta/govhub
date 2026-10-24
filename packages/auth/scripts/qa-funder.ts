// Test tooling: the EvoVote QA wallet as an "external wallet" that pays deposit addresses and mints vouchers on TESTNET.
// Its key never leaves ~/.local/share/evovote-v2-qa-20261018/. The current UTXO is tracked in ~/.local/share/govhub-phase2/funder.json
// (seeded once from testnet Insight, tooling only); payments are built with @govhub/auth's tx code and broadcast over DAPI.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTx, type Dapi } from '@govhub/dapi';
import { addressOf, buildAssetLock, buildPayment, buildProposalCollateral, hash160, hexToBytes, p2pkhScript, publicKeyOf, randomBytes, wifOf } from '../src/index.ts';

const QA = join(homedir(), '.local/share/evovote-v2-qa-20261018');
export const PHASE2_DIR = join(homedir(), '.local/share/govhub-phase2');
const FILE = join(PHASE2_DIR, 'funder.json');
const INSIGHT = 'https://insight.testnet.networks.dash.org/insight-api';

interface FunderState {
  utxo?: { txid: string; vout: number; value: string };
  spentDuffs: string;
  feesDuffs: string;
  log: Array<{ at: string; what: string; txid: string; duffs: string; fee: string }>;
}

export function writePrivate(path: string, data: unknown) {
  mkdirSync(PHASE2_DIR, { recursive: true, mode: 0o700 });
  chmodSync(PHASE2_DIR, 0o700);
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function qaFunder(dapi: Dapi) {
  const key = hexToBytes(readFileSync(join(QA, 'wallet.key'), 'utf8').trim());
  const address = readFileSync(join(QA, 'wallet-address.txt'), 'utf8').trim();
  if (addressOf(publicKeyOf(key), 'testnet') !== address) throw new Error('QA wallet key/address mismatch');
  const st: FunderState = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { spentDuffs: '0', feesDuffs: '0', log: [] };
  const save = () => writePrivate(FILE, st);

  async function utxo() {
    if (st.utxo) return { ...st.utxo, value: BigInt(st.utxo.value) };
    const r = await fetch(`${INSIGHT}/addr/${address}/utxo`, { headers: { 'user-agent': 'curl/8.7.1' } });
    const u = ((await r.json()) as Array<{ txid: string; vout: number; satoshis: number }>).sort((a, b) => b.satoshis - a.satoshis)[0];
    if (!u) throw new Error('QA wallet is empty');
    return { txid: u.txid, vout: u.vout, value: BigInt(u.satoshis) };
  }
  function record(what: string, txid: string, duffs: bigint, fee: bigint, change: { vout: number; value: bigint } | null) {
    st.utxo = change ? { txid, vout: change.vout, value: change.value.toString() } : undefined;
    st.spentDuffs = (BigInt(st.spentDuffs) + duffs).toString();
    st.feesDuffs = (BigInt(st.feesDuffs) + fee).toString();
    st.log.push({ at: new Date().toISOString(), what, txid, duffs: duffs.toString(), fee: fee.toString() });
    save();
  }

  return {
    address,
    state: () => ({ spentDuffs: BigInt(st.spentDuffs), feesDuffs: BigInt(st.feesDuffs) }),
    /** Pays `duffs` to a P2PKH address (what a user's wallet does after scanning the QR). */
    async pay(toAddressHash160: Uint8Array, duffs: bigint, what = 'payment'): Promise<string> {
      const u = await utxo();
      const p = buildPayment({ utxos: [u], key, to: [{ pubKeyHash: toAddressHash160, duffs }] });
      await dapi.broadcastTransaction(p.raw);
      const out = p.changeVout === null ? null : parseTx(p.raw).outputs[p.changeVout]!.value;
      record(what, p.txid, duffs, u.value - duffs - (out ?? 0n), out === null ? null : { vout: p.changeVout!, value: out });
      return p.txid;
    },
    /** A proposal collateral: 1 tDASH burnt in OP_RETURN <gov hash, raw order>. */
    async payCollateral(govHashRaw: Uint8Array): Promise<string> {
      const u = await utxo();
      const p = buildProposalCollateral({ utxos: [u], key, govHashRaw });
      await dapi.broadcastTransaction(p.raw);
      const out = p.changeVout === null ? null : parseTx(p.raw).outputs[p.changeVout]!.value;
      record('proposal collateral', p.txid, 100_000_000n, u.value - 100_000_000n - (out ?? 0n), out === null ? null : { vout: p.changeVout!, value: out });
      return p.txid;
    },
    /** A starter voucher shaped like dash-faucet-cf's (change first, so the burn is at vout 1). Returns the dashpay:// link. */
    async mintVoucher(lockDuffs: bigint): Promise<{ link: string; txid: string; burnVout: number }> {
      const u = await utxo();
      const vkey = randomBytes(32);
      const b = buildAssetLock({ utxos: [u], fundingKey: key, creditPubKeyHash: hash160(publicKeyOf(vkey)), lockDuffs, change: { script: p2pkhScript(hash160(publicKeyOf(key))), duffs: u.value - lockDuffs - 1000n } });
      await dapi.broadcastTransaction(b.raw);
      record('voucher', b.txid, lockDuffs, b.feeDuffs, { vout: 0, value: u.value - lockDuffs - b.feeDuffs });
      return { link: `dashpay://invite?assetlocktx=${b.txid}&pk=${wifOf(vkey, 'testnet')}&islock=null`, txid: b.txid, burnVout: b.burnVout };
    },
  };
}
