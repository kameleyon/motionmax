/**
 * Sources field for the autopost edit dialog. Chip-list + "Add source"
 * popover that matches the dialog's dark theme. Shape and behaviour
 * mirror components/workspace/SourceInput.tsx so attachments produced
 * here flow through the same processAttachments() path the intake
 * form uses, and the worker's processContentAttachments() expansion
 * (worker/handlers/generateVideo.ts:190) treats them identically.
 *
 * Why a separate component instead of dropping in <SourceInput>:
 * the dialog already owns the prompt-template textarea and a polished
 * dark-theme layout — SourceInput bundles its own textarea + lighter
 * styling that doesn't fit the dialog. This is the focused sources-
 * only subset.
 */

import { useRef, useState } from "react";
import {
  Plus, X, Link2, Youtube, Github, FolderOpen, Image as ImageIcon, FileText,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import type { SourceAttachment } from "@/components/workspace/SourceInput";

const MAX_ATTACHMENT_CHARS = 500_000;

const TYPE_ICONS: Record<SourceAttachment["type"], typeof Link2> = {
  file: FileText, image: ImageIcon, link: Link2,
  youtube: Youtube, github: Github, gdrive: FolderOpen, text: FileText,
};

const URL_PLACEHOLDERS: Record<string, string> = {
  link: "https://example.com, https://another.com",
  youtube: "https://youtube.com/watch?v=...",
  github: "https://github.com/user/repo",
  gdrive: "https://drive.google.com/file/d/...",
};

function makeId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function readFileAsText(file: File): Promise<string | null> {
  const TEXT_EXTENSIONS = /\.(txt|md|csv|json|xml|html|htm|rtf|log|yaml|yml|toml|ini|cfg|env|sh|bat|py|js|ts|jsx|tsx|sql|css|scss)$/i;
  if (!file.type.startsWith("text/") && !TEXT_EXTENSIONS.test(file.name)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsText(file);
  });
}

interface SourcesFieldProps {
  attachments: SourceAttachment[];
  onChange: (next: SourceAttachment[]) => void;
}

export function SourcesField({ attachments, onChange }: SourcesFieldProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [linkMode, setLinkMode] = useState<"link" | "youtube" | "github" | "gdrive" | null>(null);
  const [linkInput, setLinkInput] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const add = (a: SourceAttachment) => onChange([...attachments, a]);
  const remove = (id: string) => onChange(attachments.filter((a) => a.id !== id));

  const handleFileSelect = (accept: string, type: "file" | "image") => {
    if (!fileInputRef.current) return;
    fileInputRef.current.accept = accept;
    fileInputRef.current.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      for (const file of Array.from(files)) {
        if (type === "image") {
          const url = URL.createObjectURL(file);
          add({ id: makeId(), type: "image", name: file.name, value: url });
        } else {
          const text = await readFileAsText(file);
          if (text) {
            const clipped = text.substring(0, MAX_ATTACHMENT_CHARS);
            add({
              id: makeId(), type: "file",
              name: `${file.name} (${(clipped.length / 1000).toFixed(0)}K chars)`,
              value: clipped,
            });
          } else {
            // Binary file (PDF/doc/etc.) — keep blob URL; will be
            // uploaded in processAttachmentsForPersistence on save.
            const url = URL.createObjectURL(file);
            add({ id: makeId(), type: "file", name: file.name, value: url });
          }
        }
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    fileInputRef.current.click();
    setPopoverOpen(false);
  };

  const submitLinks = () => {
    if (!linkInput.trim() || !linkMode) return;
    const urls = linkInput.split(",").map((u) => u.trim()).filter(Boolean);
    for (const url of urls) {
      let name: string;
      try {
        name = linkMode === "github"
          ? url.replace(/https?:\/\/github\.com\//, "").substring(0, 40)
          : linkMode === "youtube"
            ? url.length > 40 ? url.substring(0, 40) + "..." : url
            : new URL(url).hostname;
      } catch {
        name = url.length > 40 ? url.substring(0, 40) + "..." : url;
      }
      add({ id: makeId(), type: linkMode, name, value: url });
    }
    setLinkInput("");
    setLinkMode(null);
    setPopoverOpen(false);
  };

  return (
    <div className="space-y-2">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((a) => {
            const Icon = TYPE_ICONS[a.type];
            return (
              <div
                key={a.id}
                className="flex items-center gap-1.5 rounded-full border border-white/10 bg-[#0A0D0F] px-2.5 py-1 text-xs text-[#ECEAE4]"
              >
                <Icon className="h-3 w-3 shrink-0 text-[#11C4D0]" />
                <span className="max-w-[180px] truncate">{a.name}</span>
                <button
                  type="button"
                  onClick={() => remove(a.id)}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-white/10 transition-colors"
                  aria-label={`Remove ${a.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <input ref={fileInputRef} type="file" multiple className="hidden" />

      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md border border-white/10 bg-[#0A0D0F] px-3 py-1.5 text-xs text-[#11C4D0] hover:border-[#11C4D0]/40 hover:bg-[#11C4D0]/[0.06] transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add source
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-64 p-1.5 z-[10000] bg-[#10151A] border-white/10 text-[#ECEAE4]"
        >
          {linkMode ? (
            <div className="space-y-2 p-1">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { setLinkMode(null); setLinkInput(""); }}
                  className="text-[#8A9198] hover:text-[#ECEAE4]"
                  aria-label="Back"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <span className="text-xs font-medium capitalize">
                  {linkMode === "gdrive" ? "Google Drive" : linkMode} links
                </span>
              </div>
              <Input
                autoFocus
                placeholder={URL_PLACEHOLDERS[linkMode] || "Enter URL..."}
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitLinks()}
                className="h-8 text-xs bg-[#0A0D0F] border-white/10"
              />
              <p className="text-[10px] text-[#5A6268]">Separate multiple with commas</p>
              <Button
                size="sm"
                className="w-full h-7 text-xs bg-[#11C4D0] text-[#0A0D0F] hover:bg-[#11C4D0]/90"
                onClick={submitLinks}
                disabled={!linkInput.trim()}
              >
                Add
              </Button>
            </div>
          ) : (
            <div className="space-y-0.5">
              <button
                type="button"
                onClick={() => handleFileSelect("image/*", "image")}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-white/5 transition-colors"
              >
                <ImageIcon className="h-4 w-4 text-[#11C4D0]" />
                <span>Photos & Images</span>
              </button>
              <button
                type="button"
                onClick={() => handleFileSelect(".pdf,.doc,.docx,.txt,.md,.csv,.json", "file")}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-white/5 transition-colors"
              >
                <FileText className="h-4 w-4 text-[#8A9198]" />
                <span>Documents & Files</span>
              </button>
              <div className="my-1 border-t border-white/10" />
              <button
                type="button"
                onClick={() => setLinkMode("link")}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-white/5 transition-colors"
              >
                <Link2 className="h-4 w-4 text-[#11C4D0]" />
                <span>Web Links</span>
              </button>
              <button
                type="button"
                onClick={() => setLinkMode("youtube")}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-white/5 transition-colors"
              >
                <Youtube className="h-4 w-4 text-[#8A9198]" />
                <span>YouTube Videos</span>
              </button>
              <div className="my-1 border-t border-white/10" />
              <button
                type="button"
                onClick={() => setLinkMode("github")}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-white/5 transition-colors"
              >
                <Github className="h-4 w-4 text-[#8A9198]" />
                <span>GitHub Repository</span>
              </button>
              <button
                type="button"
                onClick={() => setLinkMode("gdrive")}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-white/5 transition-colors"
              >
                <FolderOpen className="h-4 w-4 text-[#11C4D0]" />
                <span>Google Drive</span>
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
