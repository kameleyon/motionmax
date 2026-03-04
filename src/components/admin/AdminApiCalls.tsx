import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  RefreshCw, Filter, CheckCircle, XCircle, Clock, Loader2, Search, X,
  ChevronDown, ChevronRight, AlertTriangle, FileText, Cable,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useAdminAuth } from "@/hooks/useAdminAuth";

interface ApiCallLog {
  id: string;
  generation_id: string | null;
  user_id: string;
  user_display?: string;
  provider: string;
  model: string;
  status: string;
  queue_time_ms: number | null;
  running_time_ms: number | null;
  total_duration_ms: number | null;
  cost: number | null;
  error_message: string | null;
  created_at: string;
  // Enriched data from detail fetch
  system_logs?: SystemLogEntry[];
  related_api_calls?: ApiCallLog[];
}

interface SystemLogEntry {
  id: string;
  event_type: string;
  category: string;
  message: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

interface ApiCallsResponse {
  logs: ApiCallLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface ApiCallDetailResponse {
  call: ApiCallLog;
  system_logs: SystemLogEntry[];
  related_calls: ApiCallLog[];
}

export function AdminApiCalls() {
  const { callAdminApi } = useAdminAuth();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [userSearch, setUserSearch] = useState("");
  const [activeUserSearch, setActiveUserSearch] = useState("");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["admin-api-calls", page, statusFilter, providerFilter, activeUserSearch],
    queryFn: async () => {
      const result = await callAdminApi("api_calls_list", {
        page,
        limit: 50,
        status: statusFilter === "all" ? undefined : statusFilter,
        provider: providerFilter === "all" ? undefined : providerFilter,
        user_search: activeUserSearch || undefined,
      });
      return result as ApiCallsResponse;
    },
  });

  // Fetch detail for expanded row
  const { data: expandedDetail, isLoading: detailLoading } = useQuery({
    queryKey: ["admin-api-call-detail", expandedRow],
    queryFn: async () => {
      if (!expandedRow) return null;
      const result = await callAdminApi("api_call_detail", { callId: expandedRow });
      return result as ApiCallDetailResponse;
    },
    enabled: !!expandedRow,
  });

  const handleUserSearch = () => {
    setPage(1);
    setActiveUserSearch(userSearch.trim());
  };

  const clearUserSearch = () => {
    setUserSearch("");
    setActiveUserSearch("");
    setPage(1);
  };

  const formatDuration = (ms: number | null) => {
    if (ms === null || ms === undefined) return "-";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatCost = (cost: number | null) => {
    if (cost === null || cost === undefined || cost === 0) return "-";
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "success":
      case "succeeded":
        return (
          <Badge variant="outline" className="text-[#49cdbf] border-[#49cdbf] text-xs">
            <CheckCircle className="h-3 w-3 mr-1" />
            Success
          </Badge>
        );
      case "error":
      case "failed":
        return (
          <Badge variant="outline" className="text-destructive border-destructive text-xs">
            <XCircle className="h-3 w-3 mr-1" />
            Failed
          </Badge>
        );
      case "started":
      case "running":
        return (
          <Badge variant="outline" className="text-primary border-primary text-xs">
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            Running
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-muted-foreground text-xs">
            <Clock className="h-3 w-3 mr-1" />
            {status || "Pending"}
          </Badge>
        );
    }
  };

  const getProviderColor = (provider: string) => {
    switch (provider.toLowerCase()) {
      case "openrouter": return "text-primary";
      case "lovable_ai": return "text-[hsl(170,45%,55%)]";
      case "replicate": return "text-[hsl(170,55%,65%)]";
      case "replicate_fallback": return "text-[hsl(30,70%,50%)]";
      case "hypereal": return "text-[hsl(170,55%,40%)]";
      case "google_tts": return "text-[hsl(170,30%,50%)]";
      case "elevenlabs": return "text-[hsl(170,45%,55%)]";
      default: return "text-muted-foreground";
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case "system_error": return "text-destructive";
      case "system_warning": return "text-yellow-500";
      case "user_activity": return "text-[hsl(170,55%,65%)]";
      default: return "text-muted-foreground";
    }
  };

  const toggleRow = (id: string) => {
    setExpandedRow(expandedRow === id ? null : id);
  };

  return (
    <div className="space-y-4">
      <Card className="bg-card border shadow-sm">
        <CardHeader className="py-3 px-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <CardTitle className="text-base font-medium flex items-center gap-2">
                <Cable className="h-4 w-4 text-[#49cdbf]" />
                API Call Logs
                {data && (
                  <span className="text-xs text-muted-foreground font-normal">
                    ({data.total} total)
                  </span>
                )}
              </CardTitle>
              <div className="flex items-center gap-2 flex-wrap">
                <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
                  <SelectTrigger className="w-[120px] h-8 text-xs">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="success">Success</SelectItem>
                    <SelectItem value="error">Failed</SelectItem>
                    <SelectItem value="started">Running</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={providerFilter} onValueChange={(v) => { setProviderFilter(v); setPage(1); }}>
                  <SelectTrigger className="w-[130px] h-8 text-xs">
                    <SelectValue placeholder="Provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Providers</SelectItem>
                    <SelectItem value="openrouter">OpenRouter</SelectItem>
                    <SelectItem value="replicate">Replicate</SelectItem>
                    <SelectItem value="hypereal">Hypereal</SelectItem>
                    <SelectItem value="google_tts">Google TTS</SelectItem>
                    <SelectItem value="elevenlabs">ElevenLabs</SelectItem>
                    <SelectItem value="lovable_ai">Lovable AI</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetch()}
                  disabled={isFetching}
                  className="h-8 text-xs"
                >
                  <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              </div>
            </div>
            {/* User search bar */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search by user email or name..."
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleUserSearch()}
                  className="h-8 pl-8 pr-8 text-xs"
                />
                {userSearch && (
                  <button onClick={clearUserSearch} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={handleUserSearch} className="h-8 text-xs">
                Search
              </Button>
              {activeUserSearch && (
                <Badge variant="secondary" className="text-xs gap-1">
                  User: {activeUserSearch}
                  <button onClick={clearUserSearch}><X className="h-3 w-3" /></button>
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(10)].map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : !data?.logs?.length ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              {activeUserSearch
                ? `No API calls found for "${activeUserSearch}".`
                : "No API calls logged yet."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="text-xs">
                    <TableHead className="py-2 px-2 w-8"></TableHead>
                    <TableHead className="py-2 px-2">Status</TableHead>
                    <TableHead className="py-2 px-2">User</TableHead>
                    <TableHead className="py-2 px-2">Provider / Model</TableHead>
                    <TableHead className="py-2 px-2 text-right">Queued</TableHead>
                    <TableHead className="py-2 px-2 text-right">Running</TableHead>
                    <TableHead className="py-2 px-2 text-right">Total</TableHead>
                    <TableHead className="py-2 px-2 text-right">Cost</TableHead>
                    <TableHead className="py-2 px-2 text-right">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.logs.map((log) => (
                    <>
                      <TableRow
                        key={log.id}
                        className={`text-xs cursor-pointer hover:bg-muted/50 transition-colors ${expandedRow === log.id ? "bg-muted/30" : ""}`}
                        onClick={() => toggleRow(log.id)}
                      >
                        <TableCell className="py-2 px-2">
                          {expandedRow === log.id ? (
                            <ChevronDown className="h-3.5 w-3.5 text-primary" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="py-2 px-2">
                          {getStatusBadge(log.status)}
                        </TableCell>
                        <TableCell className="py-2 px-2">
                          <button
                            onClick={(e) => { e.stopPropagation(); setUserSearch(log.user_display || log.user_id.slice(0, 8)); setActiveUserSearch(log.user_display || log.user_id.slice(0, 8)); setPage(1); }}
                            className="text-primary hover:underline font-medium truncate max-w-[120px] block"
                            title={log.user_id}
                          >
                            {log.user_display || log.user_id.slice(0, 8)}
                          </button>
                        </TableCell>
                        <TableCell className="py-2 px-2">
                          <div className="flex flex-col">
                            <span className={`font-medium ${getProviderColor(log.provider)}`}>
                              {log.provider}
                            </span>
                            <span className="text-muted-foreground truncate max-w-[200px]">
                              {log.model}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="py-2 px-2 text-right text-muted-foreground">
                          {formatDuration(log.queue_time_ms)}
                        </TableCell>
                        <TableCell className="py-2 px-2 text-right text-muted-foreground">
                          {formatDuration(log.running_time_ms)}
                        </TableCell>
                        <TableCell className="py-2 px-2 text-right font-medium">
                          {formatDuration(log.total_duration_ms)}
                        </TableCell>
                        <TableCell className="py-2 px-2 text-right">
                          <span className={log.cost && log.cost > 0 ? "text-primary font-medium" : "text-muted-foreground"}>
                            {formatCost(log.cost)}
                          </span>
                        </TableCell>
                        <TableCell className="py-2 px-2 text-right text-muted-foreground whitespace-nowrap">
                          {format(new Date(log.created_at), "MMM dd HH:mm:ss")}
                        </TableCell>
                      </TableRow>
                      {/* Expanded Detail Row */}
                      {expandedRow === log.id && (
                        <TableRow key={`${log.id}-detail`} className="bg-muted/20">
                          <TableCell colSpan={9} className="p-0">
                            <ApiCallDetail
                              log={log}
                              detail={expandedDetail}
                              loading={detailLoading}
                              formatDuration={formatDuration}
                              formatCost={formatCost}
                              getStatusBadge={getStatusBadge}
                              getProviderColor={getProviderColor}
                              getCategoryColor={getCategoryColor}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between p-3 border-t">
              <span className="text-xs text-muted-foreground">
                Page {data.page} of {data.totalPages} ({data.total} total)
              </span>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="h-7 text-xs"
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                  disabled={page === data.totalPages}
                  className="h-7 text-xs"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============= Expanded Detail Panel =============
function ApiCallDetail({
  log,
  detail,
  loading,
  formatDuration,
  formatCost,
  getStatusBadge,
  getProviderColor,
  getCategoryColor,
}: {
  log: ApiCallLog;
  detail: ApiCallDetailResponse | null | undefined;
  loading: boolean;
  formatDuration: (ms: number | null) => string;
  formatCost: (cost: number | null) => string;
  getStatusBadge: (status: string) => React.ReactNode;
  getProviderColor: (provider: string) => string;
  getCategoryColor: (category: string) => string;
}) {
  return (
    <div className="p-4 space-y-4 border-l-2 border-primary/40 ml-2">
      {/* Call Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Call Info</h4>
          <div className="space-y-1 text-xs">
            <div><span className="text-muted-foreground">ID:</span> <span className="font-mono text-foreground">{log.id.slice(0, 12)}...</span></div>
            <div><span className="text-muted-foreground">Provider:</span> <span className={`font-medium ${getProviderColor(log.provider)}`}>{log.provider}</span></div>
            <div><span className="text-muted-foreground">Model:</span> <span className="text-foreground">{log.model}</span></div>
            <div><span className="text-muted-foreground">Status:</span> {getStatusBadge(log.status)}</div>
            <div><span className="text-muted-foreground">Created:</span> <span className="text-foreground">{format(new Date(log.created_at), "yyyy-MM-dd HH:mm:ss.SSS")}</span></div>
          </div>
        </div>
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Performance</h4>
          <div className="space-y-1 text-xs">
            <div><span className="text-muted-foreground">Queue Time:</span> <span className="text-foreground">{formatDuration(log.queue_time_ms)}</span></div>
            <div><span className="text-muted-foreground">Running Time:</span> <span className="text-foreground">{formatDuration(log.running_time_ms)}</span></div>
            <div><span className="text-muted-foreground">Total Duration:</span> <span className="font-medium text-foreground">{formatDuration(log.total_duration_ms)}</span></div>
            <div><span className="text-muted-foreground">Cost:</span> <span className="text-primary font-medium">{formatCost(log.cost)}</span></div>
          </div>
        </div>
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Context</h4>
          <div className="space-y-1 text-xs">
            <div><span className="text-muted-foreground">User:</span> <span className="text-foreground">{log.user_display || log.user_id}</span></div>
            <div><span className="text-muted-foreground">User ID:</span> <span className="font-mono text-foreground text-[10px]">{log.user_id}</span></div>
            <div>
              <span className="text-muted-foreground">Generation:</span>{" "}
              {log.generation_id ? (
                <span className="font-mono text-foreground text-[10px]">{log.generation_id}</span>
              ) : (
                <span className="text-muted-foreground italic">none</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Error Message */}
      {log.error_message && (
        <div className="rounded-md bg-destructive/10 border border-destructive/30 p-3">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
            <span className="text-xs font-semibold text-destructive">Error</span>
          </div>
          <pre className="text-xs text-destructive/90 whitespace-pre-wrap font-mono">{log.error_message}</pre>
        </div>
      )}

      {/* Loading detail */}
      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading pipeline logs...
        </div>
      )}

      {/* Related API Calls (same generation) */}
      {detail?.related_calls && detail.related_calls.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Cable className="h-3.5 w-3.5" />
            Related API Calls ({detail.related_calls.length}) — Same Generation
          </h4>
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="text-[10px]">
                  <TableHead className="py-1 px-2">Status</TableHead>
                  <TableHead className="py-1 px-2">Provider / Model</TableHead>
                  <TableHead className="py-1 px-2 text-right">Duration</TableHead>
                  <TableHead className="py-1 px-2 text-right">Cost</TableHead>
                  <TableHead className="py-1 px-2 text-right">Time</TableHead>
                  <TableHead className="py-1 px-2">Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.related_calls.map((rc) => (
                  <TableRow key={rc.id} className={`text-[10px] ${rc.id === log.id ? "bg-primary/5" : ""}`}>
                    <TableCell className="py-1 px-2">{getStatusBadge(rc.status)}</TableCell>
                    <TableCell className="py-1 px-2">
                      <span className={`font-medium ${getProviderColor(rc.provider)}`}>{rc.provider}</span>
                      <span className="text-muted-foreground ml-1">/ {rc.model}</span>
                    </TableCell>
                    <TableCell className="py-1 px-2 text-right">{formatDuration(rc.total_duration_ms)}</TableCell>
                    <TableCell className="py-1 px-2 text-right">{formatCost(rc.cost)}</TableCell>
                    <TableCell className="py-1 px-2 text-right whitespace-nowrap">{format(new Date(rc.created_at), "HH:mm:ss")}</TableCell>
                    <TableCell className="py-1 px-2 text-destructive truncate max-w-[200px]">{rc.error_message || "-"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* System Logs (pipeline trace) */}
      {detail?.system_logs && detail.system_logs.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            Pipeline Trace ({detail.system_logs.length} events)
          </h4>
          <div className="rounded-md bg-black/80 border border-primary/20 p-3 max-h-[400px] overflow-y-auto" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
            {detail.system_logs.map((sl) => (
              <div key={sl.id} className="py-1 text-[11px] leading-relaxed border-b border-white/5 last:border-0">
                <div className="flex items-start gap-2">
                  <span className="text-white/50 shrink-0">{format(new Date(sl.created_at), "HH:mm:ss.SSS")}</span>
                  <span className={`shrink-0 font-bold ${getCategoryColor(sl.category)}`}>
                    [{sl.category === "system_error" ? "ERROR" : sl.category === "system_warning" ? "WARN" : "INFO"}]
                  </span>
                  <span className="text-white/90">{sl.message}</span>
                </div>
                {sl.details && Object.keys(sl.details).length > 0 && (
                  <pre className="ml-[120px] mt-1 text-[10px] text-white/50 whitespace-pre-wrap">
                    {JSON.stringify(sl.details, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No detail data */}
      {detail && !detail.system_logs?.length && !detail.related_calls?.length && !log.error_message && (
        <div className="text-xs text-muted-foreground italic py-2">
          No additional pipeline logs found for this call.
        </div>
      )}
    </div>
  );
}
