import { useState, useRef, useCallback, type ClipboardEvent, type DragEvent } from "react";
import { Plus, X, Link2, Youtube, Github, FolderOpen, Image, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// ── Types ──

export interface SourceAttachment {
  id: string;
  type: "file" | "image" | "link" | "youtube" | "github" | "gdrive" | "text";
  name: string;
  value: string;
}

interface CinematicSourceInputProps {
  content: string;
  onContentChange: (content: string) => void;
  attachments: SourceAttachment[];
  onAttachmentsChange: (attachments: SourceAttachment[]) => void;
}

// ── Constants ──

const AUTO_ATTACH_THRESHOLD = 5000;
const MAX_ATTACHMENT_CHARS = 500_000;
const MAX_DIRECTION_LENGTH = 10_000;

const TYPE_ICONS: Record<SourceAttachment["type"], typeof Link2> = {
  file: FileText, image: Image, link: Link2,
  youtube: Youtube, github: Github, gdrive: FolderOpen, text: FileText,
};

const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]+/i;
const URL_REGEX = /^https?:\/\/[^\s]+$/i;

function makeId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function truncateName(name: string, max = 40): string {
  return name.length > max ? name.substring(0, max) + "..." : name;
}

/** Read a file as text. Returns null for binary files. */
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

// ── Component ──

export function SourceInput({
  content, onContentChange, attachments, onAttachmentsChange,
}: CinematicSourceInputProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [linkMode, setLinkMode] = useState<"link" | "youtube" | "github" | "gdrive" | null>(null);
  const [linkInput, setLinkInput] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addAttachment = useCallback(
    (a: SourceAttachment) => onAttachmentsChange([...attachments, a]),
    [attachments, onAttachmentsChange],
  );

  const removeAttachment = useCallback(
    (id: string) => onAttachmentsChange(attachments.filter((a) => a.id !== id)),
    [attachments, onAttachmentsChange],
  );

  // ── Auto-detect pasted content ──
  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          const url = URL.createObjectURL(file);
          addAttachment({ id: makeId(), type: "image", name: file.name || "Pasted image", value: url });
          return;
        }
      }

      const text = e.clipboardData.getData("text/plain");
      if (!text) return;

      if (YOUTUBE_REGEX.test(text.trim())) {
        e.preventDefault();
        const urls = text.trim().split(/[\n,]+/).filter((u) => YOUTUBE_REGEX.test(u.trim()));
        for (const url of urls) {
          addAttachment({ id: makeId(), type: "youtube", name: truncateName(url.trim()), value: url.trim() });
        }
        return;
      }

      if (URL_REGEX.test(text.trim())) {
        e.preventDefault();
        addAttachment({ id: makeId(), type: "link", name: truncateName(text.trim()), value: text.trim() });
        return;
      }

      if (text.length > AUTO_ATTACH_THRESHOLD) {
        e.preventDefault();
        const preview = text.substring(0, 60).replace(/\n/g, " ") + "...";
        const clipped = text.substring(0, MAX_ATTACHMENT_CHARS);
        addAttachment({
          id: makeId(), type: "text",
          name: `${preview} (${(clipped.length / 1000).toFixed(0)}K chars)`,
          value: clipped,
        });
        return;
      }
    },
    [addAttachment],
  );

  const handleFileSelect = (accept: string, type: "file" | "image") => {
    if (!fileInputRef.current) return;
    fileInputRef.current.accept = accept;
    fileInputRef.current.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      for (const file of Array.from(files)) {
        if (type === "image") {
          // Store as blob URL — will be uploaded to Supabase before generation
          const url = URL.createObjectURL(file);
          addAttachment({ id: makeId(), type: "image", name: file.name, value: url });
        } else {
          // Read text content from files
          const text = await readFileAsText(file);
          if (text) {
            const preview = text.substring(0, 60).replace(/\n/g, " ") + "...";
            const clipped = text.substring(0, MAX_ATTACHMENT_CHARS);
            addAttachment({
              id: makeId(), type: "file",
              name: `${file.name} (${(clipped.length / 1000).toFixed(0)}K chars)`,
              value: clipped,
            });
          } else {
            // Binary file — store blob URL, mark as unreadable
            const url = URL.createObjectURL(file);
            addAttachment({ id: makeId(), type: "file", name: file.name, value: url });
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
        name = linkMode === "youtube" ? truncateName(url)
          : linkMode === "github" ? url.replace(/https?:\/\/github\.com\//, "").substring(0, 40)
          : new URL(url).hostname;
      } catch { name = truncateName(url); }
      addAttachment({ id: makeId(), type: linkMode, name, value: url });
    }
    setLinkInput("");
    setLinkMode(null);
    setPopoverOpen(false);
  };

  const handleDrop = useCallback(
    async (e: DragEvent<HTMLTextAreaElement>) => {
      const files = e.dataTransfer?.files;
      if (!files?.length) return;
      e.preventDefault();
      for (const file of Array.from(files)) {
        if (file.type.startsWith("image/")) {
          const url = URL.createObjectURL(file);
          addAttachment({ id: makeId(), type: "image", name: file.name, value: url });
        } else {
          const text = await readFileAsText(file);
          if (text) {
            const clipped = text.substring(0, MAX_ATTACHMENT_CHARS);
            addAttachment({
              id: makeId(), type: "file",
              name: `${file.name} (${(clipped.length / 1000).toFixed(0)}K chars)`,
              value: clipped,
            });
          } else {
            const url = URL.createObjectURL(file);
            addAttachment({ id: makeId(), type: "file", name: file.name, value: url });
          }
        }
      }
    },
    [addAttachment],
  );

  const linkPlaceholders: Record<string, string> = {
    link: "https://example.com, https://another.com",
    youtube: "https://youtube.com/watch?v=...",
    github: "https://github.com/user/repo",
    gdrive: "https://drive.google.com/file/d/...",
  };

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
        Sources & Direction
      </h3>

      {/* Attachment chips above textarea */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((a) => {
            const Icon = TYPE_ICONS[a.type];
            return (
              <div
                key={a.id}
                className="flex items-center gap-1.5 rounded-full border border-border/50 bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground"
              >
                <Icon className="h-3 w-3 shrink-0 text-primary" />
                <span className="max-w-[180px] truncate">{a.name}</span>
                <button
                  onClick={() => removeAttachment(a.id)}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-white/10 transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Textarea with + button inside */}
      <div className="relative">
        <textarea
          ref={textareaRef}
          placeholder={attachments.length > 0
            ? "Tell us what direction you want this video to go..."
            : "Describe your video idea, paste text, drop images, or add sources with +"
          }
          className={cn(
            "flex w-full min-h-[120px] sm:min-h-[160px] resize-none rounded-xl border border-border",
            "bg-muted/50 dark:bg-white/10 px-4 py-3 pb-10 text-sm",
            "placeholder:text-muted-foreground/60",
            "focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20",
          )}
          value={content}
          onChange={(e) => onContentChange(e.target.value.slice(0, MAX_DIRECTION_LENGTH))}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
        />

        {/* Bottom bar inside textarea */}
        <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
          <input ref={fileInputRef} type="file" multiple className="hidden" />

          <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-primary hover:bg-primary/10 transition-colors"
              >
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">Add Source</span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-1.5" sideOffset={8}>
              {linkMode ? (
                <div className="space-y-2 p-1">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setLinkMode(null); setLinkInput(""); }}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <span className="text-xs font-medium capitalize">
                      {linkMode === "gdrive" ? "Google Drive" : linkMode} links
                    </span>
                  </div>
                  <Input
                    autoFocus
                    placeholder={linkPlaceholders[linkMode] || "Enter URL..."}
                    value={linkInput}
                    onChange={(e) => setLinkInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submitLinks()}
                    className="h-8 text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground">Separate multiple with commas</p>
                  <Button size="sm" className="w-full h-7 text-xs" onClick={submitLinks} disabled={!linkInput.trim()}>
                    Add
                  </Button>
                </div>
              ) : (
                <div className="space-y-0.5">
                  <button onClick={() => handleFileSelect("image/*", "image")} className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-muted/80 transition-colors">
                    <Image className="h-4 w-4 text-primary" />
                    <span>Photos & Images</span>
                  </button>
                  <button onClick={() => handleFileSelect(".pdf,.doc,.docx,.txt,.md,.csv,.json", "file")} className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-muted/80 transition-colors">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span>Documents & Files</span>
                  </button>
                  <div className="my-1 border-t border-border/50" />
                  <button onClick={() => setLinkMode("link")} className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-muted/80 transition-colors">
                    <Link2 className="h-4 w-4 text-primary" />
                    <span>Web Links</span>
                  </button>
                  <button onClick={() => setLinkMode("youtube")} className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-muted/80 transition-colors">
                    <Youtube className="h-4 w-4 text-muted-foreground" />
                    <span>YouTube Videos</span>
                  </button>
                  <div className="my-1 border-t border-border/50" />
                  <button onClick={() => setLinkMode("github")} className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-muted/80 transition-colors">
                    <Github className="h-4 w-4 text-muted-foreground" />
                    <span>GitHub Repository</span>
                  </button>
                  <button onClick={() => setLinkMode("gdrive")} className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-muted/80 transition-colors">
                    <FolderOpen className="h-4 w-4 text-primary" />
                    <span>Google Drive</span>
                  </button>
                </div>
              )}
            </PopoverContent>
          </Popover>

          <span className={cn(
            "text-[10px]",
            content.length > MAX_DIRECTION_LENGTH * 0.9 ? "text-destructive" : "text-muted-foreground/40",
          )}>
            {content.length > 0 && `${content.length.toLocaleString()} / ${MAX_DIRECTION_LENGTH.toLocaleString()}`}
          </span>
        </div>
      </div>
    </div>
  );
}
