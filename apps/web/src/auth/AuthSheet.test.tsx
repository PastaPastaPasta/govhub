// @vitest-environment happy-dom
// D-031: the quiz positions are drawn once per phrase. D-033: the phrase and voucher fields are masked until "Show".
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { button, click, render, type } from '../test/render.tsx';
import { CreateFlow } from './AuthSheet.tsx';
import { SecretField } from './SecretField.tsx';

const positions = (el: HTMLElement) => [...el.querySelectorAll('[data-testid^="quiz-"]')].map((x) => x.getAttribute('data-testid')).join(',');

describe('D-031: quiz positions', () => {
  it('stay the same across re-renders and going back to the phrase, and change with a new phrase', async () => {
    const r = await render(<CreateFlow />);
    await click(button(r.el, /I wrote it down/));
    const first = positions(r.el);
    expect(first.split(',')).toHaveLength(3);
    // the sheet re-renders while the app loads around it
    for (let i = 0; i < 20; i++) {
      await r.rerender(<CreateFlow />);
      expect(positions(r.el)).toBe(first);
    }
    await click(button(r.el, /Show the phrase again/));
    await click(button(r.el, /I wrote it down/));
    expect(positions(r.el)).toBe(first);
    await r.unmount();
  });
});

function Harness({ initial = '' }: { initial?: string }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <SecretField label="Recovery phrase" what="the recovery phrase" value={v} onChange={setV} testId="phrase-input" />
      <output>{v}</output>
    </>
  );
}

describe('D-033: secret fields', () => {
  it('are masked by default, and Show / Hide toggles keeping the value', async () => {
    const r = await render(<Harness />);
    const field = () => r.el.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-testid="phrase-input"]')!;
    const masked = () => (field() instanceof HTMLInputElement ? (field() as HTMLInputElement).type === 'password' : field().classList.contains('masked'));
    expect(masked()).toBe(true);
    expect(field().getAttribute('data-masked')).toBe('true');
    await type(field(), 'legal winner thank year');
    expect(r.el.querySelector('output')!.textContent).toBe('legal winner thank year');
    const toggle = button(r.el, /Show the recovery phrase/);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await click(toggle);
    expect(masked()).toBe(false);
    expect(field()).toBeInstanceOf(HTMLTextAreaElement);
    expect(field().value).toBe('legal winner thank year');
    await click(button(r.el, /Hide the recovery phrase/));
    expect(masked()).toBe(true);
    expect(field().value).toBe('legal winner thank year');
    await r.unmount();
  });
});
