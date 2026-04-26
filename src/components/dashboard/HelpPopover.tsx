import { HelpCircle, BookOpen, Keyboard, LifeBuoy, Sparkles } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** Small static popover with the links & shortcuts we actually ship today.
 *  Keep this synced as features ship — the "What's new" section is the one
 *  users are most likely to notice staleness on. */
export default function HelpPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="w-11 h-11 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] transition-colors"
          style={{ touchAction: 'manipulation' }}
          title="Help & shortcuts"
          aria-label="Help"
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-0 bg-[#10151A] border-white/10 text-[#ECEAE4]">
        <div className="px-4 py-3 border-b border-white/5">
          <div className="font-serif text-[15px] font-medium">Help &amp; shortcuts</div>
          <div className="text-[11px] text-[#8A9198] mt-0.5">Find your way around MotionMax.</div>
        </div>

        <div className="px-4 py-3 border-b border-white/5">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] font-medium mb-2 flex items-center gap-2">
            <Keyboard className="w-3 h-3" /> Keyboard shortcuts
          </div>
          <ul className="space-y-1.5 text-[12.5px]">
            <li className="flex items-center justify-between">
              <span className="text-[#ECEAE4]">Open search</span>
              <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-white/10 bg-[#1B2228] text-[#8A9198]">⌘K / Ctrl+K</kbd>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-[#ECEAE4]">Submit prompt</span>
              <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-white/10 bg-[#1B2228] text-[#8A9198]">Enter</kbd>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-[#ECEAE4]">New line in prompt</span>
              <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-white/10 bg-[#1B2228] text-[#8A9198]">Shift + Enter</kbd>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-[#ECEAE4]">Close dialogs</span>
              <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-white/10 bg-[#1B2228] text-[#8A9198]">Esc</kbd>
            </li>
          </ul>
        </div>

        <div className="px-4 py-3 border-b border-white/5">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] font-medium mb-2 flex items-center gap-2">
            <Sparkles className="w-3 h-3" /> What's new
          </div>
          <ul className="space-y-1 text-[12px] text-[#8A9198] list-disc list-inside marker:text-[#14C8CC]">
            <li>Kling V3.0 Pro I2V for all cinematic renders</li>
            <li>Gemini 3.1 Flash TTS across FR / ES / DE / IT / NL</li>
            <li>Preview voices from the dashboard right rail</li>
          </ul>
        </div>

        <div className="px-4 py-3 flex flex-col gap-1.5">
          <a
            href="/voice-lab"
            className="flex items-center gap-2 text-[12.5px] text-[#ECEAE4] hover:text-[#14C8CC] transition-colors no-underline"
          >
            <BookOpen className="w-3.5 h-3.5 text-[#8A9198]" />
            Voice Lab — clone or manage your voices
          </a>
          <a
            href="mailto:support@motionmax.io?subject=MotionMax%20support"
            className="flex items-center gap-2 text-[12.5px] text-[#ECEAE4] hover:text-[#14C8CC] transition-colors no-underline"
          >
            <LifeBuoy className="w-3.5 h-3.5 text-[#8A9198]" />
            Contact support
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}
