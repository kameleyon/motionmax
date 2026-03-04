import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Search, Video } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";

interface ProjectSearchProps {
  onSelectProject: (projectId: string) => void;
}

type ProjectRow = {
  id: string;
  title: string;
  created_at: string;
};

export function ProjectSearch({ onSelectProject }: ProjectSearchProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["project-search", user?.id, debouncedQuery],
    enabled: open && !!user?.id,
    queryFn: async (): Promise<ProjectRow[]> => {
      if (!user?.id) return [];

      let q = supabase
        .from("projects")
        .select("id,title,created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(20);

      if (debouncedQuery.length > 0) {
        q = q.ilike("title", `%${debouncedQuery}%`);
      }

      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ProjectRow[];
    },
  });

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        className="w-full justify-start gap-2 rounded-xl bg-background/60 hover:bg-sidebar-accent hover:text-accent hover:border-accent/30"
      >
        <Search className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Search projects…</span>
      </Button>

      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput
          placeholder="Search your projects..."
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>{isLoading ? "Searching..." : "No projects found."}</CommandEmpty>
          <CommandGroup heading={debouncedQuery ? "Matches" : "Recent"}>
            {projects.map((p) => (
              <CommandItem
                key={p.id}
                value={p.title}
                onSelect={() => {
                  onSelectProject(p.id);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <Video className="mr-2 h-4 w-4 text-muted-foreground" />
                <div className="flex flex-col overflow-hidden">
                  <span className="truncate text-sm font-medium">{p.title}</span>
                  <span className="text-[11px] text-muted-foreground/70">
                    {formatDistanceToNow(new Date(p.created_at), { addSuffix: true })}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
