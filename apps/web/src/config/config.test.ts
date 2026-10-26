import { describe, expect, it } from 'vitest';
import {
  attestorsFor, configParamUrl, defaultRegistry, exportRegistry, importSizeError, loadRegistry, loadSavedRegistry, MAX_IMPORT_BYTES, parseRegistry, PROFILES, profileRegistry, registryDiff,
  registryRows, fetchConfig, readInlineConfig, saveErrorText, saveRegistry, shareLink, textToB64url, type Registry,
} from './registry.ts';
import { resolveMode } from './mode.ts';

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

describe('endpoint registry', () => {
  it('the Dev profile keeps Core and Platform networks separate (mainnet Core, testnet Platform)', () => {
    const d = profileRegistry('dev');
    expect(d.coreNetwork).toBe('mainnet');
    expect(d.platformNetwork).toBe('testnet');
    expect(parseRegistry(d).errors).toEqual([]);
  });

  it('the Dev profile includes the reference bridge, publishing into the testnet gov contract', () => {
    const d = profileRegistry('dev');
    expect(d.bridges).toEqual([
      { name: 'gov-bridge.dashhq.org', httpBase: 'https://gov-bridge.dashhq.org', govContractId: d.govContractId, bridgeIdentityId: '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv', enabled: true },
    ]);
    expect(attestorsFor(d)).toEqual(['9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv']);
  });

  it('round-trips through export/import and storage', () => {
    const s = new MemStorage();
    const r = { ...defaultRegistry(), bridges: [{ name: 'mine', httpBase: 'https://bridge.example.org/', govContractId: '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ', bridgeIdentityId: '', enabled: true }] };
    const parsed = parseRegistry(JSON.parse(exportRegistry(r)));
    expect(parsed.errors).toEqual([]);
    expect(parsed.registry.bridges[0]!.httpBase).toBe('https://bridge.example.org');
    saveRegistry(parsed.registry, s);
    expect(loadRegistry(s)).toEqual(parsed.registry);
  });

  it('rejects insecure or malformed endpoints', () => {
    const r = defaultRegistry() as unknown as Record<string, unknown>;
    const errs = parseRegistry({ ...r, bridges: [{ httpBase: 'http://evil.example' }], dapi: { source: 'manual', nodes: ['not a node'], quorumUrl: 'ftp://x' }, govContractId: 'xyz' }).errors.join('\n');
    expect(errs).toContain('bridge 1 URL must be an https URL');
    expect(errs).toContain('must be host:port');
    expect(errs).toContain('quorum service URL must be an https URL');
    expect(errs).toContain('govContractId');
  });

  it('forum endpoints: defaults for settings saved before phase 2, validated when present', () => {
    const { forum: _f, ...old } = defaultRegistry();
    const parsed = parseRegistry(old);
    expect(parsed.errors).toEqual([]);
    expect(parsed.registry.forum).toEqual(defaultRegistry().forum);
    const bad = parseRegistry({ ...defaultRegistry(), forum: { contractId: 'x', modContractId: '', moderationIdentityId: '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv', claimPortals: ['ok.org', 'https://no'] } });
    const errs = bad.errors.join('\n');
    for (const e of ['forum.contractId must be', 'forum.modContractId must be', 'claim portal "https://no"']) expect(errs).toContain(e);
    expect(errs).not.toContain('moderationIdentityId');
    expect(attestorsFor(profileRegistry('dev'))).toEqual(['9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv']);
  });

  it('quorum proof sources: the profile bridge, then the public quorum list server; defaults for older settings; validated', () => {
    expect(profileRegistry('testnet').quorumProofs).toEqual([
      { name: 'gov-bridge-testnet.dashhq.org', url: 'https://gov-bridge-testnet.dashhq.org', kind: 'bridge' },
      { name: 'quorums.testnet.networks.dash.org', url: 'https://quorums.testnet.networks.dash.org/proofs', kind: 'quorum-list' },
    ]);
    // mainnet's public quorum list server sends no CORS headers: it is not a default (a CORS error on every page load)
    expect(profileRegistry('dev').quorumProofs.map((q) => q.url)).toEqual(['https://gov-bridge.dashhq.org']);
    for (const id of Object.keys(PROFILES) as Array<keyof typeof PROFILES>) {
      const r = profileRegistry(id);
      if (r.coreNetwork === 'mainnet') expect(r.quorumProofs.map((q) => q.url).join()).not.toContain('quorums.mainnet.networks.dash.org');
    }
    const { quorumProofs, ...older } = profileRegistry('testnet');
    expect(quorumProofs.length).toBe(2);
    const parsed = parseRegistry(older);
    expect(parsed.errors).toEqual([]);
    expect(parsed.registry.quorumProofs).toEqual(profileRegistry('testnet').quorumProofs);
    const custom = parseRegistry({ ...older, quorumProofs: [{ name: 'mine', url: 'https://proofs.example/proofs', kind: 'quorum-list' }] });
    expect(custom.errors).toEqual([]);
    expect(custom.registry.quorumProofs).toEqual([{ name: 'mine', url: 'https://proofs.example/proofs', kind: 'quorum-list' }]);
    expect(parseRegistry({ ...older, quorumProofs: [{ name: 'x', url: 'http://evil.example', kind: 'bridge' }] }).errors.join()).toMatch(/https/);
    expect(parseRegistry({ ...older, quorumProofs: [{ name: 'x', url: 'https://a.example', kind: 'other' }] }).errors.join()).toMatch(/kind/);
    // another Core network than the profile's, proof sources left at the profile's: that network's public source instead
    const dev = profileRegistry('dev');
    const moved = parseRegistry({ ...dev, coreNetwork: 'testnet', dapi: { ...dev.dapi, quorumUrl: 'https://quorums.testnet.networks.dash.org/masternodes' } });
    expect(moved.registry.quorumProofs).toEqual([{ name: 'quorums.testnet.networks.dash.org', url: 'https://quorums.testnet.networks.dash.org/proofs', kind: 'quorum-list' }]);
    // and onto mainnet, which has no public proof source: none
    const test = profileRegistry('testnet');
    expect(parseRegistry({ ...test, coreNetwork: 'mainnet', dapi: { ...test.dapi, quorumUrl: 'https://quorums.mainnet.networks.dash.org/masternodes' } }).registry.quorumProofs).toEqual([]);
  });

  it('allows http only for localhost (local bridge development)', () => {
    const r = { ...defaultRegistry(), bridges: [{ name: 'dev', httpBase: 'http://localhost:8787', govContractId: '', bridgeIdentityId: '', enabled: true }] };
    expect(parseRegistry(r).errors).toEqual([]);
  });

  it('falls back to defaults when storage is corrupt', () => {
    const s = new MemStorage();
    s.setItem('govhub.registry.v1', '{"version":2}');
    expect(loadRegistry(s)).toEqual(defaultRegistry());
    s.setItem('govhub.registry.v1', 'not json');
    expect(loadRegistry(s)).toEqual(defaultRegistry());
  });

  it('?config= accepts base64url JSON (share links) and https URLs', async () => {
    const r = { ...defaultRegistry(), relays: [{ name: 'r1', url: 'https://relay.example.org' }] };
    const link = shareLink(r, 'https://gov.dashhq.org');
    const param = new URL(link).searchParams.get('config')!;
    expect(readInlineConfig(param).registry.relays[0]!.name).toBe('r1');
    const fetcher = (async () => new Response(JSON.stringify(r), { status: 200 })) as unknown as typeof fetch;
    expect((await fetchConfig(new URL('https://example.org/cfg.json'), fetcher)).registry.relays).toHaveLength(1);
    expect(readInlineConfig(textToB64url('{oops')).errors[0]).toMatch(/could not be read/);
  });
});

describe('hosting and settings fixes (fix-hosting-ui)', () => {
  it('D-053: the share link keeps the base path the app is served under', () => {
    const r = defaultRegistry();
    for (const app of ['https://pastapastapasta.github.io/govhub/', 'https://pastapastapasta.github.io/govhub', 'https://gov.dashhq.org/']) {
      const u = new URL(shareLink(r, app));
      expect(u.pathname).toBe(app.includes('/govhub') ? '/govhub/' : '/');
      expect(u.searchParams.get('config')).toBeTruthy();
    }
  });

  it('D-054: an https ?config= value is recognised as a URL to fetch only on consent; inline values are not', () => {
    expect(configParamUrl('https://attacker.example/x.json')?.host).toBe('attacker.example');
    expect(configParamUrl(textToB64url('{}'))).toBeNull();
    expect(configParamUrl('http://insecure.example/x.json')).toBeNull();
  });

  it('D-052: the settings summary names every value, so a link cannot change one unseen', () => {
    const r: Registry = {
      ...profileRegistry('testnet'),
      dapi: { source: 'manual', quorumUrl: 'https://q.example/list', nodes: ['n1.example:1443'] },
      platform: { trusted: false, addresses: ['https://p1.example'] },
      bridges: [{ name: 'b-name', httpBase: 'https://b.example', govContractId: '3ueAfbVe8LvCxYWk7bKvXxc5uHe7E1TDJHzN3k3ZDehZ', bridgeIdentityId: '24tL6v5jMR1H9dtUoTgbedePsMJtYPk4Q4bo6h8jTdK9', enabled: false }],
      relays: [{ name: 'r-name', url: 'https://r.example' }],
      quorumProofs: [{ name: 'qp-name', url: 'https://qp.example/proofs', kind: 'quorum-list' }],
      priceFeed: { name: 'pf-name', url: 'https://pf.example' },
      accounts: { name: 'acc-name', url: 'https://acc.example' },
      faucet: { name: 'f-name', url: 'https://f.example' },
    };
    const text = registryRows(r).map(([, v]) => v).join('\n');
    const leaves = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(leaves) : []);
    const { profile: _p, dapi: { source: _s, ...dapi }, ...rest } = r;
    for (const s of leaves({ ...rest, dapi }).filter(Boolean)) expect(text).toContain(s);
    // the quorum proof hosts and the bridge identity, missing from the old banner
    expect(text).toContain('https://qp.example/proofs');
    expect(text).toContain('24tL6v5jMR1H9dtUoTgbedePsMJtYPk4Q4bo6h8jTdK9');
  });

  it('D-052: the offer shows only what changes, against the current settings', () => {
    const now = defaultRegistry();
    expect(registryDiff(now, now)).toEqual([]);
    const offered = { ...now, quorumProofs: [{ name: 'evil', url: 'https://evil.example/proofs', kind: 'bridge' as const }] };
    const d = registryDiff(now, offered);
    expect(d.map((x) => x.label)).toEqual(['Quorum proof sources']);
    expect(d[0]!.now).toContain('gov-bridge.dashhq.org');
    expect(d[0]!.offered).toContain('https://evil.example/proofs');
    expect(registryDiff(now, { ...now, bridges: [{ ...now.bridges[0]!, bridgeIdentityId: '24tL6v5jMR1H9dtUoTgbedePsMJtYPk4Q4bo6h8jTdK9' }] }).map((x) => x.label)).toEqual(['Bridges']);
  });

  it('D-052: a host cannot hide behind user info, a look-alike Unicode name, or a free-text name', () => {
    const relay = (url: string, name = 'r') => parseRegistry({ ...defaultRegistry(), relays: [{ name, url }] });
    expect(relay('https://gov-bridge.dashhq.org@evil.example').errors.join()).toMatch(/must not contain a user name or password/);
    // Cyrillic "о": shown (and connected to) in punycode, so it cannot read like the real host
    expect(relay('https://g\u043ev-bridge.dashhq.org/').registry.relays[0]!.url).toMatch(/^https:\/\/xn--/);
    expect(relay('https://Relay.Example.org/').registry.relays[0]!.url).toBe('https://relay.example.org');
    // bidi overrides and control characters are dropped from names
    expect(relay('https://r.example', 'a\u202Eb\u0007c').registry.relays[0]!.name).toBe('abc');
    // two relay lists that read the same are still a change: decided on values, not text
    const now = { ...defaultRegistry(), relays: [{ name: 'R1', url: 'https://r1' }, { name: 'R2', url: 'https://r2' }] };
    const offered = { ...now, relays: [{ name: 'R1: https://r1; R2', url: 'https://r2' }] };
    expect(registryRows(now).find(([k]) => k === 'Relays')![1]).toBe(registryRows(offered).find(([k]) => k === 'Relays')![1]);
    expect(registryDiff(now, offered).map((d) => d.label)).toEqual(['Relays']);
    // every boolean is a change too
    expect(registryDiff(now, { ...now, platform: { ...now.platform, trusted: false } }).map((d) => d.label)).toEqual(['Platform']);
    expect(registryDiff(now, { ...now, bridges: [{ ...now.bridges[0]!, enabled: false }] }).map((d) => d.label)).toEqual(['Bridges']);
  });

  it('D-054: a fetched config is capped, time-limited and stays on the host the user agreed to', async () => {
    const r = defaultRegistry();
    const answer = (body: string, url = 'https://cfg.example/x.json') =>
      (async () => Object.defineProperty(new Response(body, { status: 200 }), 'url', { value: url })) as unknown as typeof fetch;
    expect((await fetchConfig(new URL('https://cfg.example/x.json'), answer(JSON.stringify(r)))).errors).toEqual([]);
    expect((await fetchConfig(new URL('https://cfg.example/x.json'), answer(JSON.stringify(r), 'https://evil.example/x.json'))).errors[0]).toMatch(/redirected to another host/);
    expect((await fetchConfig(new URL('https://cfg.example/x.json'), answer(' '.repeat(MAX_IMPORT_BYTES + 1)))).errors[0]).toMatch(/Too large/);
  });

  it('D-057: imports over the size cap are refused before parsing; a full storage quota is not called invalid JSON', () => {
    expect(importSizeError(3000)).toBeNull();
    expect(importSizeError(MAX_IMPORT_BYTES)).toBeNull();
    expect(importSizeError(12 * 1024 * 1024)).toMatch(/Too large .*12\.0 MB/);
    expect(importSizeError(MAX_IMPORT_BYTES + 1)).toMatch(/Too large/);
    const quota = Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    expect(saveErrorText(quota)).toMatch(/storage for govhub is full/);
    expect(saveErrorText(quota)).not.toMatch(/JSON/);
  });

  it('D-084: invalid saved settings fall back to the defaults with the reasons, and stay saved', () => {
    const s = new MemStorage();
    expect(loadSavedRegistry(s).errors).toEqual([]);
    s.setItem('govhub.registry.v1', JSON.stringify({ ...defaultRegistry(), version: 1, coreNetwork: 'testnet', platformNetwork: 'testnet', priceFeed: { name: 'x', url: 'ftp://bad' } }));
    const r = loadSavedRegistry(s);
    expect(r.registry).toEqual(defaultRegistry());
    expect(r.errors.join(' ')).toMatch(/price feed URL must be an https URL/);
    expect(s.getItem('govhub.registry.v1')).not.toBeNull();
    s.setItem('govhub.registry.v2', 'not json');
    expect(loadSavedRegistry(s).errors[0]).toMatch(/could not be read/);
    expect(loadRegistry(s)).toEqual(defaultRegistry());
    const blocked = { getItem: () => { throw new Error('SecurityError'); }, setItem() {}, removeItem() {} };
    expect(loadSavedRegistry(blocked)).toEqual({ registry: defaultRegistry(), errors: [] });
  });
});

describe('data mode', () => {
  it('?fixtures=1 sticks for the session, ?fixtures=0 clears it, env sets the default', () => {
    const s = new MemStorage();
    expect(resolveMode('', s, undefined)).toBe('live');
    expect(resolveMode('?fixtures=1', s, undefined)).toBe('fixtures');
    expect(resolveMode('', s, undefined)).toBe('fixtures');
    expect(resolveMode('?fixtures=0', s, '1')).toBe('live');
    expect(resolveMode('', new MemStorage(), '1')).toBe('fixtures');
  });
});
