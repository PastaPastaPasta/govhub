// Network profiles: coherent per-profile settings, the v1 -> v2 migration, and that everything Core-side is wired to the
// profile's Core network (DAPI nodes, ChainLock quorum type, vote signature scheme, address versions, funding coin type).
import { describe, expect, it, vi } from 'vitest';
import { CHAINLOCK_PARAMS } from '@govhub/dapi';
import { coinType } from '@govhub/auth';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, decodeAddress, hash160, p2pkhAddress, signVote, utf8ToBytes, VOTE_OUTCOME, VOTE_SIGNAL, voteSchemeFor } from '@govhub/verify';
import { verifyVotes } from '../verify/votes.ts';
import { dapiConfig } from '../data/dapi.ts';
import { createSource } from '../data/repo.ts';
import { GOV_PARAMS } from '../lib/governance.ts';
import {
  backendNotice,
  customFields,
  defaultRegistry,
  DEV_GOV_CONTRACT_ID,
  enabledBridges,
  LEGACY_STORAGE_KEY,
  loadRegistry,
  migrateV1,
  parseRegistry,
  PROFILES,
  profileRegistry,
  QUORUM_SERVICE,
  registryForProfile,
  registryScope,
  saveRegistry,
  TESTNET_FORUM,
  TESTNET_GOV_CONTRACT_ID,
  type Registry,
} from './registry.ts';

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

/** Settings exactly as version 1 saved them (registry.ts before profiles). */
const v1 = (over: Record<string, unknown> = {}) => ({
  version: 1,
  coreNetwork: 'mainnet',
  platformNetwork: 'testnet',
  dapi: { source: 'quorum', quorumUrl: QUORUM_SERVICE.mainnet, nodes: [] },
  platform: { trusted: true, addresses: [] },
  govContractId: DEV_GOV_CONTRACT_ID,
  bridges: [{ name: 'gov-bridge.dashhq.org', httpBase: 'https://gov-bridge.dashhq.org', govContractId: DEV_GOV_CONTRACT_ID, bridgeIdentityId: '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv', enabled: true }],
  relays: [],
  priceFeed: { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=dash&vs_currencies=usd' },
  accounts: null,
  faucet: { name: 'faucet.dashhq.org', url: 'https://faucet.dashhq.org' },
  forum: TESTNET_FORUM,
  ...over,
});

describe('relay defaults', () => {
  it('Dev uses the mainnet relay; an empty version 1 relay list is not kept as a custom override', () => {
    expect(defaultRegistry().relays.map((r) => r.url)).toEqual(['https://gov-relay.dashhq.org']);
    const m = migrateV1(v1());
    expect('relays' in m).toBe(false);
    expect(migrateV1(v1({ relays: [{ name: 'mine', url: 'https://relay.example.org' }] })).relays).toEqual([{ name: 'mine', url: 'https://relay.example.org' }]);
  });
});

describe('profiles', () => {
  it('Dev is the default: mainnet Core, testnet Platform, the Dev contract and bridge', () => {
    const d = defaultRegistry();
    expect(d).toMatchObject({ version: 2, profile: 'dev', coreNetwork: 'mainnet', platformNetwork: 'testnet', govContractId: DEV_GOV_CONTRACT_ID });
    expect(d.bridges.map((b) => b.httpBase)).toEqual(['https://gov-bridge.dashhq.org']);
    expect(d.dapi.quorumUrl).toBe(QUORUM_SERVICE.mainnet);
    expect(customFields(d).size).toBe(0);
  });

  it('Testnet is testnet end to end and shares the forum contracts with Dev', () => {
    const t = profileRegistry('testnet');
    expect(t).toMatchObject({ profile: 'testnet', coreNetwork: 'testnet', platformNetwork: 'testnet', govContractId: TESTNET_GOV_CONTRACT_ID });
    expect(t.dapi.quorumUrl).toBe('https://quorums.testnet.networks.dash.org/masternodes');
    expect(t.bridges.map((b) => b.httpBase)).toEqual(['https://gov-bridge-testnet.dashhq.org']);
    expect(t.forum).toEqual(defaultRegistry().forum);
    expect(parseRegistry(t).errors).toEqual([]);
  });

  it('Mainnet is listed but not deployed: it cannot be selected or imported', () => {
    expect(PROFILES.mainnet.deployed).toBe(false);
    expect(() => registryForProfile(defaultRegistry(), 'mainnet')).toThrow(/not deployed/);
    expect(parseRegistry({ ...defaultRegistry(), profile: 'mainnet' }).errors.join()).toMatch(/not deployed/);
  });

  it('switching profile replaces every network-specific setting (overrides do not leak), keeps the price feed', () => {
    const custom: Registry = { ...defaultRegistry(), dapi: { source: 'manual', quorumUrl: QUORUM_SERVICE.mainnet, nodes: ['1.2.3.4:443'] }, priceFeed: { name: 'mine', url: 'https://price.example.org' } };
    expect([...customFields(custom)]).toEqual(['dapi', 'priceFeed']);
    const t = registryForProfile(custom, 'testnet');
    expect(t.dapi).toEqual(profileRegistry('testnet').dapi);
    expect(t.priceFeed).toEqual(custom.priceFeed);
    expect([...customFields(t)]).toEqual(['priceFeed']);
  });

  it('an empty contract means "being set up": the source reads nothing, from Platform, a bridge or DAPI', async () => {
    const t = { ...profileRegistry('testnet'), govContractId: '' };
    expect(backendNotice(t)).toBe('Testnet backend is being set up');
    expect(backendNotice({ ...defaultRegistry(), govContractId: '' })).toBe('No governance contract is configured');
    expect(enabledBridges(t)).toEqual([]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const s = createSource('live', t);
    expect(s.notice).toBe('Testnet backend is being set up');
    expect(await s.active()).toEqual([]);
    expect(await s.cycle()).toBeNull();
    expect(await s.height()).toBeNull();
    expect((await s.params()).value).toEqual(GOV_PARAMS.testnet);
    expect(s.bridgeDescriptor()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('a bridge for another contract is never asked', () => {
    const r: Registry = { ...defaultRegistry(), bridges: [...defaultRegistry().bridges, { name: 'other', httpBase: 'https://other.example.org', govContractId: 'CWJ5PyMMKwchk5H3FjX9enVQToWZUFA1xQaRn8zNZVjY', bridgeIdentityId: '', enabled: true }] };
    expect(enabledBridges(r).map((b) => b.name)).toEqual(['gov-bridge.dashhq.org']);
  });

  it('a bridge whose status names another Core network is skipped', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/status')) return new Response(JSON.stringify({ network: 'testnet', height: 1, govContractId: DEV_GOV_CONTRACT_ID }), { status: 200 });
      return new Response(JSON.stringify({ tallies: [] }), { status: 200 });
    });
    const s = createSource('live', defaultRegistry());
    expect((await s.bridgeTallies()).size).toBe(0);
    // Only the status was asked: the tallies of a testnet bridge never reach a mainnet-Core profile.
    expect(fetchSpy.mock.calls.map((c) => new URL(String(c[0])).pathname)).toEqual(['/v1/status']);
    // And the governance parameters fall back to mainnet's chain parameters, not the testnet bridge's.
    expect((await s.params()).value).toEqual(GOV_PARAMS.mainnet);
    fetchSpy.mockRestore();
  });

  it('cache scopes differ per profile, network and contract', () => {
    const scopes = new Set([registryScope(defaultRegistry()), registryScope(profileRegistry('testnet')), registryScope({ ...defaultRegistry(), coreNetwork: 'testnet' }), registryScope({ ...defaultRegistry(), govContractId: 'x' })]);
    expect(scopes.size).toBe(4);
  });
});

describe('migration from version 1', () => {
  it('the user who switched Core to testnet lands on a coherent Testnet profile, not on mainnet data with testnet maths', () => {
    // What the old Settings saved after "Core network: testnet": the quorum URL followed, the Dev contract and bridge stayed.
    const stuck = v1({ coreNetwork: 'testnet', dapi: { source: 'quorum', quorumUrl: QUORUM_SERVICE.testnet, nodes: [] } });
    const { registry, errors } = parseRegistry(stuck);
    expect(errors).toEqual([]);
    expect(registry).toEqual(profileRegistry('testnet'));
    expect(registry.govContractId).not.toBe(DEV_GOV_CONTRACT_ID);
    expect(enabledBridges(registry).some((b) => b.govContractId === DEV_GOV_CONTRACT_ID)).toBe(false);
  });

  it('default version 1 settings become the Dev profile with nothing custom', () => {
    const { registry, errors } = parseRegistry(v1());
    expect(errors).toEqual([]);
    expect(registry).toEqual(defaultRegistry());
  });

  it('version 1 overrides on Dev networks are kept, marked custom', () => {
    const own = { name: 'mine', httpBase: 'https://bridge.example.org', govContractId: DEV_GOV_CONTRACT_ID, bridgeIdentityId: '', enabled: true };
    const { registry, errors } = parseRegistry(v1({ bridges: [own], dapi: { source: 'manual', quorumUrl: QUORUM_SERVICE.mainnet, nodes: ['5.6.7.8:443'] } }));
    expect(errors).toEqual([]);
    expect(registry.profile).toBe('dev');
    expect(registry.bridges).toEqual([own]);
    expect([...customFields(registry)]).toEqual(['dapi', 'bridges']);
  });

  it('a testnet user with their own testnet contract keeps it (and its bridge)', () => {
    const own = 'HfLWUEWnp4YCQ9Mzp9DexG58WPKvHm7SahMVSuzKSQRw';
    const bridge = { name: 'tb', httpBase: 'https://tb.example.org', govContractId: own, bridgeIdentityId: '', enabled: true };
    const { registry } = parseRegistry(v1({ coreNetwork: 'testnet', govContractId: own, bridges: [bridge], dapi: { source: 'quorum', quorumUrl: QUORUM_SERVICE.testnet, nodes: [] } }));
    expect(registry).toMatchObject({ profile: 'testnet', govContractId: own, bridges: [bridge] });
  });

  it('loadRegistry migrates the legacy key once: saved as version 2, the old key removed', () => {
    const s = new MemStorage();
    s.setItem(LEGACY_STORAGE_KEY, JSON.stringify(v1({ coreNetwork: 'testnet', dapi: { source: 'quorum', quorumUrl: QUORUM_SERVICE.testnet, nodes: [] } })));
    const r = loadRegistry(s);
    expect(r.profile).toBe('testnet');
    expect(s.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(s.getItem('govhub.registry.v2')!)).toEqual({ version: 2, profile: 'testnet', overrides: {} });
    expect(loadRegistry(s)).toEqual(r);
  });

  it('only overrides are saved: a profile that changes in a later build reaches users who saved before', () => {
    const s = new MemStorage();
    const mine = { ...profileRegistry('testnet'), dapi: { source: 'manual' as const, quorumUrl: QUORUM_SERVICE.testnet, nodes: ['9.9.9.9:443'] } };
    saveRegistry(mine, s);
    const saved = JSON.parse(s.getItem('govhub.registry.v2')!);
    expect(saved).toEqual({ version: 2, profile: 'testnet', overrides: { dapi: mine.dapi } });
    // Not frozen: whatever the profile says at load time (e.g. TESTNET_GOV_CONTRACT_ID once it is filled in), plus the override.
    expect(JSON.stringify(saved)).not.toContain('govContractId');
    expect(loadRegistry(s)).toEqual(mine);
  });

  it('a profile contract cannot be read under other networks (the reported bug, as an override)', () => {
    expect(parseRegistry({ ...defaultRegistry(), coreNetwork: 'testnet' }).errors.join()).toMatch(/Dev governance contract holds Core mainnet data/);
    // A version 1 user on the Dev contract with odd networks lands on the Dev networks.
    const { registry, errors } = parseRegistry(v1({ coreNetwork: 'testnet', platformNetwork: 'mainnet', dapi: { source: 'quorum', quorumUrl: QUORUM_SERVICE.testnet, nodes: [] } }));
    expect(errors).toEqual([]);
    expect(registry).toEqual(defaultRegistry());
  });

  it('?config= links in the version 1 format still import (migrated)', () => {
    const { registry, errors } = parseRegistry(v1({ dapi: { source: 'manual', quorumUrl: QUORUM_SERVICE.mainnet, nodes: ['1.2.3.4:443'] }, bridges: [] }));
    expect(errors).toEqual([]);
    expect(registry).toMatchObject({ version: 2, profile: 'dev', dapi: { nodes: ['1.2.3.4:443'] } });
  });
});

describe('per-network wiring (Core network of each deployed profile)', () => {
  const TESTNET_ADDR = 'yNsWkgPLN1u7p5dfWYnasYdgirU2J3tjUj';
  for (const id of ['testnet', 'dev'] as const) {
    it(`${id}: DAPI nodes, ChainLock quorum, vote scheme, addresses, funding coin type`, () => {
      const r = profileRegistry(id);
      const net = r.coreNetwork;
      const cfg = dapiConfig(r);
      expect(cfg.network).toBe(net);
      expect(cfg.quorumUrl).toBe(QUORUM_SERVICE[net]);
      // ChainLocks: LLMQ_50_60 (type 1) on testnet, LLMQ_400_60 (type 2) on mainnet (chainparams.cpp:489, :286).
      expect(CHAINLOCK_PARAMS[net].llmqType).toBe(net === 'testnet' ? 1 : 2);
      // Testnet votes sign the binary hash; mainnet signs the message string (vote.cpp, Spork6 hardening).
      expect(voteSchemeFor(net)).toBe(net === 'testnet' ? 'hash' : 'message');
      expect(decodeAddress(TESTNET_ADDR, net) !== null).toBe(net === 'testnet');
      // Identity funding is on the Platform network: coin type 1' for both deployed profiles.
      expect(coinType(r.platformNetwork)).toBe(1);
      // Until a bridge reports getgovernanceinfo: the Core network's chain parameters (testnet: a superblock every 24 blocks).
      expect(createSource('live', { ...r, govContractId: '' }).defaultParams).toEqual(GOV_PARAMS[net]);
    });
  }
});

describe('testnet vote recount', () => {
  it('testnet votes sign the binary hash: they verify on testnet, and a mainnet-scheme signature does not', () => {
    const priv = sha256(utf8ToBytes('govhub-test-testnet-mn'));
    const collateralTxid = bytesToHex(sha256(utf8ToBytes('collateral')));
    const govHash = bytesToHex(sha256(utf8ToBytes('proposal')));
    const mn = { proTxHash: bytesToHex(sha256(utf8ToBytes('protx'))), collateralTxid, collateralIndex: 1, votingAddress: p2pkhAddress(hash160(secp256k1.getPublicKey(priv, true)), 'testnet'), type: 'regular' as const, valid: true };
    expect(mn.votingAddress.startsWith('y')).toBe(true);
    const fields = { collateralTxid, collateralIndex: 1, govHashDisplay: govHash, signal: VOTE_SIGNAL.FUNDING, outcome: VOTE_OUTCOME.YES, time: 1_800_000_000 };
    const vote = (network: 'testnet' | 'mainnet') => ({ collateralTxid, collateralIndex: 1, signal: VOTE_SIGNAL.FUNDING, outcome: VOTE_OUTCOME.YES, time: fields.time, sig: signVote({ privKey: priv, vote: fields, network }).base64 });
    const run = (sigNetwork: 'testnet' | 'mainnet') => verifyVotes({ govHash, votes: [vote(sigNetwork)], masternodes: [mn], network: 'testnet', now: fields.time, targets: [] });
    expect(run('testnet')).toMatchObject({ verified: 1, weighted: { yes: 1, no: 0, abstain: 0 } });
    expect(run('mainnet').problems['bad-signature']).toBe(1);
  });
});
