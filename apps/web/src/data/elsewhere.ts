// A link from another network (a Mainnet proposal opened on the Testnet profile) should read as "this is on Mainnet", not "not found".
import { PROFILE_ORDER, PROFILES, profileRegistry, type ProfileId } from '../config/registry.ts';
import { liveSource, type DataSource } from './repo.ts';

/**
 * The first other deployed profile, in PROFILE_ORDER, whose live source `has` the thing; null when none does. Profiles are asked one
 * at a time (Mainnet first), and a profile that cannot be read counts as not having it. Dev is never offered: it is for development,
 * and its copy of mainnet data would turn a proposal Mainnet has not published yet into "this is on Dev".
 */
export async function findOnOtherProfile(current: ProfileId, has: (s: DataSource) => Promise<boolean>, make: (id: ProfileId) => DataSource = (id) => liveSource(profileRegistry(id))): Promise<ProfileId | null> {
  for (const id of PROFILE_ORDER) {
    if (id === current || id === 'dev' || !PROFILES[id].deployed) continue;
    if (await has(make(id)).catch(() => false)) return id;
  }
  return null;
}
