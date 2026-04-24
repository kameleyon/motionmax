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
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4 sm:gap-5 xl:gap-6 px-3 sm:px-4 md:px-6 lg:px-8 py-5 sm:py-7 max-w-[1480px] mx-auto">
        <div className="col-main flex flex-col gap-6 sm:gap-8 min-w-0">
          <Hero />
          <ProjectsGallery />
        </div>
        <div className="hidden xl:block">
          <RightRail />
        </div>
      </div>
    </AppShell>
  );
}
