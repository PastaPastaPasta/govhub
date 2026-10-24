// @govhub/dapi: browser-first grpc-web client for DAPI Core on Dash evonodes.
// BLS ChainLock verification is in '@govhub/dapi/bls' and X11 header hashing in '@govhub/dapi/x11' (separate entry points).
export { Dapi, createDapi } from './client.ts';
export type {
  AgreedSml, CallOptions, DapiOptions, DepositEvent, GetVerifiedTransactionOptions, IsLockEvent, Tristate, VerifiedTransaction,
  Verifiers, WatchHandlers, WatchOptions, Watcher,
} from './client.ts';
export { AllNodesFailedError, GrpcError, VerificationError } from './errors.ts';
export { DapiCore } from './core.ts';
export type { BlockchainStatus, HeadersEvent, StreamStart, TransactionClaims, TxStreamEvent } from './core.ts';
export { DEFAULT_STREAM_IDLE_MS, FrameParser, frame, stream, unary } from './grpcweb.ts';
export type { RateInfo, StreamClose, StreamHandle, StreamOptions, UnaryOptions } from './grpcweb.ts';
export { MAINNET_NODE_LIST, TESTNET_NODE_LIST, fetchNodes, isEndpoint, sample } from './nodes.ts';
export { NodePool, backoffMs } from './pool.ts';
export type { PoolOptions } from './pool.ts';
export { mergeStreams, race } from './race.ts';
export type { MergeStats, RaceResult } from './race.ts';
export { BLOOM_UPDATE_ALL, BLOOM_UPDATE_NONE, BLOOM_UPDATE_P2PUBKEY_ONLY, BloomFilter, MIN_BLOOM_BYTES, matchAllFilter } from './bloom.ts';
export type { BloomFilterData } from './bloom.ts';
export { LLMQ_TYPE, parseSml, quorumsOfType } from './sml.ts';
export type { Sml, SmlEvonode, SmlQuorum } from './sml.ts';
export { decodeCbor } from './cbor.ts';
export {
  classifyScript, coinbaseHeight, parseBlock, parseChainLock, parseHeader, parseInstantLock, parseMerkleBlock, parseTx, readTx,
} from './dash.ts';
export type { Block, BlockHeader, ChainLock, InstantLock, MerkleBlock, ScriptClass, Tx, TxIn, TxOut } from './dash.ts';
export {
  CHAINLOCK_PARAMS, SIGN_HEIGHT_OFFSET, chainLockCandidateSets, chainLockRequestId, chainLockSignHash, quorumScore, selectQuorum,
} from './chainlock.ts';
export type { CandidateSets, ChainLockParams, Network } from './chainlock.ts';
export { Reader, hex, hashBytes, hashHex, reversed, sha256d, unhex } from './bytes.ts';
