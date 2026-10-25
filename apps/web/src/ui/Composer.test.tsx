// @vitest-environment happy-dom
// F2: the composer checks the balance against what Platform wants available (not just the shown fee), says both numbers, puts a refusal in
// plain words with a Top up button; F1: a posted comment is acknowledged on the form.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { button, click, flush, render, type } from '../test/render.tsx';
import { TopUpError } from '../voting/funds.ts';

let balance: bigint | null = 0n;
const openSheet = vi.fn();
vi.mock('../app/forum.tsx', () => ({ useForum: () => ({ balance }) }));
vi.mock('../auth/context.tsx', () => ({ useAuth: () => ({ openSheet }) }));
const { Composer } = await import('./Composer.tsx');

const BODY = 'C2 prelaunch QA badge check 2026-10-25T22:44:09.870Z'; // 52 bytes
beforeEach(() => {
  balance = 0n;
  openSheet.mockClear();
});

const textarea = (el: ParentNode) => el.querySelector<HTMLTextAreaElement>('textarea')!;
const submitBtn = (el: ParentNode) => el.querySelector<HTMLButtonElement>('button[type="submit"]')!;

describe('F2: Composer balance check', () => {
  it('shows the fee and what must be available; 0.0015 DASH is not enough for a 52-byte comment', async () => {
    balance = 150_438_280n;
    const r = await render(<Composer label="Post comment" onSubmit={async () => {}} />);
    await type(textarea(r.el), BODY);
    const meta = r.el.querySelector('[data-testid="composer-meta"]')!.textContent!;
    expect(meta).toMatch(/costs about 0\.00043 DASH · needs about 0\.0023 DASH available · your balance 0\.00150438 DASH/);
    expect(submitBtn(r.el).disabled).toBe(true);
    const low = r.el.querySelector('[data-testid="low-balance"]')!;
    expect(low.textContent).toMatch(/Your balance is 0\.00150438 DASH, and this comment needs about 0\.0023 DASH available/);
    await click(button(low, /Top up/));
    expect(openSheet).toHaveBeenCalledWith('topup');
    await r.unmount();
  });

  it('enough for the up-front requirement: the button works', async () => {
    balance = 400_000_000n;
    const posted: string[] = [];
    const r = await render(<Composer label="Post comment" onSubmit={async (b) => void posted.push(b)} />);
    await type(textarea(r.el), BODY);
    expect(submitBtn(r.el).disabled).toBe(false);
    expect(r.el.querySelector('[data-testid="low-balance"]')).toBeNull();
    await click(submitBtn(r.el));
    await flush();
    expect(posted).toEqual([BODY]);
    await r.unmount();
  });

  it('Platform’s refusal (balance read lagged) is plain words with a Top up button, not the raw error', async () => {
    balance = 400_000_000n;
    const refusal = new TopUpError(150_438_280n, 227_124_440n, 'forum');
    const r = await render(
      <Composer
        label="Post comment"
        onSubmit={async () => {
          throw refusal;
        }}
      />,
    );
    await type(textarea(r.el), BODY);
    await click(submitBtn(r.el));
    await flush();
    const err = r.el.querySelector('[data-testid="write-error"]')!;
    expect(err.textContent).toMatch(/Your identity has 0\.00150438 DASH available, and Platform needs about 0\.00227124 DASH available/);
    expect(err.textContent).not.toMatch(/Protocol error|Insufficient identity/);
    await click(button(err, /Top up/));
    expect(openSheet).toHaveBeenCalledWith('topup');
    expect(textarea(r.el).value).toBe(BODY); // nothing was posted: the text is still there
    await r.unmount();
  });

  it('another failure has no Top up button', async () => {
    balance = 400_000_000n;
    const r = await render(
      <Composer
        label="Post comment"
        onSubmit={async () => {
          throw new Error('the node is busy');
        }}
      />,
    );
    await type(textarea(r.el), BODY);
    await click(submitBtn(r.el));
    await flush();
    expect(r.el.querySelector('[data-testid="write-error"]')!.textContent).toBe('the node is busy');
    expect(r.el.querySelector('[data-testid="write-topup"]')).toBeNull();
    await r.unmount();
  });
});

describe('F1: a posted comment is acknowledged', () => {
  it('says it was posted, clears the box, and drops the note when the reader types again', async () => {
    balance = 400_000_000n;
    const r = await render(<Composer label="Post comment" onSubmit={async () => {}} />);
    expect(r.el.querySelector('[data-testid="composer-posted"]')).toBeNull();
    await type(textarea(r.el), BODY);
    await click(submitBtn(r.el));
    await flush();
    expect(textarea(r.el).value).toBe('');
    expect(r.el.querySelector('[data-testid="composer-posted"]')!.textContent).toMatch(/Posted\. It is on Platform; there is no need to post it again/);
    await type(textarea(r.el), 'next');
    expect(r.el.querySelector('[data-testid="composer-posted"]')).toBeNull();
    await r.unmount();
  });
});
