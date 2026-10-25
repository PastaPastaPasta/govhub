// Minimal component-test harness for happy-dom test files: render into a detached root, act() around every interaction.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export async function render(node: ReactNode) {
  const el = document.createElement('div');
  document.body.append(el);
  let root!: Root;
  await act(async () => {
    root = createRoot(el);
    root.render(node);
  });
  return {
    el,
    rerender: (n: ReactNode) => act(async () => root.render(n)),
    unmount: () => act(async () => root.unmount()),
  };
}

/** The button whose text (or aria-label) matches. */
export function button(el: ParentNode, name: RegExp): HTMLButtonElement {
  const b = [...el.querySelectorAll('button')].find((x) => name.test(x.textContent ?? '') || name.test(x.getAttribute('aria-label') ?? ''));
  if (!b) throw new Error(`no button ${name}`);
  return b;
}

export const click = (b: HTMLElement) => act(async () => b.click());

/** Types into a controlled input or textarea the way React notices (the native value setter, then an input event). */
export async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
