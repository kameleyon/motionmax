import { Film, FileText, Zap, ArrowRight } from 'lucide-react';

/** "Create new…" tile strip shown between the Hero and the Recent gallery
 *  on /dashboard-new. Each tile is a direct link into the new unified
 *  intake form for the matching mode. Ensures there's always an obvious
 *  entry point to every generation type, even when the Hero prompt box
 *  is ignored. */

const TILES = [
  {
    mode: 'cinematic' as const,
    title: 'Cinematic',
    copy: 'Short cinematic clips with camera motion, color grading, and lip sync.',
    badge: 'NEW',
    icon: Film,
  },
  {
    mode: 'doc2video' as const,
    title: 'Explainer',
    copy: 'Turn a document or outline into a clean, narrated explainer.',
    badge: null,
    icon: FileText,
  },
  {
    mode: 'smartflow' as const,
    title: 'Smart Flow',
    copy: 'Fast short-form reels. MotionMax dials in the vibe.',
    badge: null,
    icon: Zap,
  },
];

export default function CreateModeTiles() {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3.5">
        <h2 className="font-serif font-medium text-[18px] sm:text-[20px] tracking-tight m-0">
          Start something new
        </h2>
        <span className="font-mono text-[10.5px] tracking-widest uppercase text-[#5A6268]">
          Pick a mode
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {TILES.map(({ mode, title, copy, badge, icon: Icon }) => (
          <a
            key={mode}
            href={`/app/create/new?mode=${mode}`}
            className="group relative flex flex-col gap-2.5 p-4 sm:p-5 rounded-2xl border border-white/5 bg-[#10151A] hover:border-[#14C8CC]/30 hover:bg-[#14C8CC]/[0.03] transition-colors"
            style={{ textDecoration: 'none' }}
          >
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-lg grid place-items-center bg-[#14C8CC]/10 text-[#14C8CC] border border-[#14C8CC]/20 shrink-0">
                <Icon className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-serif font-medium text-[15px] sm:text-[16px] text-[#ECEAE4] m-0 truncate">
                    {title}
                  </h3>
                  {badge && (
                    <span className="font-mono text-[9px] tracking-wider uppercase px-1.5 py-0.5 rounded bg-[#14C8CC]/10 text-[#14C8CC]">
                      {badge}
                    </span>
                  )}
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-[#5A6268] group-hover:text-[#14C8CC] group-hover:translate-x-0.5 transition-all shrink-0" />
            </div>
            <p className="text-[12.5px] text-[#8A9198] leading-[1.5] m-0">{copy}</p>
          </a>
        ))}
      </div>
    </section>
  );
}
