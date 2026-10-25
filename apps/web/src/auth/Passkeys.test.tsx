// @vitest-environment happy-dom
// D-073: removing a passkey also forgets it in this browser (localStorage govhub.passkeys.<identity>).
// Adding one: create, confirm with a get restricted to it, store the vault entry, hand an open keyring the unlocker.
import { localPasskeys, toBase64, type VaultEntryDoc } from '@govhub/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { button, click, flush, render } from '../test/render.tsx';

const ID = '8GqCCpTFpgPREMUTqHESkuDMvkrfwBEd45fVeLUEYKYL';
const cred = (n: number) => new Uint8Array(16).fill(n);
const entries: VaultEntryDoc[] = [1, 2].map((n) => ({ id: `doc${n}`, ownerId: ID, revision: 1, credentialId: cred(n), createdAt: 1 }) as unknown as VaultEntryDoc);
const removed: VaultEntryDoc[] = [];
vi.mock('@govhub/auth', async (orig) => ({
  ...(await orig<typeof import('@govhub/auth')>()),
  listPasskeys: async () => entries.filter((e) => !removed.includes(e)),
  removePasskey: async (_c: unknown, _s: unknown, e: VaultEntryDoc) => void removed.push(e),
  storeInVault: vi.fn(async () => new Uint8Array(32)),
  waitForEntry: vi.fn(async () => ({})),
}));
vi.mock('../voting/stash.ts', () => ({ stashPasskeyUnlock: vi.fn() }));
vi.mock('@govhub/auth/webauthn', () => ({
  createPasskey: vi.fn(), getPasskeyPrf: vi.fn(), forgetPasskey: vi.fn(async () => {}), PasskeyError: class extends Error {}, prfSupport: async () => 'yes', PRF_UNAVAILABLE_MESSAGE: '', userHandleFor: vi.fn(),
}));
vi.mock('./context.tsx', () => {
  const auth = { session: { identityId: ID, wallet: null }, forumContractId: ID, platform: async () => ({}), refreshBalance: () => {} };
  return { useAuth: () => auth };
});
const { Passkeys } = await import('./Passkeys.tsx');
const { createPasskey, getPasskeyPrf } = await import('@govhub/auth/webauthn');
const { storeInVault } = await import('@govhub/auth');
const { stashPasskeyUnlock } = await import('../voting/stash.ts');

beforeEach(() => {
  removed.length = 0;
  localStorage.clear();
});

describe('D-073: remove a passkey', () => {
  it('drops its local marker, and the key once none is left', async () => {
    localPasskeys.add(localStorage, ID, toBase64(cred(1)));
    localPasskeys.add(localStorage, ID, toBase64(cred(2)));
    const r = await render(<Passkeys />);
    await flush();
    await click([...r.el.querySelectorAll('button')].filter((b) => /Remove/.test(b.textContent ?? ''))[0]!);
    await flush();
    expect(localPasskeys.list(localStorage, ID)).toEqual([toBase64(cred(2))]);
    await click(button(r.el, /Remove/));
    await flush();
    expect(localStorage.getItem(localPasskeys.key(ID))).toBeNull();
    await r.unmount();
  });
});

describe('add a passkey', () => {
  it('stores the vault entry for the new credential and hands the PRF to an open keyring', async () => {
    const prf = new Uint8Array(32).fill(4);
    let stashed: Uint8Array | undefined;
    vi.mocked(stashPasskeyUnlock).mockImplementation((_id, p) => void (stashed = p.slice()));
    vi.mocked(createPasskey).mockResolvedValue({ credentialId: cred(7), prfOutput: prf.slice(), prfEnabled: true });
    vi.mocked(getPasskeyPrf).mockResolvedValue({ credentialId: cred(7), userHandle: null, prfOutput: prf.slice() });
    const r = await render(<Passkeys />);
    await flush();
    await click(button(r.el, /^Add a passkey$/));
    await flush();
    expect(vi.mocked(createPasskey).mock.calls[0]![0].exclude).toEqual([cred(1), cred(2)]);
    await click(button(r.el, /Confirm with the passkey/));
    await flush();
    expect(vi.mocked(getPasskeyPrf).mock.calls[0]![0].allow).toEqual([cred(7)]);
    expect(storeInVault).toHaveBeenCalledTimes(1);
    expect(stashPasskeyUnlock).toHaveBeenCalledWith(ID, expect.anything(), 'add');
    expect(stashed).toEqual(prf);
    expect(localPasskeys.list(localStorage, ID)).toContain(toBase64(cred(7)));
    expect(r.el.querySelector('[data-testid="passkey-saved"]')).not.toBeNull();
    await r.unmount();
  });
});
