// Page titles: "<record> · Governance · dashhq". The static routes' titles and descriptions are shared with the build-time
// entry pages (scripts/prerender.mjs), so a shared link and the open tab name the page the same way.
import { useEffect } from 'react';
import meta from './routeMeta.json';

export type StaticRoute = keyof typeof meta.routes;

export function pageTitle(record: string | null | undefined): string {
  return record ? `${record} · ${meta.product}` : meta.product;
}

export function useTitle(record: string | null | undefined): void {
  const title = pageTitle(record);
  useEffect(() => {
    document.title = title;
  }, [title]);
}

export function useRouteTitle(route: StaticRoute): void {
  useTitle(meta.routes[route].title);
}
