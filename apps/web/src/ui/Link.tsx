import { forwardRef } from 'react';
import { Link as RouterLink, useLocation, useResolvedPath, type LinkProps } from 'react-router-dom';

/** Keep the selected network on internal links, including open-in-new-tab. */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ to, ...props }, ref) {
  const { search } = useLocation();
  const resolved = useResolvedPath(to);
  const params = new URLSearchParams(resolved.search);
  const current = new URLSearchParams(search);
  for (const key of ['network', 'profile', 'fixtures']) {
    if (!params.has(key) && current.has(key)) params.set(key, current.get(key)!);
  }
  return <RouterLink ref={ref} to={{ ...resolved, search: params.toString() }} {...props} />;
});
