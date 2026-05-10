import { lazy, Suspense, useEffect, useState } from 'react';
import AppShell from './AppShell';
import Hero from './Hero';
import ProjectsGallery from './ProjectsGallery';

// C-5-6 (Prism PERF-010): RightRail owns 5 useQuery calls (subscription
// shared, credits shared, renderQueue, gen-30d, used-voices). On
// small viewports the rail is hidden by Tailwind `lg:block`, but React
// still mounted it — firing all 5 queries on phones / tablets that
// would never display the data. Lazy-importing the rail and only
// mounting it once we've confirmed the lg breakpoint cuts those 5
// queries on mobile/tablet first paint, and ships the rail bundle
// only to viewports that need it.
const RightRail = lazy(() => import('./RightRail'));

/**
 * Hook: returns true when window.matchMedia(query) currently matches.
 * SSR-safe (returns false until mount). Used here to gate RightRail on
 * the lg breakpoint without firing its queries on smaller viewports.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    // matchMedia.addEventListener is the modern API; addListener is the
    // pre-Safari-14 fallback. Wrap so the deprecation warning never
    // hits the console in dev.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);
  return matches;
}

/** Dashboard home — sits inside AppShell so its sidebar+topbar chrome
 *  is identical to All-projects and any other future shell-wrapped page.
 *  This file just owns the dashboard-home content composition. */
export default function DashboardLayout() {
  // Tailwind `lg:` is min-width: 1024px. Match it here so the rail
  // mounts (and fires its 5 queries) only on viewports that actually
  // render it visually.
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  return (
    <AppShell breadcrumb="Studio">
      {/* Right rail (credits, render queue, weekly stats) used to be
          xl:block (>=1280 px). That hid it on every tablet AND every
          mobile, so users couldn't see their credit balance. Bumped down
          to lg: (>=1024 px) so iPad-class viewports get the full grid.
          Mobile still gets a single column; the rail content is reachable
          from the IntakeFrame mobile sticky-bottom CTA + the Sidebar. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 sm:gap-5 lg:gap-6 px-3 sm:px-4 md:px-6 lg:px-8 py-5 sm:py-7 max-w-[1480px] mx-auto">
        <div className="col-main flex flex-col gap-6 sm:gap-8 min-w-0">
          <Hero />
          <ProjectsGallery />
        </div>
        <div className="hidden lg:block">
          {isDesktop && (
            <Suspense fallback={null}>
              <RightRail />
            </Suspense>
          )}
        </div>
      </div>
    </AppShell>
  );
}
