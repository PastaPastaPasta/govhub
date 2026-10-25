// @vitest-environment happy-dom
// D-073: removing a passkey also forgets it in this browser (localStorage govhub.passkeys.<identity>).
import { localPasskeys, toBase64, type VaultEntryDoc } from '@govhub/auth';
import { describe, expect, it, vi } from 'vitest';
import { button, click, flush, render } from '../test/render.tsx';

const ID = '8GqCCpTFpgPREMUTqHESkuDMvkrfwBEd45fVeLUEYKYL';
const cred = (n: number) => new Uint8Array(16).fill(n);
const entries: VaultEntryDoc[] = [1, 2].map((n) => ({ id: `doc${n}`, ownerId: ID, revision: 1, credentialId: cred(n), createdAt: 1 }) as unknown as VaultEntryDoc);
const removed: VaultEntryDoc[] = [];
vi.mock('@govhub/auth', async (orig) => ({
  ...(await orig<typeof import('@govhub/auth')>()),
  listPasskeys: async () => entries.filter((e) => !removed.includes(e)),
  removePasskey: async (_c: unknown, _s: unknown, e: VaultEntryDoc) => void removed.push(e),
}));
vi.mock('@govhub/auth/webauthn', () => ({
  createPasskey: vi.fn(), getPasskeyPrf: vi.fn(), forgetPasskey: vi.fn(async () => {}), PasskeyError: class extends Error {}, prfSupport: async () => 'yes', PRF_UNAVAILABLE_MESSAGE: '', userHandleFor: vi.fn(),
}));
vi.mock('./context.tsx', () => {
  const auth = { session: { identityId: ID, wallet: null }, forumContractId: ID, platform: async () => ({}), refreshBalance: () => {} };
  return { useAuth: () => auth };
});
const { Passkeys } = await import('./Passkeys.tsx');

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
