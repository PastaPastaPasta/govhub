// DAPI subscribeToMasternodeList: each message is a CBOR-encoded SimplifiedMNListDiff (hashes are display-order hex strings).
// The first message is a diff against the all-zero base block, i.e. the full list at the tip.
// Shape written by Core in src/evo/core_write.cpp (CSimplifiedMNListDiff::ToJson), quorum fields by CFinalCommitment::ToJson.
import { sha256d, hex, unhex } from './bytes.ts';
import { type Cbor, decodeCbor } from './cbor.ts';
import { coinbaseHeight, parseTx } from './dash.ts';
import { isEndpoint } from './nodes.ts';

/** Core's LLMQType enum (src/llmq/params.h). */
export const LLMQ_TYPE = { LLMQ_50_60: 1, LLMQ_400_60: 2, LLMQ_400_85: 3, LLMQ_100_67: 4, LLMQ_60_75: 5 } as const;

export interface SmlQuorum {
  llmqType: number;
  /** Display-order hash of the quorum base block (the block at the start of the DKG cycle). */
  quorumHash: string;
  quorumIndex: number;
  /** 48-byte BLS public key, hex. */
  quorumPublicKey: string;
  quorumVvecHash: string;
  /** Height of the quorum base block: filled in by the client (one getBlock per quorum), not part of the SML. */
  baseHeight?: number;
}

export interface SmlEvonode { proTxHash: string; endpoint: string }

/** One registered masternode as the SML lists it (banned ones included, `isValid` false). Governance votes are checked against `votingAddress`. */
export interface SmlMasternode {
  /** Display-order hash of the ProRegTx. */
  proTxHash: string;
  /** Base58 P2PKH address of the voting key (keyIDVoting). */
  votingAddress: string;
  /** 0 regular, 1 evonode. */
  nType: number;
  /** Not PoSe-banned. */
  isValid: boolean;
}

export interface Sml {
  /** Display-order hash of the block the list is valid at (the node's tip when the stream was opened). */
  blockHash: string;
  /** Height of that block from its coinbase payload (a node claim: same trust as the rest of the list). */
  height: number | null;
  baseBlockHash: string;
  merkleRootMNList: string;
  merkleRootQuorums: string;
  mnCount: number;
  validMnCount: number;
  evonodeCount: number;
  quorums: SmlQuorum[];
  /** Valid evonodes that advertise a `platform_https` endpoint. */
  evonodes: SmlEvonode[];
  /** Every masternode with a well-formed entry (proTxHash, voting address, type, validity). */
  masternodes: SmlMasternode[];
  /** sha256 over every field govhub relies on (tip, roots, quorum keys, evonode endpoints, masternode voting addresses/types/validity): equal digests = identical content. */
  digest: string;
}

type Obj = { [k: string]: Cbor };
const isObj = (v: Cbor | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
const str = (o: Obj, k: string): string => { const v = o[k]; if (typeof v !== 'string') throw new Error(`sml: ${k} is not a string`); return v; };
const hexOf = (o: Obj, k: string, bytes: number): string => {
  const v = str(o, k);
  if (v.length !== bytes * 2 || !/^[0-9a-f]+$/i.test(v)) throw new Error(`sml: ${k} is not ${bytes} bytes of hex`);
  return v.toLowerCase();
};
const int = (o: Obj, k: string): number => { const v = o[k]; if (typeof v !== 'number') throw new Error(`sml: ${k} is not a number`); return v; };
const arr = (o: Obj, k: string): Cbor[] => { const v = o[k]; if (!Array.isArray(v)) throw new Error(`sml: ${k} is not an array`); return v; };

export function parseSml(bytes: Uint8Array): Sml {
  const d = decodeCbor(bytes);
  if (!isObj(d)) throw new Error('sml: not a map');
  const blockHash = hexOf(d, 'blockHash', 32), baseBlockHash = hexOf(d, 'baseBlockHash', 32);
  const merkleRootMNList = hexOf(d, 'merkleRootMNList', 32), merkleRootQuorums = hexOf(d, 'merkleRootQuorums', 32);

  const mnList = arr(d, 'mnList');
  const evonodes: SmlEvonode[] = [];
  const masternodes: SmlMasternode[] = [];
  let validMnCount = 0, evonodeCount = 0;
  for (const m of mnList) {
    if (!isObj(m)) throw new Error('sml: bad masternode entry');
    const valid = m.isValid === true;
    if (valid) validMnCount++;
    if (typeof m.proRegTxHash === 'string' && /^[0-9a-f]{64}$/i.test(m.proRegTxHash) && typeof m.votingAddress === 'string' && typeof m.nType === 'number') {
      masternodes.push({ proTxHash: m.proRegTxHash.toLowerCase(), votingAddress: m.votingAddress, nType: m.nType, isValid: valid });
    }
    if (m.nType !== 1) continue;
    evonodeCount++;
    const a = isObj(m.addresses) ? m.addresses : undefined;
    const p = a && Array.isArray(a.platform_https) ? a.platform_https[0] : undefined;
    if (valid && isEndpoint(p)) evonodes.push({ proTxHash: str(m, 'proRegTxHash'), endpoint: p }); // anything else never becomes a request URL
  }

  const quorums: SmlQuorum[] = arr(d, 'newQuorums').map((q) => {
    if (!isObj(q)) throw new Error('sml: bad quorum entry');
    return {
      llmqType: int(q, 'llmqType'), quorumHash: hexOf(q, 'quorumHash', 32), quorumIndex: typeof q.quorumIndex === 'number' ? q.quorumIndex : 0,
      quorumPublicKey: hexOf(q, 'quorumPublicKey', 48), quorumVvecHash: hexOf(q, 'quorumVvecHash', 32),
    };
  });

  let height: number | null = null;
  if (typeof d.cbTx === 'string') {
    try { height = coinbaseHeight(parseTx(unhex(d.cbTx))); } catch { height = null; }
  }

  const canon = [
    blockHash, height, merkleRootMNList, merkleRootQuorums, mnList.length, validMnCount,
    ...quorums.map((q) => `${q.llmqType}:${q.quorumHash}:${q.quorumIndex}:${q.quorumPublicKey}:${q.quorumVvecHash}`).sort(),
    ...evonodes.map((e) => `${e.proTxHash}@${e.endpoint}`).sort(),
    ...masternodes.map((m) => `mn:${m.proTxHash}:${m.votingAddress}:${m.nType}:${m.isValid ? 1 : 0}`).sort(),
  ].join('\n');
  return {
    blockHash, height, baseBlockHash, merkleRootMNList, merkleRootQuorums, mnCount: mnList.length, validMnCount, evonodeCount,
    quorums, evonodes, masternodes, digest: hex(sha256d(new TextEncoder().encode(canon))),
  };
}

export const quorumsOfType = (sml: Sml, llmqType: number): SmlQuorum[] => sml.quorums.filter((q) => q.llmqType === llmqType);
