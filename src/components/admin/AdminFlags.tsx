import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { Loader2, Flag, CheckCircle, AlertTriangle, Ban, RefreshCw, ChevronLeft, ChevronRight, Eye } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { format } from "date-fns";
import { toast } from "@/hooks/use-toast";

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

  const fetchFlags = useCallback(async () => {
    try {
      setLoading(true);
      const result = await callAdminApi("flags_list", { page, limit: 20, includeResolved });
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load flags");
    } finally {
      setLoading(false);
    }
  }, [callAdminApi, page, includeResolved]);

  useEffect(() => {
    fetchFlags();
  }, [fetchFlags]);

  const handleResolve = async (flagId: string) => {
    try {
      setResolvingId(flagId);
      await callAdminApi("resolve_flag", { flagId, resolutionNotes });
      toast({
        title: "Flag resolved",
        description: "The flag has been marked as resolved",
      });
      setResolutionNotes("");
      fetchFlags();
    } catch (err) {
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to resolve flag",
        variant: "destructive",
      });
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

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
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
          <h2 className="text-2xl font-bold">User Flags</h2>
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
          const count = data?.flags?.filter(f => f.flag_type === type && !f.resolved_at).length || 0;
          return (
            <Card key={type} className="shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium capitalize">{type}</CardTitle>
                <div className={`p-2 rounded-lg ${config.color.split(" ")[0]} shadow-sm`}>
                  <Icon className={`h-4 w-4 ${config.color.split(" ")[1]}`} />
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{count}</div>
                <p className="text-xs text-muted-foreground">Active</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Flags Table */}
      <Card className="shadow-sm overflow-hidden">
        <CardHeader>
          <CardTitle className="text-lg">Flag History</CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-6">
          {data?.flags && data.flags.length > 0 ? (
            <>
              <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
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
            <div className="text-center py-12 text-muted-foreground">
              <Flag className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No flags found</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
