// The way into Settings, Recover funds, from the funding screens (kept apart from the tool so the sign-in sheet stays small).
import type { ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';

export const RECOVER_PATH = '/settings#recover';

/** A link to the Recover tool. From the sign-in sheet it closes the sheet (a funding there stops, and resumes from where it was). */
export function RecoverLink({ children, onClick }: { children: ReactNode; onClick?(): void }) {
  return useInRouterContext() ? (
    <Link to={RECOVER_PATH} onClick={onClick} data-testid="recover-link">
      {children}
    </Link>
  ) : (
    <a href={RECOVER_PATH}>{children}</a>
  );
}
