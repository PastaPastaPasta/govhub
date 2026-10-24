import { describe, expect, it } from 'vitest';
import { attestorsFor, defaultRegistry, exportRegistry, loadRegistry, parseRegistry, resolveConfigParam, saveRegistry, shareLink, textToB64url } from './registry.ts';
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
  it('defaults keep Core and Platform networks separate (phase 1: mainnet Core, testnet Platform)', () => {
    const d = defaultRegistry();
    expect(d.coreNetwork).toBe('mainnet');
    expect(d.platformNetwork).toBe('testnet');
    expect(parseRegistry(d).errors).toEqual([]);
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
    expect(attestorsFor(defaultRegistry())).toEqual(['9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv']);
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
    expect((await resolveConfigParam(param)).registry.relays[0]!.name).toBe('r1');
    const fetcher = (async () => new Response(JSON.stringify(r), { status: 200 })) as unknown as typeof fetch;
    expect((await resolveConfigParam('https://example.org/cfg.json', fetcher)).registry.relays).toHaveLength(1);
    expect((await resolveConfigParam(textToB64url('{oops'))).errors[0]).toMatch(/could not be read/);
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
