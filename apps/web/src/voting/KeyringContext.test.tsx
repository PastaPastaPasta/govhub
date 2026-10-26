// @vitest-environment happy-dom
// The provider derives each key's public data once (when the keyring opens or a key is added) and drops it with the keyring; the
// session end hook zeroes the keys synchronously, and nothing renders from their private bytes after that.
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { defaultRegistry } from '../config/registry.ts';
import { fixtureMnKey } from '../data/fixtureVotes.ts';
import { endSession } from '../session/end.ts';
import { flush, render } from '../test/render.tsx';
import { DEMO_KEYS } from './sim.ts';
import type { useKeyring as UseKeyring } from './KeyringContext.tsx';
import { votingKeyId } from './masternodes.ts';

// stable values: a hook returning a new object per render would re-run the provider's effects forever
const stable = vi.hoisted(() => ({ app: null as unknown, forum: null as unknown, auth: null as unknown }));
vi.mock('../app/context.tsx', () => ({ useApp: () => stable.app }));
vi.mock('../app/forum.tsx', () => ({ useForum: () => stable.forum }));
vi.mock('../auth/context.tsx', () => ({ useAuth: () => stable.auth }));
stable.app = { registry: defaultRegistry(), mode: 'fixtures' };
stable.forum = { session: { identityId: '9CVk5ytx8oD7WQq3R2s3PxDbpT5Skg13Xjbh2tTdmnbv' } };
stable.auth = {
  session: null, network: 'testnet', balance: null, refreshBalance: () => {},
  keyringLock: { locked: () => false, lock: () => {}, unlocked: () => {}, attach: () => () => {} },
};

const { KeyringProvider, useKeyring } = await import('./KeyringContext.tsx');

describe('KeyringProvider public key info', () => {
  it('has the public data beside the open keyring, and none once the session ends (keys zeroed, ring gone)', async () => {
    let ctx!: ReturnType<typeof UseKeyring>;
    const Probe = () => {
      ctx = useKeyring();
      return null;
    };
    const r = await render(
      <KeyringProvider>
        <Probe />
      </KeyringProvider>,
    );
    await flush();
    expect(ctx.status).toBe('open');
    const open = ctx;
    expect(open.keyInfos.map((i) => i.keyId)).toEqual(DEMO_KEYS.map((d) => votingKeyId(fixtureMnKey(d.index), true)));
    expect(open.keyInfos.map((i) => i.label)).toEqual(open.keyring!.content.keys.map((k) => k.label));

    // the keys are wiped while the provider still holds the ring (the window of the crash): its next renders must not touch them
    open.keyring!.close();
    await act(async () => open.refreshMasternodes());
    await act(async () => open.refreshMasternodes());
    expect(ctx.keyring).toBe(open.keyring);
    expect(ctx.keyInfos).toEqual(open.keyInfos);

    await act(async () => endSession(null));
    // the keys of the ring the last render saw are zero now; the next render has neither the ring nor anything derived from it
    expect(open.keyring!.content.keys.every((k) => k.privateKey.every((b) => b === 0))).toBe(true);
    expect(ctx.keyring).toBeNull();
    expect(ctx.keyInfos).toEqual([]);
    await r.unmount();
  });
});
