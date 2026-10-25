// A side sheet (a bottom sheet on narrow screens) on a modal <dialog>: Escape and a click on the backdrop close it, focus returns
// to what opened it, and the page behind is inert while it is open.
import { useEffect, useRef, type ReactNode } from 'react';

export function Drawer({ open, onClose, title, children, testId, wide = false }: { open: boolean; onClose(): void; title: ReactNode; children: ReactNode; testId?: string; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`drawer${wide ? ' drawer-wide' : ''}`}
      aria-labelledby={testId ? `${testId}-title` : undefined}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      data-testid={testId}
    >
      {open && (
        <div className="drawer-body">
          <header className="drawer-head">
            <h2 id={testId ? `${testId}-title` : undefined}>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path d="m4.5 4.5 9 9m0-9-9 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}
