import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { Flag, CheckCircle, AlertTriangle, Ban, RefreshCw, ChevronLeft, ChevronRight, Eye, Loader2, Settings } from "lucide-react";
import { AdminLoadingState } from "@/components/ui/admin-loading-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";
import { toast } from "sonner";

interface UserFlag {
  id: string;
  user_id: string;
  flag_type: "warning" | "flagged" | "suspended" | "banned";
  reason: string;
  details: string | null;
  flagged_by: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_notes: string | null;
  created_at: string;
  userName: string;
}

interface FlagsResponse {
  flags: UserFlag[];
  total: number;
  page: number;
  limit: number;
}

// Teal-based color scheme with severity indicators using opacity
const FLAG_TYPE_CONFIG = {
  warning: { label: "Warning", icon: AlertTriangle, color: "bg-primary/10 text-primary" },
  flagged: { label: "Flagged", icon: Flag, color: "bg-primary/15 text-primary" },
  suspended: { label: "Suspended", icon: Ban, color: "bg-muted text-muted-foreground" },
  banned: { label: "Banned", icon: Ban, color: "bg-foreground/10 text-foreground" },
};

export function AdminFlags() {
  const { callAdminApi } = useAdminAuth();
  const [data, setData] = useState<FlagsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [includeResolved, setIncludeResolved] = useState(false);
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newFlagUserId, setNewFlagUserId] = useState("");
  const [newFlagType, setNewFlagType] = useState("warning");
  const [newFlagReason, setNewFlagReason] = useState("");
  const [creating, setCreating] = useState(false);
  const [globalCounts, setGlobalCounts] = useState<Record<string, number>>({});
  // Bulk resolve: selected flag ids on the current page.
  const [selectedFlagIds, setSelectedFlagIds] = useState<Set<string>>(new Set());
  const [bulkResolveOpen, setBulkResolveOpen] = useState(false);
  const [bulkResolveNotes, setBulkResolveNotes] = useState("");
  const [bulkResolving, setBulkResolving] = useState(false);
  // Auto-resolve threshold (in days). null = not loaded yet.
  const [autoResolveDays, setAutoResolveDays] = useState<number | null>(null);
  const [savingAutoResolve, setSavingAutoResolve] = useState(false);

  const fetchGlobalCounts = useCallback(async () => {
    const types = ["warning", "flagged", "suspended", "banned"] as const;
    const results = await Promise.all(
      types.map(type =>
        supabase
          .from("user_flags")
          .select("*", { count: "exact", head: true })
          .eq("flag_type", type)
          .is("resolved_at", null)
      )
    );
    const counts: Record<string, number> = {};
    types.forEach((type, i) => { counts[type] = results[i].count || 0; });
    setGlobalCounts(counts);
  }, []);

  const fetchFlags = useCallback(async () => {
    try {
      setLoading(true);
      const result = await callAdminApi("flags_list", { page, limit: 20, includeResolved });
      setData(result as typeof data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load flags");
    } finally {
      setLoading(false);
    }
  }, [callAdminApi, page, includeResolved]);

  useEffect(() => {
    fetchFlags();
    fetchGlobalCounts();
  }, [fetchFlags, fetchGlobalCounts]);

  const handleResolve = async (flagId: string) => {
    try {
      setResolvingId(flagId);
      await callAdminApi("resolve_flag", { flagId, resolutionNotes });
      toast.success("Flag resolved", { description: "The flag has been marked as resolved." });
      setResolutionNotes("");
      // Refresh-in-place: patch the row's resolved_at locally so the
      // admin doesn't get bounced back to page 1 mid-batch. Also bump
      // the global counts (resolved_at column shifts the active total).
      setFlags((prev) =>
        prev.map((f) =>
          f.id === flagId
            ? { ...f, resolved_at: new Date().toISOString() }
            : f,
        ),
      );
      fetchGlobalCounts();
      // If the user is hiding resolved (default view), drop the row
      // from the visible list after a beat so the toast still gets a
      // chance to render before the row disappears.
      if (!includeResolved) {
        setTimeout(() => {
          setFlags((prev) => prev.filter((f) => f.id !== flagId));
        }, 600);
      }
    } catch (err) {
      toast.error("Failed to resolve flag", { description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setResolvingId(null);
    }
  };

  const getFlagBadge = (flagType: UserFlag["flag_type"]) => {
    const config = FLAG_TYPE_CONFIG[flagType];
    const Icon = config.icon;
    return (
      <Badge className={`gap-1 ${config.color}`}>
        <Icon className="h-3 w-3" />
        {config.label}
      </Badge>
    );
  };

  // Bulk resolve all selected flags via parallel resolve_flag RPCs. We
  // intentionally don't use admin_resolve_all_flags here — that's per-user
  // (resolves EVERY active flag for one user); admins selecting individual
  // rows expect only the selected flags to resolve.
  const handleBulkResolve = async () => {
    const ids = Array.from(selectedFlagIds);
    if (ids.length === 0) return;
    setBulkResolving(true);
    try {
      const results = await Promise.allSettled(
        ids.map((flagId) =>
          callAdminApi("resolve_flag", { flagId, notes: bulkResolveNotes || "Bulk resolved" }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed === 0) {
        toast.success(`Resolved ${ids.length} flag${ids.length === 1 ? "" : "s"}`);
      } else {
        toast.warning(`Resolved ${ids.length - failed} of ${ids.length} flags (${failed} failed)`);
      }
      setSelectedFlagIds(new Set());
      setBulkResolveNotes("");
      setBulkResolveOpen(false);
      fetchFlags();
      fetchGlobalCounts();
    } catch (err) {
      toast.error("Bulk resolve failed", { description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setBulkResolving(false);
    }
  };

  // Read the current auto-resolve threshold from app_settings via the
  // admin RPC. Falls back to 30 (the default seeded by the migration) on
  // any error so the slider still renders meaningfully.
  const fetchAutoResolveDays = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase.rpc as any)("admin_get_app_setting", {
        setting_key: "flags_auto_resolve_days",
      });
      const days = typeof data === "number" ? data : Number(data);
      setAutoResolveDays(Number.isFinite(days) && days > 0 ? days : 30);
    } catch {
      setAutoResolveDays(30);
    }
  }, []);

  const handleSaveAutoResolveDays = async (days: number) => {
    setSavingAutoResolve(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: rpcError } = await (supabase.rpc as any)(
        "admin_set_flags_auto_resolve_days",
        { days },
      );
      if (rpcError) throw rpcError;
      toast.success(`Auto-resolve threshold set to ${days} days`);
    } catch (err) {
      toast.error("Failed to save threshold", { description: err instanceof Error ? err.message : "Please try again." });
      // Revert by re-fetching the persisted value.
      fetchAutoResolveDays();
    } finally {
      setSavingAutoResolve(false);
    }
  };

  useEffect(() => {
    fetchAutoResolveDays();
  }, [fetchAutoResolveDays]);

  const handleCreateFlag = async () => {
    if (!newFlagUserId.trim() || !newFlagReason.trim()) {
      toast.error("Missing required fields", { description: "User ID/email and reason are required." });
      return;
    }
    setCreating(true);
    try {
      await callAdminApi("create_flag", {
        userId: newFlagUserId.trim(),
        flagType: newFlagType,
        reason: newFlagReason.trim(),
        details: "Created from Flags tab",
      });
      toast.success("Flag created", { description: "The user flag has been added successfully." });
      setCreateOpen(false);
      setNewFlagUserId("");
      setNewFlagReason("");
      fetchFlags();
      fetchGlobalCounts();
    } catch (err) {
      toast.error("Failed to create flag", { description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setCreating(false);
    }
  };

  if (loading && !data) {
    return <AdminLoadingState />;
  }

  if (error) {
    return (
      <div className="text-center py-12 space-y-4">
        <p className="text-destructive">{error}</p>
        <Button onClick={fetchFlags} variant="outline">
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <div>
          <h2 className="font-serif text-[26px] font-medium">User Flags</h2>
          <p className="text-muted-foreground">
            {data?.total || 0} {includeResolved ? "total" : "active"} flags
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="include-resolved"
              checked={includeResolved}
              onCheckedChange={(checked) => {
                setIncludeResolved(checked);
                setPage(1);
              }}
            />
            <Label htmlFor="include-resolved">Show resolved</Label>
          </div>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1.5"><Flag className="h-3.5 w-3.5" /> Create Flag</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Create User Flag</DialogTitle></DialogHeader>
              <div className="space-y-3 py-2">
                <div>
                  <Label className="text-xs">User ID or Email</Label>
                  <input value={newFlagUserId} onChange={(e) => setNewFlagUserId(e.target.value)} placeholder="user-uuid or email@example.com" className="mt-1 w-full h-9 rounded-md border border-input bg-background px-3 text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Flag Type</Label>
                  <select value={newFlagType} onChange={(e) => setNewFlagType(e.target.value)} className="mt-1 w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                    <option value="warning">Warning</option>
                    <option value="flagged">Flagged</option>
                    <option value="suspended">Suspended</option>
                    <option value="banned">Banned</option>
                  </select>
                </div>
                <div>
                  <Label className="text-xs">Reason</Label>
                  {/* Quick-pick templates so admins doing batch triage don't
                      retype "spam" / "abuse" / "fraud" 50× a day. Picking a
                      template prepends the canonical reason; the textarea
                      stays editable for additional details. */}
                  <div className="flex flex-wrap gap-1.5 mt-1.5 mb-1">
                    {[
                      { key: "spam",            label: "Spam" },
                      { key: "abuse",           label: "Abuse" },
                      { key: "fraud",           label: "Fraud" },
                      { key: "harassment",      label: "Harassment" },
                      { key: "tos_violation",   label: "ToS violation" },
                      { key: "payment_dispute", label: "Payment dispute" },
                      { key: "other",           label: "Other" },
                    ].map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => {
                          const prefix = `[${t.key}] `;
                          setNewFlagReason(
                            newFlagReason.startsWith(prefix)
                              ? newFlagReason
                              : prefix + newFlagReason.replace(/^\[[^\]]+\]\s*/, ""),
                          );
                        }}
                        className="px-2 py-1 rounded-full text-[11px] border border-border bg-background hover:bg-primary/10 hover:border-primary/30 hover:text-primary transition-colors min-h-[26px]"
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <Textarea value={newFlagReason} onChange={(e) => setNewFlagReason(e.target.value)} placeholder="Pick a template above or type your own reason..." rows={3} className="mt-1" />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
                <Button onClick={handleCreateFlag} disabled={creating}>
                  {creating && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  Create Flag
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Button onClick={fetchFlags} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Stats Cards - Teal themed */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {Object.entries(FLAG_TYPE_CONFIG).map(([type, config]) => {
          const Icon = config.icon;
          const count = globalCounts[type] ?? 0;
          return (
            <Card key={type} className="shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium capitalize">{type}</CardTitle>
                <div className={`p-2 rounded-lg ${config.color.split(" ")[0]} shadow-sm`}>
                  <Icon className={`h-4 w-4 ${config.color.split(" ")[1]}`} />
                </div>
              </CardHeader>
              <CardContent>
                <div className="font-serif text-[26px] font-medium">{count}</div>
                <p className="text-xs text-muted-foreground">Active</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Auto-resolve threshold settings card. The pg_cron job at 03:00 UTC
          (auto_resolve_stale_flags) reads app_settings.flags_auto_resolve_days
          and resolves any active flag older than that. Slider writes via
          admin_set_flags_auto_resolve_days RPC; commit on release to avoid
          one write per pixel of dragging. */}
      <Card className="bg-[#10151A] border-white/8 shadow-none shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Settings className="h-4 w-4 text-primary" />
            Auto-resolve stale flags
          </CardTitle>
        </CardHeader>
        <CardContent>
          {autoResolveDays === null ? (
            <p className="text-xs text-muted-foreground">Loading current threshold…</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Active flags older than this auto-resolve daily at 03:00 UTC.
                </span>
                <span className="font-mono text-primary font-medium">{autoResolveDays} day{autoResolveDays === 1 ? "" : "s"}</span>
              </div>
              <Slider
                min={1}
                max={365}
                step={1}
                value={[autoResolveDays]}
                onValueChange={(v) => setAutoResolveDays(v[0] ?? autoResolveDays)}
                onValueCommit={(v) => v[0] && handleSaveAutoResolveDays(v[0])}
                disabled={savingAutoResolve}
                aria-label="Auto-resolve threshold in days"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                <span>1d</span>
                <span>30d</span>
                <span>90d</span>
                <span>180d</span>
                <span>365d</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Flags Table */}
      <Card className="bg-[#10151A] border-white/8 shadow-none shadow-sm overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-lg">Flag History</CardTitle>
          {selectedFlagIds.size > 0 && (
            <Dialog open={bulkResolveOpen} onOpenChange={setBulkResolveOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="default" className="gap-1.5">
                  <CheckCircle className="h-3.5 w-3.5" />
                  Resolve {selectedFlagIds.size} flag{selectedFlagIds.size === 1 ? "" : "s"}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Bulk Resolve {selectedFlagIds.size} Flag{selectedFlagIds.size === 1 ? "" : "s"}</DialogTitle></DialogHeader>
                <div className="space-y-3 py-2">
                  <Label className="text-xs">Resolution Notes (applied to all selected)</Label>
                  <Textarea
                    placeholder="e.g. False positives — verified accounts manually."
                    value={bulkResolveNotes}
                    onChange={(e) => setBulkResolveNotes(e.target.value)}
                    rows={3}
                  />
                  <p className="text-xs text-muted-foreground">
                    Each flag will be marked resolved with these notes. This action is logged in admin_logs.
                  </p>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setBulkResolveOpen(false)} disabled={bulkResolving}>Cancel</Button>
                  <Button onClick={handleBulkResolve} disabled={bulkResolving}>
                    {bulkResolving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                    Resolve {selectedFlagIds.size}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </CardHeader>
        <CardContent className="p-0 sm:p-6">
          {data?.flags && data.flags.length > 0 ? (
            <>
              <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      {(() => {
                        const activeIds = data.flags.filter(f => !f.resolved_at).map(f => f.id);
                        const allSelected = activeIds.length > 0 && activeIds.every(id => selectedFlagIds.has(id));
                        return (
                          <Checkbox
                            checked={allSelected}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setSelectedFlagIds(new Set([...selectedFlagIds, ...activeIds]));
                              } else {
                                const next = new Set(selectedFlagIds);
                                activeIds.forEach(id => next.delete(id));
                                setSelectedFlagIds(next);
                              }
                            }}
                            aria-label="Select all active flags on this page"
                          />
                        );
                      })()}
                    </TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.flags.map((flag) => (
                    <TableRow key={flag.id}>
                      <TableCell>
                        {!flag.resolved_at && (
                          <Checkbox
                            checked={selectedFlagIds.has(flag.id)}
                            onCheckedChange={(checked) => {
                              const next = new Set(selectedFlagIds);
                              if (checked) next.add(flag.id);
                              else next.delete(flag.id);
                              setSelectedFlagIds(next);
                            }}
                            aria-label={`Select flag ${flag.id}`}
                          />
                        )}
                      </TableCell>
                      <TableCell>
                        <div>
                          <div className="font-medium">{flag.userName}</div>
                          <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {flag.user_id}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>{getFlagBadge(flag.flag_type)}</TableCell>
                      <TableCell className="max-w-[200px]">
                        <p className="truncate" title={flag.reason}>{flag.reason}</p>
                      </TableCell>
                      <TableCell>
                        {flag.resolved_at ? (
                          <Badge variant="outline" className="gap-1 bg-primary/10 text-primary border-primary/20">
                            <CheckCircle className="h-3 w-3" />
                            Resolved
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            Active
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {format(new Date(flag.created_at), "PP")}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button variant="ghost" size="sm">
                                <Eye className="h-4 w-4" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader>
                                <DialogTitle>Flag Details</DialogTitle>
                              </DialogHeader>
                              <div className="space-y-4">
                                <div>
                                  <Label className="text-muted-foreground">User</Label>
                                  <p className="font-medium">{flag.userName}</p>
                                  <p className="text-xs text-muted-foreground">{flag.user_id}</p>
                                </div>
                                <div>
                                  <Label className="text-muted-foreground">Type</Label>
                                  <div className="mt-1">{getFlagBadge(flag.flag_type)}</div>
                                </div>
                                <div>
                                  <Label className="text-muted-foreground">Reason</Label>
                                  <p>{flag.reason}</p>
                                </div>
                                {flag.details && (
                                  <div>
                                    <Label className="text-muted-foreground">Details</Label>
                                    <p className="text-sm">{flag.details}</p>
                                  </div>
                                )}
                                <div>
                                  <Label className="text-muted-foreground">Created</Label>
                                  <p>{format(new Date(flag.created_at), "PPpp")}</p>
                                </div>
                                {flag.resolved_at && (
                                  <>
                                    <div>
                                      <Label className="text-muted-foreground">Resolved</Label>
                                      <p>{format(new Date(flag.resolved_at), "PPpp")}</p>
                                    </div>
                                    {flag.resolution_notes && (
                                      <div>
                                        <Label className="text-muted-foreground">Resolution Notes</Label>
                                        <p className="text-sm">{flag.resolution_notes}</p>
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            </DialogContent>
                          </Dialog>
                          
                          {!flag.resolved_at && (
                            <Dialog>
                              <DialogTrigger asChild>
                                <Button variant="outline" size="sm">
                                  Resolve
                                </Button>
                              </DialogTrigger>
                              <DialogContent>
                                <DialogHeader>
                                  <DialogTitle>Resolve Flag</DialogTitle>
                                </DialogHeader>
                                <div className="space-y-4">
                                  <div>
                                    <Label>Resolution Notes</Label>
                                    <Textarea
                                      placeholder="Add notes about how this was resolved..."
                                      value={resolutionNotes}
                                      onChange={(e) => setResolutionNotes(e.target.value)}
                                      className="mt-2"
                                    />
                                  </div>
                                </div>
                                <DialogFooter>
                                  <Button
                                    onClick={() => handleResolve(flag.id)}
                                    disabled={resolvingId === flag.id}
                                  >
                                    {resolvingId === flag.id && (
                                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                    )}
                                    Mark as Resolved
                                  </Button>
                                </DialogFooter>
                              </DialogContent>
                            </Dialog>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>

              {/* Pagination */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-4 pt-4 border-t px-4 sm:px-0">
                <p className="text-sm text-muted-foreground">
                  Page {page}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span className="hidden sm:inline">Previous</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => p + 1)}
                    disabled={!data.flags || data.flags.length < 20}
                  >
                    <span className="hidden sm:inline">Next</span>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <EmptyState
              icon={Flag}
              title="No flags found"
              description="No user flags or warnings to review."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
