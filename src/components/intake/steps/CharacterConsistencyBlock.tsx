import { useRef } from 'react';
import { ImagePlus, Link as LinkIcon, Paperclip, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IntakeField, IntakeLabel } from '../primitives';
import type { SourceAttachment } from '@/components/workspace/SourceInput';

const MAX_CHAR_IMAGES = 3;
const MAX_CHAR_DESC_CHARS = 2000;

export interface CharacterConsistencyBlockProps {
  characterDescription: string;
  onCharacterDescriptionChange: (v: string) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDrop: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  characterImages: string[];
  onCharImageRemove: (idx: number) => void;
  onCharImageUpload: (files: FileList | null) => void;
  characterAttachments: SourceAttachment[];
  onCharAttachmentRemove: (id: string) => void;
  onCharAttachmentFile: (files: FileList | null) => Promise<void> | void;
  onCharAttachmentUrl: () => void;
}

/** C-5-7 (Prism PERF-011): extracted from IntakeForm.tsx so the
 *  character-consistency block — textarea, image-upload affordance,
 *  reference image grid, attachment chip list, and three button
 *  triggers — ships in its own React.lazy chunk. Only mode features
 *  with `characterAppearance` render this block (cinematic + explainer),
 *  but every IntakeForm load was paying the bytes regardless. */
export default function CharacterConsistencyBlock({
  characterDescription,
  onCharacterDescriptionChange,
  onPaste,
  onDrop,
  characterImages,
  onCharImageRemove,
  onCharImageUpload,
  characterAttachments,
  onCharAttachmentRemove,
  onCharAttachmentFile,
  onCharAttachmentUrl,
}: CharacterConsistencyBlockProps) {
  const charImageInput = useRef<HTMLInputElement>(null);
  const charAttachmentInput = useRef<HTMLInputElement>(null);

  return (
    <div>
      {/* Single-line header: label + "Always on" pill stay on the same
          row at every breakpoint. Hand-rolled label classes so we can
          control mb + whitespace at the container level. */}
      <div className="flex items-center gap-2 mb-2 whitespace-nowrap">
        <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268]">
          Character consistency
        </span>
        <span className="inline-flex items-center font-mono text-[10px] tracking-[0.1em] uppercase text-[#14C8CC] px-2 py-0.5 rounded-md bg-[#14C8CC]/10 border border-[#14C8CC]/30 shrink-0">
          Always on
        </span>
      </div>

      <IntakeField className="p-3 sm:p-4">
        <p className="text-[12px] text-[#8A9198] mb-3 leading-[1.5]">
          Keep the same character across every scene. Describe your lead, and
          optionally drop in up to {MAX_CHAR_IMAGES} reference images so the
          model knows what they look like.
        </p>

        <textarea
          value={characterDescription}
          onChange={(e) => onCharacterDescriptionChange(e.target.value.slice(0, MAX_CHAR_DESC_CHARS))}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          rows={3}
          maxLength={MAX_CHAR_DESC_CHARS}
          placeholder="A 30-year-old man with short brown hair, warm brown eyes, a close-cropped beard, wearing a navy sweater. Earnest expression. Paste text, drop images, or attach reference links below."
          aria-label="Character description"
          className="w-full bg-[#1B2228] border border-white/5 rounded-lg px-3 py-2.5 text-base sm:text-[13px] text-[#ECEAE4] outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-[#0A0D0F] focus:border-[#14C8CC]/50 placeholder:text-[#5A6268] resize-y"
        />

        {/* Reference-image file input (kept — same 5 MB, image-only cap) */}
        <input
          ref={charImageInput}
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => { onCharImageUpload(e.target.files); e.target.value = ''; }}
          className="hidden"
        />

        {/* Generic attachment input — text / markdown / pdf / images. */}
        <input
          ref={charAttachmentInput}
          type="file"
          accept=".txt,.md,.csv,.json,.rtf,.html,.pdf,image/*"
          multiple
          className="hidden"
          onChange={async (e) => {
            await onCharAttachmentFile(e.target.files);
            e.target.value = '';
          }}
        />

        {/* Button row — matches the Sources & Direction layout:
            + Add source / File / URL, with the char counter on the
            right. */}
        <div className="flex items-center gap-2 flex-wrap mt-3 pt-2.5 border-t border-white/5">
          <button
            type="button"
            onClick={() => charAttachmentInput.current?.click()}
            className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#8A9198] px-2 py-1 border border-dashed border-white/10 rounded-md hover:text-[#ECEAE4]"
          >
            + Add source
          </button>
          <button
            type="button"
            onClick={() => charAttachmentInput.current?.click()}
            className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#8A9198] px-2 py-1 border border-white/5 rounded-md hover:text-[#ECEAE4]"
          >
            <Paperclip className="w-3 h-3" /> File
          </button>
          <button
            type="button"
            onClick={onCharAttachmentUrl}
            className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#8A9198] px-2 py-1 border border-white/5 rounded-md hover:text-[#ECEAE4]"
          >
            <LinkIcon className="w-3 h-3" /> URL
          </button>
          <div className="flex-1" />
          <span
            className={cn(
              'font-mono text-[10px] tracking-[0.1em] uppercase px-2 py-1',
              characterDescription.length > MAX_CHAR_DESC_CHARS * 0.9
                ? 'text-[#E4C875]'
                : 'text-[#5A6268]',
            )}
            aria-label={`${characterDescription.length} of ${MAX_CHAR_DESC_CHARS} characters used`}
          >
            {characterDescription.length} / {MAX_CHAR_DESC_CHARS}
          </span>
        </div>

        {/* Reference image grid */}
        <div className="mt-3 flex flex-wrap gap-2.5">
          {characterImages.map((src, i) => (
            <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden border border-white/10 bg-[#1B2228]">
              <img src={src} alt={`Reference ${i + 1}`} className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => onCharImageRemove(i)}
                className="absolute top-1 right-1 p-1.5 rounded-full bg-black/70 hover:bg-black text-white"
                aria-label="Remove reference"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
          {characterImages.length < MAX_CHAR_IMAGES && (
            <button
              type="button"
              onClick={() => charImageInput.current?.click()}
              className="w-16 h-16 rounded-lg border border-dashed border-white/10 hover:border-[#14C8CC]/40 hover:bg-[#14C8CC]/5 text-[#5A6268] hover:text-[#14C8CC] transition-colors flex flex-col items-center justify-center gap-0.5"
            >
              <ImagePlus className="w-4 h-4" />
              <span className="text-[9px] font-mono tracking-wider uppercase">Add</span>
            </button>
          )}
        </div>

        {/* Chip list for text / link references */}
        {characterAttachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-3">
            {characterAttachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-[#ECEAE4] px-2 py-0.5 rounded-md bg-[#1B2228] border border-white/10"
                title={`${a.type} · ${a.name}`}
              >
                <span className="uppercase text-[#14C8CC]">{a.type}</span>
                <span className="truncate max-w-[180px]">{a.name}</span>
                <button
                  type="button"
                  onClick={() => onCharAttachmentRemove(a.id)}
                  aria-label={`Remove ${a.name}`}
                  className="text-[#8A9198] hover:text-[#E4C875]"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </IntakeField>
    </div>
  );
}
