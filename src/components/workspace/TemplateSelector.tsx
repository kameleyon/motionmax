import { useState } from "react";
import { FileText, ChevronDown, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getTemplatesForMode, type WorkspaceTemplate } from "@/config/workspaceTemplates";

interface TemplateSelectorProps {
  mode: string;
  onSelectTemplate: (content: string) => void;
}

export function TemplateSelector({ mode, onSelectTemplate }: TemplateSelectorProps) {
  const templates = getTemplatesForMode(mode);

  if (templates.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs h-7 text-primary hover:text-primary/80"
        >
          <Sparkles className="h-3 w-3" />
          Try an example
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Templates
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {templates.map((template) => (
          <DropdownMenuItem
            key={template.id}
            onClick={() => onSelectTemplate(template.content)}
            className="flex-col items-start gap-0.5 cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <FileText className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-medium">{template.label}</span>
            </div>
            <span className="text-xs text-muted-foreground pl-5.5">
              {template.description}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
