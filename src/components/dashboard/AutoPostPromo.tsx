import { Link } from 'react-router-dom';

/**
 * Dashboard AutoPost Lab promo block. Sits beneath the Hero on the
 * dashboard home, advertising the "set it once, it keeps posting"
 * AutoPost Lab feature with a render→caption→schedule→publish pipeline
 * and a sample auto-post queue. The whole card links to /lab/autopost.
 *
 * Queue rows are illustrative sample content (this is a promo surface,
 * not a live widget) — kept static so the block renders instantly with
 * no extra queries on dashboard first paint.
 */

interface PipelineStep {
  label: string;
  icon: JSX.Element;
}

const PIPELINE: PipelineStep[] = [
  {
    label: 'RENDER',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <polygon points="9 7 17 12 9 17 9 7" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    label: 'CAPTION',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <rect x="3" y="6" width="18" height="12" rx="2.5" />
        <path d="M7.5 13.5a1.8 1.8 0 1 1 0-3M13.5 13.5a1.8 1.8 0 1 1 0-3" />
      </svg>
    ),
  },
  {
    label: 'SCHEDULE',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <rect x="4" y="5" width="16" height="16" rx="2.5" />
        <path d="M4 9h16M8 3v4M16 3v4" />
      </svg>
    ),
  },
  {
    label: 'PUBLISH',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 4L11 14M21 4l-6.5 17-3.5-7-7-3.5L21 4z" />
      </svg>
    ),
  },
];

type QueueStatus = 'QUEUED' | 'SCHEDULED' | 'POSTED';

interface QueueRow {
  title: string;
  meta: string;
  when: string;
  status: QueueStatus;
  dotClass: string;
}

const QUEUE: QueueRow[] = [
  {
    title: 'They Burned The Good Ones',
    meta: '9:16 · EMAIL',
    when: 'Today · 6:00 PM',
    status: 'QUEUED',
    dotClass: 'bg-[#14C8CC]',
  },
  {
    title: 'Tarot · Reading the Fool',
    meta: '1:1 · APP',
    when: 'Tomorrow · 8:30 AM',
    status: 'SCHEDULED',
    dotClass: 'bg-[#5A6268]',
  },
  {
    title: 'Compound interest, 45s',
    meta: '9:16 · EMAIL',
    when: '2h ago',
    status: 'POSTED',
    dotClass: 'bg-[#34D399]',
  },
];

const BADGE_CLASS: Record<QueueStatus, string> = {
  QUEUED: 'text-[#14C8CC] border-[#14C8CC]/40 bg-[#14C8CC]/[0.06]',
  SCHEDULED: 'text-[#8A9198] border-white/10 bg-white/[0.03]',
  POSTED: 'text-[#34D399] border-[#34D399]/40 bg-[#34D399]/[0.06]',
};

export default function AutoPostPromo() {
  return (
    <Link
      to="/lab/autopost"
      aria-label="Open AutoPost Lab — set it once, MotionMax keeps posting"
      className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0D0F] rounded-2xl"
    >
      {/* Pill */}
      <span className="inline-flex items-center gap-2 font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#14C8CC] px-3 py-1.5 rounded-full border border-[#14C8CC]/25 bg-[#14C8CC]/[0.05]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC] shadow-[0_0_8px_rgba(20,200,204,0.8)]" />
        New in V2.0 · AutoPost Lab
      </span>

      {/* Heading */}
      <h2 className="font-serif font-normal text-[clamp(24px,4.5vw,40px)] leading-[1.08] tracking-tight mt-4 mb-2 max-w-[26ch]">
        <span className="text-[#ECEAE4]">Set it once. </span>
        <em className="italic bg-gradient-to-r from-[#ECEAE4] via-[#7FE6E9] to-[#14C8CC] bg-clip-text text-transparent">
          MotionMax keeps posting.
        </em>
      </h2>
      <p className="text-[13px] sm:text-[14px] leading-[1.55] text-[#8A9198] m-0 mb-5 max-w-[60ch]">
        Render a video and AutoPost Lab takes it the rest of the way — captioning, scheduling
        and publishing on autopilot, by email or app, while you sleep.
      </p>

      {/* Card */}
      <div
        className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#10151A] transition-colors group-hover:border-[#14C8CC]/30"
        style={{
          background:
            'radial-gradient(60% 90% at 12% 8%, rgba(20,200,204,.08), transparent 60%), #10151A',
        }}
      >
        {/* Pipeline */}
        <div className="flex items-start justify-between gap-2 px-4 sm:px-7 pt-6 pb-5">
          {PIPELINE.map((step, i) => {
            const active = i === 0; // RENDER segment highlighted in the mockup
            return (
              <div key={step.label} className="flex items-start flex-1 min-w-0">
                <div className="flex flex-col items-center gap-2.5 shrink-0">
                  <span
                    className={
                      'inline-flex items-center justify-center w-11 h-11 sm:w-12 sm:h-12 rounded-xl border ' +
                      (active
                        ? 'border-[#14C8CC]/50 bg-[#14C8CC]/[0.08] text-[#14C8CC]'
                        : 'border-white/10 bg-white/[0.02] text-[#8A9198]')
                    }
                  >
                    {step.icon}
                  </span>
                  <span className="font-mono text-[10px] sm:text-[10.5px] tracking-[0.16em] uppercase text-[#8A9198]">
                    {step.label}
                  </span>
                </div>
                {i < PIPELINE.length - 1 && (
                  <span
                    aria-hidden="true"
                    className={
                      'flex-1 h-px mt-[22px] sm:mt-[24px] mx-1.5 sm:mx-3 ' +
                      (i === 0
                        ? 'bg-gradient-to-r from-[#14C8CC] to-white/15'
                        : 'bg-white/10')
                    }
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Divider */}
        <div className="h-px bg-white/[0.06]" />

        {/* Queue */}
        <div className="px-4 sm:px-7 py-5">
          <div className="flex items-center justify-between mb-3.5">
            <span className="inline-flex items-center gap-2 font-mono text-[10.5px] tracking-[0.16em] uppercase text-[#5A6268]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC]" />
              Auto-Post Queue
            </span>
            <span className="font-mono text-[11px] tracking-wide text-[#14C8CC]">
              Running · <span className="text-[#ECEAE4]">14 scheduled</span>
            </span>
          </div>

          <ul className="flex flex-col">
            {QUEUE.map((row, i) => (
              <li
                key={row.title}
                className={
                  'flex items-center gap-3 py-3 ' +
                  (i > 0 ? 'border-t border-white/[0.05]' : '')
                }
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${row.dotClass}`} />
                <span className="text-[13px] sm:text-[14px] font-semibold text-[#ECEAE4] truncate min-w-0 flex-1">
                  {row.title}
                </span>
                <span className="hidden sm:inline font-mono text-[10.5px] tracking-wider uppercase text-[#5A6268] shrink-0">
                  {row.meta}
                </span>
                <span className="hidden md:inline text-[11.5px] text-[#8A9198] text-right shrink-0 w-[120px]">
                  {row.when}
                </span>
                <span
                  className={
                    'font-mono text-[9.5px] tracking-[0.14em] uppercase px-2 py-1 rounded-md border shrink-0 ' +
                    BADGE_CLASS[row.status]
                  }
                >
                  {row.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Link>
  );
}
