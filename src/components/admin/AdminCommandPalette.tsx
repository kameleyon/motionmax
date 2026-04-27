import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, User as UserIcon, Folder, Film, Cable } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

// Kind → display config. The RPC returns one of these four strings.
const KIND_CONFIG = {
  user:       { label: "Users",       icon: UserIcon, tab: "subscribers"  },
  project:    { label: "Projects",    icon: Folder,   tab: "generations"  },
  generation: { label: "Generations", icon: Film,     tab: "generations"  },
  api_call:   { label: "API Calls",   icon: Cable,    tab: "api-calls"    },
} as const;

type Kind = keyof typeof KIND_CONFIG;

type SearchResult = {
  kind: Kind;
  id: string;
  title: string;
  subtitle: string | null;
  created_at: string;
  rank: number;
};

interface AdminCommandPaletteProps {
  /** Switch admin tab on selection (the palette closes itself). */
  onNavigate: (tab: string) => void;
}

/**
 * Admin Cmd+K command palette. Searches the four core entities
 * (users, projects, generations, api_call_logs) via the
 * `admin_global_search` RPC and navigates to the matching admin tab.
 *
 * Bindings: ⌘K (Mac) / Ctrl+K (Win/Linux) opens the palette anywhere
 * inside admin. Esc closes via the underlying CommandDialog primitive.
 */
export function AdminCommandPalette({ onNavigate }: AdminCommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // Bind ⌘K / Ctrl+K globally while the palette is mounted. Other inputs
  // can still receive cmd+k if they preventDefault upstream.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Debounce keystrokes so we don't fire one RPC per typed character.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  const { data: results = [], isFetching } = useQuery({
    queryKey: ["admin-global-search", debouncedQuery],
    enabled: open && debouncedQuery.length >= 2,
    queryFn: async (): Promise<SearchResult[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.rpc as any)("admin_global_search", {
        q: debouncedQuery,
        limit_per_table: 5,
      });
      if (error) throw error;
      return (data ?? []) as SearchResult[];
    },
  });

  // Group by kind so the dialog renders four sections instead of a flat list.
  const grouped: Record<Kind, SearchResult[]> = {
    user: [], project: [], generation: [], api_call: [],
  };
  for (const r of results) {
    if (r.kind in grouped) grouped[r.kind].push(r);
  }

  const handleSelect = (kind: Kind) => {
    onNavigate(KIND_CONFIG[kind].tab);
    setOpen(false);
    setQuery("");
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search users, projects, generations, API calls…  (⌘K)"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>
          {debouncedQuery.length < 2
            ? "Type at least 2 characters to search."
            : isFetching
              ? "Searching..."
              : "No results."}
        </CommandEmpty>
        {(Object.keys(KIND_CONFIG) as Kind[]).map((kind) => {
          const items = grouped[kind];
          if (items.length === 0) return null;
          const Icon = KIND_CONFIG[kind].icon;
          return (
            <CommandGroup key={kind} heading={`${KIND_CONFIG[kind].label} (${items.length})`}>
              {items.map((r) => (
                <CommandItem
                  key={`${r.kind}-${r.id}`}
                  value={`${r.kind} ${r.title} ${r.subtitle ?? ""}`}
                  onSelect={() => handleSelect(kind)}
                >
                  <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
                  <div className="flex flex-col overflow-hidden">
                    <span className="truncate text-sm font-medium">{r.title}</span>
                    {r.subtitle && (
                      <span className="truncate text-xs text-muted-foreground/70">{r.subtitle}</span>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
      <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Search className="h-3 w-3" /> Admin Search
        </span>
        <span>
          ⌘K to toggle · Esc to close
        </span>
      </div>
    </CommandDialog>
  );
}
