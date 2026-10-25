// Which masternodes a voting key controls (PLAN §5.1, the keyring's "add my masternodes").
//
// Trust: the key -> masternode match comes from the DAPI SML that several evonodes agreed on (proTxHash, voting address, type,
// validity); one key can control several masternodes. The SML has no collateral outpoint, which a vote must name: it comes from the
// bridge's list, and is then proved by the ProRegTx itself (its bytes hash to the proTxHash, and a masternode's collateral never
// changes after registration). The bridge's list alone is used, and labelled as such, only when no SML is available (fixtures).
import { hexToBytes, isValidPrivateKey } from '@govhub/auth';
import { bytesToHex, decodeAddress, decodeWif, hash160, parseProRegTx, p2pkhAddress, payoutScriptAddress, type Network } from '@govhub/verify';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { BridgeMasternode } from '../data/bridge.ts';
import type { SmlEntry } from '../verify/votes.ts';

export interface KeyRef {
  /** index into the keyring's key list */
  index: number;
  /** hash160 of the (compressed, unless flagged otherwise) public key = keyIDVoting, hex */
  keyId: string;
}

export interface OwnedMasternode {
  proTxHash: string;
  collateralTxid: string;
  collateralIndex: number;
  type: 'regular' | 'evo';
  /** not PoSe-banned: voteraw refuses banned masternodes (GetValidMNByCollateral) */
  valid: boolean;
  votingAddress: string;
  keyIndex: number;
  /** registered payout address (ProTx v1/v2), when the ProRegTx was read */
  payoutAddress?: string;
  provenance: {
    /** 'sml': the DAPI-agreed SML lists this voting key for the proTxHash; 'bridge': only the bridge says so */
    key: 'sml' | 'bridge';
    /** 'protx': the outpoint is the one in the ProRegTx bytes; 'bridge': bridge-reported */
    collateral: 'protx' | 'bridge';
  };
}

export function votingKeyId(privateKey: Uint8Array, compressed: boolean): string {
  return bytesToHex(hash160(secp256k1.getPublicKey(privateKey, compressed)));
}

export const votingAddressOf = (privateKey: Uint8Array, compressed: boolean, network: Network): string => p2pkhAddress(hash160(secp256k1.getPublicKey(privateKey, compressed)), network);

const keyIdOfAddress = (addr: string, network: Network): string | null => {
  const d = decodeAddress(addr, network);
  return d && d.type === 'p2pkh' ? bytesToHex(d.hash160) : null;
};

/**
 * Masternodes whose CURRENT voting key is one of `keys`. With an SML, it decides (key, type, validity) and a bridge entry that
 * disagrees is ignored; masternodes the SML lists but the bridge does not are returned without an outpoint (`missing`), they
 * cannot be voted with until the bridge catches up.
 */
export function matchMasternodes(keys: readonly KeyRef[], bridge: readonly BridgeMasternode[], sml: ReadonlyMap<string, SmlEntry> | null, network: Network): { owned: OwnedMasternode[]; missing: string[] } {
  const byKey = new Map(keys.map((k) => [k.keyId, k.index]));
  const owned: OwnedMasternode[] = [];
  const missing: string[] = [];
  const bridgeByPro = new Map(bridge.map((b) => [b.proTxHash.toLowerCase(), b]));
  if (sml) {
    for (const [pro, e] of sml) {
      const kid = keyIdOfAddress(e.votingAddress, network);
      if (!kid || !byKey.has(kid)) continue;
      const b = bridgeByPro.get(pro.toLowerCase());
      if (!b) {
        missing.push(pro.toLowerCase());
        continue;
      }
      owned.push({
        proTxHash: pro.toLowerCase(),
        collateralTxid: b.collateralTxid,
        collateralIndex: b.collateralIndex,
        type: e.nType === 1 ? 'evo' : 'regular',
        valid: e.isValid,
        votingAddress: e.votingAddress,
        keyIndex: byKey.get(kid)!,
        // the outpoint is the bridge's until proveCollaterals reads the ProRegTx (a self-collateral txid says nothing about the index)
        provenance: { key: 'sml', collateral: 'bridge' },
      });
    }
  } else {
    for (const b of bridge) {
      const kid = keyIdOfAddress(b.votingAddress, network);
      if (!kid || !byKey.has(kid)) continue;
      owned.push({ proTxHash: b.proTxHash, collateralTxid: b.collateralTxid, collateralIndex: b.collateralIndex, type: b.type, valid: b.valid, votingAddress: b.votingAddress, keyIndex: byKey.get(kid)!, provenance: { key: 'bridge', collateral: 'bridge' } });
    }
  }
  owned.sort((a, b) => a.keyIndex - b.keyIndex || (a.proTxHash < b.proTxHash ? -1 : 1));
  return { owned, missing };
}

/** Requests in flight at once while reading ProRegTxs, and the random pause before each (so they do not arrive as one burst). */
export const PROTX_FETCH = { concurrency: 6, jitterMs: 250, maxDecoys: 8 };

/**
 * Checks each masternode's outpoint (and reads its registered payout) against its ProRegTx. `fetchRaw` returns the raw transaction
 * for a txid (DAPI getTransaction). A ProRegTx whose bytes do not hash to the proTxHash, or name another collateral, marks the
 * masternode `collateral: 'bridge'` and `mismatch` (the bridge lied or lags): such a masternode is not offered for voting.
 *
 * Privacy: the reads are mixed with `decoys` (other masternodes' ProRegTxs, read and discarded) in random order, a few at a time with
 * random pauses, so the DAPI nodes asked do not see exactly one owner's masternodes arrive together.
 */
export async function proveCollaterals(
  mns: OwnedMasternode[],
  fetchRaw: (txid: string) => Promise<Uint8Array>,
  network: Network,
  o: { decoys?: readonly string[]; pause?: (ms: number) => Promise<void>; random?: () => number } = {},
): Promise<{ mns: OwnedMasternode[]; mismatch: string[] }> {
  const random = o.random ?? Math.random;
  const pause = o.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const queue = [...new Set([...mns.map((m) => m.proTxHash), ...(o.decoys ?? []).slice(0, PROTX_FETCH.maxDecoys)])];
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [queue[i], queue[j]] = [queue[j]!, queue[i]!];
  }
  const raws = new Map<string, Uint8Array | null>();
  await Promise.all(
    Array.from({ length: Math.min(PROTX_FETCH.concurrency, queue.length) }, async () => {
      for (let h = queue.shift(); h !== undefined; h = queue.shift()) {
        await pause(Math.floor(random() * PROTX_FETCH.jitterMs));
        raws.set(h, await fetchRaw(h).catch(() => null));
      }
    }),
  );
  const mismatch: string[] = [];
  const out = mns.map((m) => {
    const raw = raws.get(m.proTxHash);
    if (!raw) return m; // unreachable node: keep the bridge's word, labelled
    try {
      const p = parseProRegTx(raw);
      if (p.proTxHash !== m.proTxHash || p.collateralTxid !== m.collateralTxid.toLowerCase() || p.collateralIndex !== m.collateralIndex) {
        mismatch.push(m.proTxHash);
        return { ...m, provenance: { ...m.provenance, collateral: 'bridge' as const } };
      }
      const payout = p.registered ? payoutScriptAddress(p.registered.payoutScript, network) : null;
      return { ...m, ...(payout ? { payoutAddress: payout } : {}), provenance: { ...m.provenance, collateral: 'protx' as const } };
    } catch {
      return m;
    }
  });
  return { mns: out.filter((m) => !mismatch.includes(m.proTxHash)), mismatch };
}

/** Other masternodes to read along with ours (proveCollaterals `decoys`): a random sample of the list, at least 3. */
export function pickDecoys(all: readonly string[], owned: readonly string[], random: () => number = Math.random): string[] {
  const mine = new Set(owned.map((x) => x.toLowerCase()));
  const pool = all.filter((h) => !mine.has(h.toLowerCase()));
  const n = Math.min(pool.length, PROTX_FETCH.maxDecoys, Math.max(3, owned.length));
  const out: string[] = [];
  while (out.length < n) {
    const h = pool.splice(Math.floor(random() * pool.length), 1)[0]!;
    out.push(h);
  }
  return out;
}

/**
 * A pasted voting key: WIF of this Core network, or 64 hex characters. The bytes are wiped when the input is refused. A WIF of the
 * other network gets its own message (it is the wrong masternode's key, or the wrong profile).
 */
export function parseVotingKey(input: string, network: 'mainnet' | 'testnet'): { privateKey: Uint8Array; compressed: boolean } {
  const t = input.trim();
  if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(t)) {
    const privateKey = hexToBytes(t.replace(/^0x/, ''));
    if (!isValidPrivateKey(privateKey)) {
      privateKey.fill(0);
      throw new Error('That is not a valid private key.');
    }
    return { privateKey, compressed: true };
  }
  try {
    const { privKey, compressed } = decodeWif(t, network);
    return { privateKey: privKey, compressed };
  } catch {
    /* tried below for the other network */
  }
  const other = network === 'mainnet' ? 'testnet' : 'mainnet';
  try {
    decodeWif(t, other).privKey.fill(0);
  } catch {
    throw new Error(`Enter the voting key as a ${network} WIF (or 64 hex characters).`);
  }
  throw new Error(`That is a ${other} key, but this profile votes on ${network} Core. Paste the ${network} masternode's voting key, or switch the profile in Settings.`);
}

/**
 * What a pasted key is, from the masternode list, BEFORE it is saved anywhere (D-023). `owned`: the masternodes whose voting key it
 * is (lookupMasternodes for this key alone). Collateral and payout keys are refused whatever else they are: they hold money.
 */
export function keyRole(
  address: string,
  list: ReadonlyArray<Pick<BridgeMasternode, 'proTxHash' | 'collateralAddress' | 'payoutAddress'>>,
  owned: ReadonlyArray<Pick<OwnedMasternode, 'proTxHash' | 'payoutAddress'>>,
): { kind: 'voting'; count: number } | { kind: 'collateral' | 'payout' | 'none'; message: string } {
  const short = (h: string) => `${h.slice(0, 12)}…`;
  const coll = list.find((m) => m.collateralAddress === address);
  if (coll)
    return {
      kind: 'collateral',
      message: `This is the collateral key of masternode ${short(coll.proTxHash)}: it can spend the masternode's collateral. It was not saved. Never paste it into a website; paste that masternode's voting key instead (Dash Core: protx info, votingAddress).`,
    };
  const pay = list.find((m) => m.payoutAddress === address) ?? owned.find((m) => m.payoutAddress === address);
  if (pay)
    return {
      kind: 'payout',
      message: `This is the payout key of masternode ${short(pay.proTxHash)}: it can spend the masternode's rewards. It was not saved. Use a voting key that holds no funds (set one with protx update_registrar if the voting and payout keys are the same).`,
    };
  if (owned.length) return { kind: 'voting', count: owned.length };
  return { kind: 'none', message: 'This key is not the voting key of any registered masternode (it may be an owner key, or the masternode is not in the list yet). It was not saved.' };
}
