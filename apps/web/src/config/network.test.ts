import { describe, expect, it } from 'vitest';
import { profileFromSearch, profileSearch } from './network.ts';

describe('shareable network profiles', () => {
  it('defaults to Mainnet and keeps the mixed development profile explicit', () => {
    expect(profileFromSearch('')).toBe('mainnet');
    expect(profileFromSearch('?network=testnet')).toBe('testnet');
    expect(profileFromSearch('?network=testnet&profile=dev')).toBe('dev');
    expect(profileFromSearch('?network=mainnet&profile=dev')).toBe('mainnet');
  });
  it('changes networks without losing config or filters and removes stale profile flags', () => {
    const start = '?config=reviewed-settings&filter=active&network=testnet&profile=dev';
    expect(new URLSearchParams(profileSearch(start, 'mainnet')).get('config')).toBe('reviewed-settings');
    expect(new URLSearchParams(profileSearch(start, 'mainnet')).get('network')).toBe('mainnet');
    expect(new URLSearchParams(profileSearch(start, 'mainnet')).has('profile')).toBe(false);
    expect(profileSearch('', 'dev')).toBe('?network=testnet&profile=dev');
    expect(profileSearch('?profile=dev', 'testnet')).toBe('?network=testnet');
  });
});
