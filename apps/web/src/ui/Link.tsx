import { forwardRef } from 'react';
import { Link as RouterLink, NavLink as RouterNavLink, useLocation, useResolvedPath, type LinkProps, type NavLinkProps } from 'react-router-dom';

const KEPT = ['network', 'profile', 'fixtures'];

function keptParams(search: string): URLSearchParams {
  const current = new URLSearchParams(search);
  return new URLSearchParams(KEPT.flatMap((key) => (current.has(key) ? [[key, current.get(key)!]] : [])));
}

/** The page's network (and profile, demo mode) as a query for a route the app opens itself: "?network=testnet", or "". */
export function keptSearch(search: string): string {
  const kept = keptParams(search);
  return kept.size ? `?${kept}` : '';
}

/** `to` with the page's network (and profile, demo mode) added where it names none. */
function useKept(to: LinkProps['to']) {
  const { search } = useLocation();
  const resolved = useResolvedPath(to);
  const params = new URLSearchParams(resolved.search);
  for (const [key, value] of keptParams(search)) {
    if (!params.has(key)) params.set(key, value);
  }
  return { ...resolved, search: params.toString() };
}

/** Keep the selected network on internal links, including open-in-new-tab. */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ to, ...props }, ref) {
  return <RouterLink ref={ref} to={useKept(to)} {...props} />;
});

/** A NavLink (marks the current page) that keeps the selected network like Link. */
export const NavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(function NavLink({ to, ...props }, ref) {
  return <RouterNavLink ref={ref} to={useKept(to)} {...props} />;
});
