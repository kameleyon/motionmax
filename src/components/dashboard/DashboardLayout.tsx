import Sidebar from './Sidebar';
import Hero from './Hero';
import ProjectsGallery from './ProjectsGallery';
import RightRail from './RightRail';

export default function DashboardLayout() {
  return (
    <div className="flex h-screen relative bg-[#0A0D0F] text-[#ECEAE4] font-sans overflow-hidden">
      {/* filmic grain */}
      <div className="fixed inset-0 pointer-events-none z-[200] opacity-5 mix-blend-overlay"
           style={{ backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.2 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")" }}>
      </div>

      <Sidebar />

      <main className="flex flex-col overflow-hidden min-w-0 flex-1">
        {/* Topbar */}
        <div className="flex items-center gap-[14px] px-4 md:px-7 py-3 border-b border-white/10 bg-[#0A0D0F]/70 backdrop-blur-md shrink-0 h-[54px]">
          <button className="md:hidden w-[30px] h-[30px] rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] transition-colors" title="Menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"></path></svg>
          </button>
          <div className="hidden md:flex items-center gap-2 text-[13px] text-[#8A9198]">
            <span>Workspace</span><span className="text-[#5A6268]">/</span><span className="text-[#ECEAE4]">Studio</span>
          </div>
          <div className="flex-1"></div>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md font-mono text-[10.5px] tracking-widest uppercase border border-[#14C8CC]/30 text-[#14C8CC] bg-[#14C8CC]/10">
            ● LIVE
          </div>
          <a className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 transition-all shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)]" href="/editor">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"></path></svg>
            New project
          </a>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-white/10">
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-6 px-4 md:px-8 py-7 max-w-[1480px] mx-auto">
            <div className="col-main flex flex-col gap-8 min-w-0">
              <Hero />
              <ProjectsGallery />
            </div>
            <div className="hidden xl:block">
              <RightRail />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}