import { useState, useRef } from "react";
import { Plus, X, Paperclip, Link2, Youtube, Github, FolderOpen, Image, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface SourceAttachment {
  id: string;
  type: "file" | "image" | "link" | "youtube" | "github" | "gdrive";
  name: string;
  /** URL for links/youtube/github/gdrive, or data URL / object URL for files */
  value: string;
}

interface SourceAttachmentsProps {
  attachments: SourceAttachment[];
  onChange: (attachments: SourceAttachment[]) => void;
}

const TYPE_ICONS: Record<SourceAttachment["type"], typeof Link2> = {
  file: FileText,
  image: Image,
  link: Link2,
  youtube: Youtube,
  github: Github,
  gdrive: FolderOpen,
};

const TYPE_COLORS: Record<SourceAttachment["type"], string> = {
  file: "bg-muted/50 text-muted-foreground border-border/50",
  image: "bg-muted/50 text-muted-foreground border-border/50",
  link: "bg-primary/10 text-primary border-primary/20",
  youtube: "bg-muted/50 text-muted-foreground border-border/50",
  github: "bg-muted/50 text-muted-foreground border-border/50",
  gdrive: "bg-primary/10 text-primary border-primary/20",
};

function makeId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export function SourceAttachments({ attachments, onChange }: SourceAttachmentsProps) {
  const [open, setOpen] = useState(false);
  const [linkMode, setLinkMode] = useState<"link" | "youtube" | "github" | "gdrive" | null>(null);
  const [linkInput, setLinkInput] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const add = (attachment: SourceAttachment) => {
    onChange([...attachments, attachment]);
  };

  const remove = (id: string) => {
    onChange(attachments.filter((a) => a.id !== id));
  };

  // Handle file/image upload
  const handleFileSelect = (accept: string, type: "file" | "image") => {
    if (!fileInputRef.current) return;
    fileInputRef.current.accept = accept;
    fileInputRef.current.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      for (const file of Array.from(files)) {
        const url = URL.createObjectURL(file);
        add({ id: makeId(), type, name: file.name, value: url });
      }
      // Reset so same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    fileInputRef.current.click();
    setOpen(false);
  };

  // Handle link submission (supports comma-separated)
  const submitLinks = () => {
    if (!linkInput.trim() || !linkMode) return;
    const urls = linkInput.split(",").map((u) => u.trim()).filter(Boolean);
    for (const url of urls) {
      const name =
        linkMode === "youtube"
          ? url.replace(/https?:\/\/(www\.)?youtube\.com\/watch\?v=/, "").substring(0, 30)
          : linkMode === "github"
            ? url.replace(/https?:\/\/github\.com\//, "").substring(0, 40)
            : new URL(url).hostname.substring(0, 30);

      let safeName: string;
      try {
        safeName = name;
      } catch {
        safeName = url.substring(0, 40);
      }

      add({ id: makeId(), type: linkMode, name: safeName, value: url });
    }
    setLinkInput("");
    setLinkMode(null);
    setOpen(false);
  };

  const linkPlaceholders: Record<string, string> = {
    link: "https://example.com, https://another.com",
    youtube: "https://youtube.com/watch?v=...",
    github: "https://github.com/user/repo",
    gdrive: "https://drive.google.com/file/d/...",
  };

  return (
    <div className="space-y-2">
      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((a) => {
            const Icon = TYPE_ICONS[a.type];
            return (
              <div
                key={a.id}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                  TYPE_COLORS[a.type],
                )}
              >
                <Icon className="h-3 w-3 shrink-0" />
                <span className="max-w-[140px] truncate">{a.name}</span>
                <button
                  onClick={() => remove(a.id)}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-white/10 transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" multiple className="hidden" />

      {/* Add source button + popover */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Source
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-2" sideOffset={4}>
          {linkMode ? (
            // Link input mode
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <button
                  onClick={() => { setLinkMode(null); setLinkInput(""); }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <span className="text-xs font-medium capitalize">{linkMode === "gdrive" ? "Google Drive" : linkMode} links</span>
              </div>
              <Input
                autoFocus
                placeholder={linkPlaceholders[linkMode] || "Enter URL..."}
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitLinks()}
                className="h-8 text-xs"
              />
              <p className="text-[10px] text-muted-foreground px-1">
                Separate multiple URLs with commas
              </p>
              <Button size="sm" className="w-full h-7 text-xs" onClick={submitLinks} disabled={!linkInput.trim()}>
                Add
              </Button>
            </div>
          ) : (
            // Menu mode
            <div className="space-y-0.5">
              <button
                onClick={() => handleFileSelect("image/*", "image")}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-muted/80 transition-colors"
              >
                <Image className="h-4 w-4 text-primary" />
                <span>Photos & Images</span>
              </button>
              <button
                onClick={() => handleFileSelect(".pdf,.doc,.docx,.txt,.md,.csv,.json", "file")}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-muted/80 transition-colors"
              >
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span>Documents & Files</span>
              </button>

              <div className="my-1 border-t border-border/50" />

              <button
                onClick={() => setLinkMode("link")}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-muted/80 transition-colors"
              >
                <Link2 className="h-4 w-4 text-primary" />
                <span>Web Links</span>
              </button>
              <button
                onClick={() => setLinkMode("youtube")}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-muted/80 transition-colors"
              >
                <Youtube className="h-4 w-4 text-muted-foreground" />
                <span>YouTube Videos</span>
              </button>

              <div className="my-1 border-t border-border/50" />

              <button
                onClick={() => setLinkMode("github")}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-muted/80 transition-colors"
              >
                <Github className="h-4 w-4 text-muted-foreground" />
                <span>GitHub Repository</span>
              </button>
              <button
                onClick={() => setLinkMode("gdrive")}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm hover:bg-muted/80 transition-colors"
              >
                <FolderOpen className="h-4 w-4 text-primary" />
                <span>Google Drive</span>
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
