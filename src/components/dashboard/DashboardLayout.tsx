import AppShell from './AppShell';
import Hero from './Hero';
import ProjectsGallery from './ProjectsGallery';
import RightRail from './RightRail';

/** Dashboard home — sits inside AppShell so its sidebar+topbar chrome
 *  is identical to All-projects and any other future shell-wrapped page.
 *  This file just owns the dashboard-home content composition. */
export default function DashboardLayout() {
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
          <RightRail />
        </div>
      </div>
    </AppShell>
  );
}
