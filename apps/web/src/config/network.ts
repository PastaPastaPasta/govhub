import type { ProfileId } from './registry.ts';

export function profileFromSearch(search: string): ProfileId {
  const p = new URLSearchParams(search);
  return p.get('network') === 'testnet' || p.get('network') === 'test'
    ? (p.get('profile') === 'dev' ? 'dev' : 'testnet')
    : 'mainnet';
}

export function profileSearch(search: string, profile: ProfileId): string {
  const p = new URLSearchParams(search);
  p.delete('profile');
  p.delete('network');
  p.set('network', profile === 'mainnet' ? 'mainnet' : 'testnet');
  if (profile === 'dev') p.set('profile', 'dev');
  return p.toString() ? `?${p}` : '';
}
