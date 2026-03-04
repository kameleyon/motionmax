import { useState } from "react";
import { Upload, FileText, Image, FileUp } from "lucide-react";
import { motion } from "framer-motion";
import { Textarea } from "@/components/ui/textarea";

interface ContentInputProps {
  content: string;
  onContentChange: (content: string) => void;
}

export function ContentInput({ content, onContentChange }: ContentInputProps) {
  // Upload functionality commented out for now
  // const [isDragging, setIsDragging] = useState(false);
  // const handleDragOver = (e: React.DragEvent) => {
  //   e.preventDefault();
  //   setIsDragging(true);
  // };
  // const handleDragLeave = () => setIsDragging(false);
  // const handleDrop = (e: React.DragEvent) => {
  //   e.preventDefault();
  //   setIsDragging(false);
  //   const files = Array.from(e.dataTransfer.files);
  //   if (files.length > 0) {
  //     onContentChange(`[Uploaded: ${files.map((f) => f.name).join(", ")}]`);
  //   }
  // };

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
        Your Source Content
      </h3>
      <Textarea
        placeholder="Please add all your sources and documentations.

Example: Paste your article, blog post, script, or any text content you want to transform into a video..."
        className="min-h-[180px] resize-none rounded-xl border-border bg-muted/50 dark:bg-white/10 text-sm placeholder:text-muted-foreground/60 focus:border-primary/50 focus:ring-primary/20"
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
      />
      <p className="text-xs text-muted-foreground/60">
        Paste your content or describe what you want to create.
      </p>
    </div>
  );

  /* Upload tab commented out
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm">
      <Tabs defaultValue="text" className="w-full">
        <TabsList className="w-full justify-start gap-1 rounded-none border-b border-border/30 bg-transparent p-1 px-2">
          <TabsTrigger
            value="text"
            className="gap-2 rounded-lg px-4 py-2 text-muted-foreground data-[state=active]:bg-muted/50 data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            <FileText className="h-4 w-4" />
            <span className="text-sm">Add your source</span>
          </TabsTrigger>
          <TabsTrigger
            value="upload"
            className="gap-2 rounded-lg px-4 py-2 text-muted-foreground data-[state=active]:bg-muted/50 data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            <Upload className="h-4 w-4" />
            <span className="text-sm">Upload</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="text" className="m-0">
          <Textarea
            placeholder="Please add all your sources and documentations."
            className="min-h-[180px] resize-none rounded-none border-0 bg-transparent p-6 text-[15px] leading-relaxed placeholder:text-muted-foreground/50 focus-visible:ring-0"
            value={content}
            onChange={(e) => onContentChange(e.target.value)}
          />
        </TabsContent>

        <TabsContent value="upload" className="m-0">
          <motion.div
            className={`flex min-h-[180px] cursor-pointer flex-col items-center justify-center gap-4 p-8 transition-colors ${
              isDragging ? "bg-muted/30" : "bg-transparent"
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <motion.div
              className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50"
              animate={{ scale: isDragging ? 1.05 : 1 }}
            >
              <Upload className="h-6 w-6 text-muted-foreground" />
            </motion.div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">Drop files here or click to upload</p>
              <p className="mt-1 text-xs text-muted-foreground/70">PDF, DOCX, TXT, or Images</p>
            </div>
            <div className="flex gap-2">
              <div className="flex items-center gap-1.5 rounded-full bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                <FileText className="h-3 w-3" /> PDF
              </div>
              <div className="flex items-center gap-1.5 rounded-full bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                <FileText className="h-3 w-3" /> DOCX
              </div>
              <div className="flex items-center gap-1.5 rounded-full bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                <Image className="h-3 w-3" /> Images
              </div>
            </div>
          </motion.div>
        </TabsContent>
      </Tabs>
    </div>
  );
  */
}
