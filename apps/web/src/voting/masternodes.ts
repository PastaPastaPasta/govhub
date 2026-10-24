// Which masternodes a voting key controls (PLAN §5.1, the keyring's "add my masternodes").
//
// Trust: the key -> masternode match comes from the DAPI SML that several evonodes agreed on (proTxHash, voting address, type,
// validity); one key can control several masternodes. The SML has no collateral outpoint, which a vote must name: it comes from the
// bridge's list, and is then proved by the ProRegTx itself (its bytes hash to the proTxHash, and a masternode's collateral never
// changes after registration). The bridge's list alone is used, and labelled as such, only when no SML is available (fixtures).
import { bytesToHex, decodeAddress, hash160, parseProRegTx, p2pkhAddress, payoutScriptAddress, type Network } from '@govhub/verify';
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
        provenance: { key: 'sml', collateral: b.collateralTxid.toLowerCase() === pro.toLowerCase() ? 'protx' : 'bridge' },
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

/**
 * Checks each masternode's outpoint (and reads its registered payout) against its ProRegTx. `fetchRaw` returns the raw transaction
 * for a txid (DAPI getTransaction). A ProRegTx whose bytes do not hash to the proTxHash, or name another collateral, marks the
 * masternode `collateral: 'bridge'` and `mismatch` (the bridge lied or lags): such a masternode is not offered for voting.
 */
export async function proveCollaterals(mns: OwnedMasternode[], fetchRaw: (txid: string) => Promise<Uint8Array>, network: Network): Promise<{ mns: OwnedMasternode[]; mismatch: string[] }> {
  const mismatch: string[] = [];
  const out = await Promise.all(
    mns.map(async (m) => {
      try {
        const p = parseProRegTx(await fetchRaw(m.proTxHash));
        if (p.proTxHash !== m.proTxHash || p.collateralTxid !== m.collateralTxid.toLowerCase() || p.collateralIndex !== m.collateralIndex) {
          mismatch.push(m.proTxHash);
          return { ...m, provenance: { ...m.provenance, collateral: 'bridge' as const } };
        }
        const payout = p.registered ? payoutScriptAddress(p.registered.payoutScript, network) : null;
        return { ...m, ...(payout ? { payoutAddress: payout } : {}), provenance: { ...m.provenance, collateral: 'protx' as const } };
      } catch {
        return m; // unreachable node: keep the bridge's word, labelled
      }
    }),
  );
  return { mns: out.filter((m) => !mismatch.includes(m.proTxHash)), mismatch };
}
