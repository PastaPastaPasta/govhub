// DAPI subscribeToMasternodeList: each message is a CBOR-encoded SimplifiedMNListDiff (JSON-ish: hashes are hex strings).
// The first message is a diff against the all-zero base block = the full list at the tip.
import { decodeCbor } from './cbor.js';

export const LLMQ_TYPE = { LLMQ_50_60: 1, LLMQ_400_60: 2, LLMQ_400_85: 3, LLMQ_100_67: 4, LLMQ_60_75: 5 };

export function parseMasternodeListDiff(bytes) {
  const d = decodeCbor(bytes);
  const evonodes = d.mnList.filter((m) => m.nType === 1);
  return {
    diff: d,
    blockHash: d.blockHash,
    baseBlockHash: d.baseBlockHash,
    merkleRootMNList: d.merkleRootMNList,
    mnCount: d.mnList.length,
    validMnCount: d.mnList.filter((m) => m.isValid).length,
    evonodeCount: evonodes.length,
    quorumCount: d.newQuorums.length,
    /** evonode platform_https endpoints from the SML itself (no quorum-service needed once bootstrapped) */
    platformEndpoints: () => evonodes.filter((m) => m.isValid && m.addresses?.platform_https?.length).map((m) => m.addresses.platform_https[0]),
    quorumsOfType: (llmqType) => d.newQuorums.filter((q) => q.llmqType === llmqType),
  };
}
