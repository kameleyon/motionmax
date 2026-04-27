import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  RefreshCw,
  Shield,
  Activity,
  AlertCircle,
  AlertTriangle,
  Info,
  Pause,
  Play,
  Terminal,
} from "lucide-react";
import { AdminLoadingState } from "@/components/ui/admin-loading-state";
import { format } from "date-fns";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

interface UnifiedLog {
  id: string;
  created_at: string;
  category: "admin_action" | "user_activity" | "system_error" | "system_warning" | "system_info";
  event_type: string;
  message: string;
  user_id: string | null;
  details: Record<string, unknown> | null;
  target_id?: string | null;
  target_type?: string;
  generation_id?: string | null;
  project_id?: string | null;
}

interface LogsResponse {
  logs: UnifiedLog[];
  total: number;
  page: number;
  limit: number;
}

const CATEGORY_CONFIG: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; color: string; prefix: string }
> = {
  admin_action: { label: "ADMIN", icon: Shield, color: "text-primary", prefix: "[ADMIN]" },
  user_activity: { label: "USER", icon: Activity, color: "text-primary", prefix: "[USER]" },
  system_error: { label: "ERROR", icon: AlertCircle, color: "text-destructive", prefix: "[ERROR]" },
  system_warning: { label: "WARN", icon: AlertTriangle, color: "text-primary", prefix: "[WARN]" },
  system_info: { label: "INFO", icon: Info, color: "text-muted-foreground", prefix: "[INFO]" },
};

export function AdminLogs() {
  const { callAdminApi, isAdmin } = useAdminAuth();
  const [logs, setLogs] = useState<UnifiedLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [textSearch, setTextSearch] = useState("");
  const [timeRange, setTimeRange] = useState<string>("live");
  const [isPaused, setIsPaused] = useState(false);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const fetchLogs = useCallback(async () => {
    try {
      setLoading(true);
      const result = (await callAdminApi("admin_logs", {
        page: 1,
        limit: 200,
        category: categoryFilter,
      })) as LogsResponse;
      setLogs(result.logs || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load logs");
    } finally {
      setLoading(false);
    }
  }, [callAdminApi, categoryFilter]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Subscribe to realtime updates
  useEffect(() => {
    if (isPaused) return;
    if (!isAdmin) return; // Per-event admin guard: skip subscription if admin status revoked

    const channel = supabase
      .channel("admin-logs-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "system_logs" }, (payload) => {
        if (!isAdmin) return; // re-check on every push in case session was downgraded
        const newLog = payload.new as {
          id: string;
          created_at: string;
          category: string;
          event_type: string;
          message: string;
          user_id: string | null;
          details: Record<string, unknown> | null;
          generation_id?: string | null;
          project_id?: string | null;
        };

        // Transform to unified format
        const unifiedLog: UnifiedLog = {
          id: newLog.id,
          created_at: newLog.created_at,
          category: newLog.category as UnifiedLog["category"],
          event_type: newLog.event_type,
          message: newLog.message,
          user_id: newLog.user_id,
          details: newLog.details,
          generation_id: newLog.generation_id,
          project_id: newLog.project_id,
        };

        // Apply category filter
        if (categoryFilter === "all" || unifiedLog.category === categoryFilter) {
          setLogs((prev) => [unifiedLog, ...prev].slice(0, 500));
        }
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "admin_logs" }, (payload) => {
        if (!isAdmin) return; // re-check on every push
        const newLog = payload.new as {
          id: string;
          created_at: string;
          action: string;
          admin_id: string;
          target_type: string;
          target_id: string | null;
          details: Record<string, unknown> | null;
        };

        const unifiedLog: UnifiedLog = {
          id: newLog.id,
          created_at: newLog.created_at,
          category: "admin_action",
          event_type: newLog.action,
          message: `${newLog.action.replace(/_/g, " ")} on ${newLog.target_type}`,
          user_id: newLog.admin_id,
          details: newLog.details,
          target_id: newLog.target_id,
          target_type: newLog.target_type,
        };

        if (categoryFilter === "all" || categoryFilter === "admin_action") {
          setLogs((prev) => [unifiedLog, ...prev].slice(0, 500));
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isPaused, categoryFilter, isAdmin]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScrollRef.current && terminalRef.current) {
      terminalRef.current.scrollTop = 0;
    }
  }, [logs]);

  const formatTimestamp = (timestamp: string) => {
    return format(new Date(timestamp), "HH:mm:ss.SSS");
  };

  const formatDate = (timestamp: string) => {
    return format(new Date(timestamp), "yyyy-MM-dd");
  };

  const getLogColor = (category: string) => {
    return CATEGORY_CONFIG[category]?.color || "text-muted-foreground";
  };

  const getLogPrefix = (category: string) => {
    return CATEGORY_CONFIG[category]?.prefix || "[LOG]";
  };

  const formatDetails = (details: Record<string, unknown> | null) => {
    if (!details) return null;
    return JSON.stringify(details, null, 2);
  };

  const filteredLogs = logs.filter((log) => {
    if (categoryFilter !== "all" && log.category !== categoryFilter) return false;
    if (textSearch) {
      const q = textSearch.toLowerCase();
      if (!(log.message?.toLowerCase().includes(q) || log.event_type?.toLowerCase().includes(q) || log.user_id?.toLowerCase().includes(q) || log.generation_id?.toLowerCase().includes(q))) return false;
    }
    // Time range filter
    if (timeRange !== "live" && log.created_at) {
      const logTime = new Date(log.created_at).getTime();
      const now = Date.now();
      const ranges: Record<string, number> = { "1h": 3600000, "6h": 21600000, "24h": 86400000, "7d": 604800000 };
      const maxAge = ranges[timeRange];
      if (maxAge && now - logTime > maxAge) return false;
    }
    return true;
  });

  const getCategoryCount = (category: string) => {
    return logs.filter((log) => log.category === category).length;
  };

  if (loading && logs.length === 0) {
    return <AdminLoadingState />;
  }

  if (error) {
    return (
      <div className="text-center py-12 space-y-4">
        <p className="text-destructive">{error}</p>
        <Button onClick={fetchLogs} variant="outline">
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <div className="flex items-center gap-3">
          <Terminal className="h-6 w-6 text-primary" />
          <div>
            <h2 className="font-serif text-[26px] font-medium">Live System Logs</h2>
            <p className="text-muted-foreground text-sm">
              {filteredLogs.length} entries • {isPaused ? "Paused" : "Streaming"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Search logs..."
            value={textSearch}
            onChange={(e) => setTextSearch(e.target.value)}
            className="h-8 w-36 rounded-md border border-input bg-background px-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="live">Live</SelectItem>
              <SelectItem value="1h">Last 1h</SelectItem>
              <SelectItem value="6h">Last 6h</SelectItem>
              <SelectItem value="24h">Last 24h</SelectItem>
              <SelectItem value="7d">Last 7d</SelectItem>
            </SelectContent>
          </Select>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All ({logs.length})</SelectItem>
              <SelectItem value="admin_action">Admin ({getCategoryCount("admin_action")})</SelectItem>
              <SelectItem value="user_activity">User ({getCategoryCount("user_activity")})</SelectItem>
              <SelectItem value="system_error">Errors ({getCategoryCount("system_error")})</SelectItem>
              <SelectItem value="system_warning">Warnings ({getCategoryCount("system_warning")})</SelectItem>
              <SelectItem value="system_info">Info ({getCategoryCount("system_info")})</SelectItem>
            </SelectContent>
          </Select>

          <Button
            onClick={() => setIsPaused(!isPaused)}
            variant="outline"
            size="sm"
            className={isPaused ? "border-warning text-warning" : "border-primary text-primary"}
          >
            {isPaused ? <Play className="h-4 w-4 mr-1" /> : <Pause className="h-4 w-4 mr-1" />}
            {isPaused ? "Resume" : "Pause"}
          </Button>

          <Button onClick={fetchLogs} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Category quick-filter pills with counts. Click toggles into that
          category; click again (or click All) to clear. Mirrors the Select
          dropdown above, but pills give a one-tap glance at distribution. */}
      <div className="flex flex-wrap gap-2 text-[13px] sm:text-xs">
        {[
          { key: "all",            label: "All",      icon: null,           variant: "outline-primary"     },
          { key: "admin_action",   label: "Admin",    icon: Shield,         variant: "outline-primary"     },
          { key: "user_activity",  label: "User",     icon: Activity,       variant: "outline-success"     },
          { key: "system_error",   label: "Errors",   icon: AlertCircle,    variant: "outline-destructive" },
          { key: "system_warning", label: "Warnings", icon: AlertTriangle,  variant: "outline-warning"     },
          { key: "system_info",    label: "Info",     icon: Info,           variant: "outline-muted"       },
        ].map(({ key, label, icon: Icon, variant }) => {
          const count = key === "all" ? logs.length : getCategoryCount(key);
          const active = categoryFilter === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setCategoryFilter(key)}
              aria-pressed={active}
              className={`min-h-[32px] focus:outline-none focus:ring-2 focus:ring-primary/40 rounded-full transition-all ${
                active ? "ring-2 ring-primary/60 scale-[1.02]" : "opacity-80 hover:opacity-100"
              }`}
            >
              <Badge variant={variant as never} className="gap-1 cursor-pointer pointer-events-none">
                {Icon && <Icon className="h-3 w-3" />}
                {label} ({count})
              </Badge>
            </button>
          );
        })}
      </div>

      {/* Terminal Log Viewer */}
      <div
        ref={terminalRef}
        role="log"
        aria-live="polite"
        aria-label="System logs"
        className="bg-black border border-primary/30 rounded-lg overflow-hidden shadow-sm"
        style={{ fontFamily: "'IBM Plex Mono', monospace" }}
      >
        {/* Terminal Header */}
        <div className="flex items-center gap-2 px-4 py-3 bg-primary/10 border-b border-primary/30">
          <div className="flex gap-2">
            <div className="w-3.5 h-3.5 rounded-full bg-destructive" />
            <div className="w-3.5 h-3.5 rounded-full bg-warning" />
            <div className="w-3.5 h-3.5 rounded-full bg-primary" />
          </div>
          <span className="text-sm text-foreground/80 ml-2 font-medium">motionmax-system-logs</span>
          {!isPaused && (
            <span className="ml-auto flex items-center gap-2 text-sm text-primary font-medium">
              <span className="w-2.5 h-2.5 rounded-full bg-primary animate-pulse" />
              LIVE
            </span>
          )}
        </div>

        {/* Log Content - LARGER FONTS AND BETTER CONTRAST */}
        <div className="h-[650px] overflow-y-auto p-4 space-y-2">
          {filteredLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Terminal className="h-16 w-16 mx-auto mb-4 text-muted-foreground/40" />
              <h3 className="text-lg font-semibold text-foreground mb-1">No logs to display</h3>
              <p className="text-sm text-muted-foreground">Logs will appear here as events occur</p>
            </div>
          ) : (
            filteredLogs.map((log) => (
              <div
                key={log.id}
                tabIndex={0}
                role="button"
                aria-expanded={expandedLog === log.id}
                aria-label={`${log.category} log: ${log.message?.substring(0, 80)}`}
                className="group hover:bg-white/10 rounded-md px-3 py-2 cursor-pointer transition-colors border-l-2 border-transparent hover:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedLog(expandedLog === log.id ? null : log.id); } }}
              >
                {/* Main Log Line — bump mobile sizes so 11/12 px IBM Plex Mono
                    isn't unreadable on phones. <sm: gets bigger, desktop unchanged. */}
                <div className="flex items-start gap-2 sm:gap-3 text-[15px] sm:text-base leading-relaxed">
                  <span className="text-white/75 shrink-0 text-[13px] sm:text-sm">{formatDate(log.created_at)}</span>
                  <span className="text-white/75 shrink-0 text-[13px] sm:text-sm font-medium">{formatTimestamp(log.created_at)}</span>
                  <span className={`shrink-0 font-bold text-[13px] sm:text-sm ${getLogColor(log.category)}`}>
                    {getLogPrefix(log.category)}
                  </span>
                  <span className="text-white text-wrap font-medium flex-1">{log.message}</span>
                </div>

                {/* Expanded Details - CLEARER FORMATTING */}
                {expandedLog === log.id && log.details && (
                  <div className="mt-3 ml-4 pl-4 border-l-2 border-primary/40 bg-primary/5 rounded-r-md py-3 pr-3">
                    <pre className="text-sm text-white/75 whitespace-pre-wrap leading-relaxed">
                      {formatDetails(log.details)}
                    </pre>
                    <div className="mt-3 pt-2 border-t border-primary/20 space-y-1">
                      {log.generation_id && (
                        <p className="text-[13px] sm:text-xs text-white/75">
                          <span className="text-primary font-medium">Generation:</span> {log.generation_id}
                        </p>
                      )}
                      {log.project_id && (
                        <p className="text-[13px] sm:text-xs text-white/75">
                          <span className="text-primary font-medium">Project:</span> {log.project_id}
                        </p>
                      )}
                      {log.user_id && (
                        <p className="text-[13px] sm:text-xs text-white/75">
                          <span className="text-primary font-medium">User:</span> {log.user_id}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Terminal Footer - BETTER VISIBILITY */}
        <div className="px-4 py-3 bg-primary/10 border-t border-primary/30 flex items-center justify-between text-sm text-foreground/70">
          <span className="font-medium">Click on a log entry to expand details</span>
          <span className="text-primary font-bold">{filteredLogs.length} entries</span>
        </div>
      </div>
    </div>
  );
}
