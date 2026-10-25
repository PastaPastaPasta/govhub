// @vitest-environment happy-dom
// The keyring's "Add a passkey" creates a passkey (same ceremony as Settings → Passkeys, with its vault entry) and makes it an
// unlocker; "Use a passkey I already have" stays a plain get. WebAuthn is faked at navigator.credentials, so the real ceremony code runs.
import { localPasskeys, toBase64, type VaultEntryDoc } from '@govhub/auth';
import { PRF_UNAVAILABLE_MESSAGE, userHandleFor } from '@govhub/auth/webauthn';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { button, click, flush, render } from '../../test/render.tsx';

const ID = '8GqCCpTFpgPREMUTqHESkuDMvkrfwBEd45fVeLUEYKYL';
const bytes = (n: number, len = 16) => new Uint8Array(len).fill(n);
const existing = [{ id: 'doc1', ownerId: ID, revision: 1, credentialId: bytes(1), createdAt: 1 }] as unknown as VaultEntryDoc[];
const NEW = bytes(9);
const domErr = (name: string) => Object.assign(new Error(name), { name });
const cred = (id: Uint8Array, prf: Uint8Array | null) => ({
  rawId: id.slice().buffer,
  getClientExtensionResults: () => ({ prf: prf ? { enabled: true, results: { first: prf.slice().buffer } } : { enabled: true } }),
  response: { userHandle: userHandleFor(ID, ID).slice().buffer },
});

const stored: unknown[] = [];
vi.mock('@govhub/auth', async (orig) => ({
  ...(await orig<typeof import('@govhub/auth')>()),
  listPasskeys: async () => existing,
  storeInVault: vi.fn(async (_c: unknown, _s: unknown, a: { credentialId: Uint8Array }) => (stored.push(a.credentialId), bytes(5, 32))),
  waitForEntry: vi.fn(async () => ({})),
}));
const keyring = {
  busy: null as string | null,
  needsConfirm: false,
  addPasskeyUnlocker: vi.fn(async () => {}),
  addPasskeyUnlockerFrom: vi.fn(async (_prf: Uint8Array) => {}),
};
vi.mock('../../voting/KeyringContext.tsx', () => ({ useKeyring: () => keyring }));
vi.mock('../../auth/context.tsx', () => {
  const auth = { session: { identityId: ID, wallet: null }, forumContractId: ID, platform: async () => ({}), refreshBalance: () => {} };
  return { useAuth: () => auth };
});
const { storeInVault, waitForEntry } = await import('@govhub/auth');
const { AddPasskey } = await import('./AddPasskey.tsx');

const create = vi.fn();
const get = vi.fn();
const signalUnknownCredential = vi.fn(async () => {});
let caps: Record<string, boolean> = { 'extension:prf': true };

async function mount() {
  const r = await render(<AddPasskey />);
  await flush();
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  stored.length = 0;
  localStorage.clear();
  keyring.busy = null;
  keyring.needsConfirm = false;
  caps = { 'extension:prf': true };
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create, get } });
  Object.assign(globalThis, { PublicKeyCredential: { getClientCapabilities: async () => caps, signalUnknownCredential } });
});

describe('keyring: add a passkey', () => {
  it('creates a passkey, confirms it with a get restricted to it, stores the vault entry and adds the unlocker', async () => {
    const prf = bytes(3, 32);
    create.mockResolvedValue(cred(NEW, prf));
    get.mockResolvedValue(cred(NEW, prf));
    let seen: Uint8Array | null = null;
    let arg: Uint8Array | null = null;
    keyring.addPasskeyUnlockerFrom.mockImplementation(async (p: Uint8Array) => void ((arg = p), (seen = p.slice())));
    const r = await mount();
    expect(r.el.textContent).toMatch(/0\.0005 DASH/);

    await click(button(r.el, /^Add a passkey$/));
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    const opts = create.mock.calls[0]![0].publicKey;
    expect(new Uint8Array(opts.user.id)).toEqual(userHandleFor(ID, ID));
    expect(opts.excludeCredentials.map((c: { id: ArrayBuffer }) => [...new Uint8Array(c.id)])).toEqual([[...bytes(1)]]);
    expect(get).not.toHaveBeenCalled();
    expect(storeInVault).not.toHaveBeenCalled();

    await click(button(r.el, /Confirm with the passkey/));
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![0].publicKey.allowCredentials.map((c: { id: ArrayBuffer }) => [...new Uint8Array(c.id)])).toEqual([[...NEW]]);
    expect(stored).toEqual([NEW]);
    expect(waitForEntry).toHaveBeenCalledTimes(1);
    expect(localPasskeys.list(localStorage, ID)).toEqual([toBase64(NEW)]);
    expect(keyring.addPasskeyUnlockerFrom).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(prf);
    expect([...arg!].every((b) => b === 0)).toBe(true);
    expect(keyring.addPasskeyUnlocker).not.toHaveBeenCalled();
    expect(r.el.querySelector('[data-testid="keyring-passkey-saved"]')).not.toBeNull();
    expect(r.el.querySelector('[role="alert"]')).toBeNull();
    await r.unmount();
  });

  it('still adds a passkey the user already has with a plain get', async () => {
    const r = await mount();
    await click(button(r.el, /Use a passkey I already have/));
    await flush();
    expect(keyring.addPasskeyUnlocker).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(storeInVault).not.toHaveBeenCalled();
    await r.unmount();
  });

  it('closing the create prompt is quiet', async () => {
    create.mockRejectedValue(domErr('NotAllowedError'));
    const r = await mount();
    await click(button(r.el, /^Add a passkey$/));
    await flush();
    expect(r.el.querySelector('[role="alert"]')).toBeNull();
    expect(r.el.textContent).not.toMatch(/Confirm with the passkey/);
    expect(button(r.el, /^Add a passkey$/)).toBeTruthy();
    await r.unmount();
  });

  it('closing the confirm prompt keeps the confirm button and stores nothing', async () => {
    create.mockResolvedValue(cred(NEW, null));
    get.mockRejectedValue(domErr('NotAllowedError'));
    const r = await mount();
    await click(button(r.el, /^Add a passkey$/));
    await flush();
    await click(button(r.el, /Confirm with the passkey/));
    await flush();
    expect(r.el.querySelector('[role="alert"]')).toBeNull();
    expect(button(r.el, /Confirm with the passkey/)).toBeTruthy();
    expect(storeInVault).not.toHaveBeenCalled();
    expect(keyring.addPasskeyUnlockerFrom).not.toHaveBeenCalled();
    await r.unmount();
  });

  it('a passkey without PRF is forgotten and nothing is stored', async () => {
    create.mockResolvedValue(cred(NEW, null));
    get.mockResolvedValue(cred(NEW, null));
    const r = await mount();
    await click(button(r.el, /^Add a passkey$/));
    await flush();
    await click(button(r.el, /Confirm with the passkey/));
    await flush();
    expect(signalUnknownCredential).toHaveBeenCalledTimes(1);
    expect(r.el.querySelector('[role="alert"]')?.textContent).toBe(PRF_UNAVAILABLE_MESSAGE);
    expect(storeInVault).not.toHaveBeenCalled();
    expect(keyring.addPasskeyUnlockerFrom).not.toHaveBeenCalled();
    expect(button(r.el, /^Add a passkey$/)).toBeTruthy();
    await r.unmount();
  });

  it('refuses a passkey that gives two different keys', async () => {
    create.mockResolvedValue(cred(NEW, bytes(3, 32)));
    get.mockResolvedValue(cred(NEW, bytes(4, 32)));
    const r = await mount();
    await click(button(r.el, /^Add a passkey$/));
    await flush();
    await click(button(r.el, /Confirm with the passkey/));
    await flush();
    expect(r.el.querySelector('[role="alert"]')?.textContent).toMatch(/two different keys/);
    expect(storeInVault).not.toHaveBeenCalled();
    await r.unmount();
  });

  it('says so when the passkey is saved for sign-in but the keyring could not take it', async () => {
    create.mockResolvedValue(cred(NEW, bytes(3, 32)));
    get.mockResolvedValue(cred(NEW, bytes(3, 32)));
    keyring.addPasskeyUnlockerFrom.mockRejectedValue(new Error('Not enough credits'));
    const r = await mount();
    await click(button(r.el, /^Add a passkey$/));
    await flush();
    await click(button(r.el, /Confirm with the passkey/));
    await flush();
    expect(stored).toEqual([NEW]);
    expect(r.el.querySelector('[role="alert"]')?.textContent).toMatch(/added for sign-in, but not finished: Not enough credits.*Use a passkey I already have/);
    expect(r.el.querySelector('[data-testid="keyring-passkey-saved"]')).toBeNull();
    await r.unmount();
  });

  it('offers no passkey when the browser has no PRF', async () => {
    caps = { 'extension:prf': false };
    const r = await mount();
    expect(r.el.textContent).toContain(PRF_UNAVAILABLE_MESSAGE);
    expect(r.el.querySelector('button')).toBeNull();
    await r.unmount();
  });

  it('disables both options while the keyring is busy', async () => {
    keyring.busy = 'Saving the label';
    const r = await mount();
    expect(button(r.el, /^Add a passkey$/).disabled).toBe(true);
    expect(button(r.el, /Use a passkey I already have/).disabled).toBe(true);
    await r.unmount();
  });

  it('will not create a passkey for a keyring whose unlockers are not confirmed yet', async () => {
    keyring.needsConfirm = true;
    const r = await mount();
    expect(button(r.el, /^Add a passkey$/).disabled).toBe(true);
    await r.unmount();
  });
});
