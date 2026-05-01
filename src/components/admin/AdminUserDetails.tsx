import { useEffect, useState } from "react";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Mail, CreditCard, Activity, Flag, Coins, DollarSign, ShieldAlert, ShieldX, ShieldCheck, RefreshCw, LogOut, Archive, Trash2, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AdminLoadingState } from "@/components/ui/admin-loading-state";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { format } from "date-fns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

interface UserDetails {
  user: {
    id: string;
    email: string;
    created_at: string;
    last_sign_in_at: string | null;
    email_confirmed_at: string | null;
  };
  profile: {
    display_name: string | null;
    avatar_url: string | null;
  } | null;
  subscription: {
    plan_name: string;
    status: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
  credits: {
    credits_balance: number;
    total_purchased: number;
    total_used: number;
  } | null;
  projectsCount: number;
  deletedProjectsCount: number;
  totalGenerationCost: number;
  totalGenerations: number;
  activeGenerations: number;
  archivedGenerations: number;
  userStatus: "active" | "suspended" | "banned";
  recentGenerations: Array<{
    id: string;
    status: string;
    created_at: string;
    completed_at: string | null;
  }>;
  flags: Array<{
    id: string;
    flag_type: string;
    reason: string;
    created_at: string;
    resolved_at: string | null;
  }>;
  recentUserLogs: Array<{id: string; category: string; event_type: string; message: string; details: Record<string, unknown> | null; created_at: string;}>;
  recentTransactions: Array<{
    id: string;
    amount: number;
    transaction_type: string;
    description: string | null;
    created_at: string;
  }>;
}

interface AdminUserDetailsProps {
  userId: string;
  onFlagCreated?: () => void;
}

export function AdminUserDetails({ userId, onFlagCreated }: AdminUserDetailsProps) {
  const { callAdminApi } = useAdminAuth();
  const [data, setData] = useState<UserDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionDialog, setActionDialog] = useState<{ type: "suspend" | "ban" | "unblock" | "force_signout"; open: boolean }>({ type: "suspend", open: false });
  const [actionReason, setActionReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  // Delete dialogs (separate from suspend/ban flow because both require
  // typed-confirm "delete <email>" 2-step per Jo's requirement).
  const [deleteDialog, setDeleteDialog] = useState<{ kind: "soft" | "hard" | null }>({ kind: null });
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Credit-grant modal state
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantAmount, setGrantAmount] = useState<string>("");
  const [grantReason, setGrantReason] = useState<string>("");
  const [granting, setGranting] = useState(false);

  async function handleGrantCredits() {
    const amt = parseInt(grantAmount, 10);
    if (!Number.isFinite(amt) || amt === 0) {
      toast.error("Enter a non-zero amount (positive to add, negative to subtract).");
      return;
    }
    if (amt > 1000000 || amt < -1000000) {
      toast.error("Amount must be between -1,000,000 and 1,000,000.");
      return;
    }
    setGranting(true);
    try {
      const { data: newBalance, error } = await supabase.rpc("admin_grant_credits", {
        p_target_user_id: userId,
        p_credits: amt,
        p_reason: grantReason.trim() || null,
      });
      if (error) throw error;
      toast.success(`Granted ${amt > 0 ? "+" : ""}${amt} credits. New balance: ${newBalance}`);
      setGrantOpen(false);
      setGrantAmount("");
      setGrantReason("");
      // Refresh details so the visible balance updates
      const result = await callAdminApi("user_details", { targetUserId: userId });
      if (result.ok && result.data) setData(result.data as UserDetails);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Grant failed");
    } finally {
      setGranting(false);
    }
  }

  const fetchDetails = async () => {
    try {
      setLoading(true);
      const result = await callAdminApi("user_details", { targetUserId: userId });
      setData(result as typeof data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load user details");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetails();
    // fetchDetails is redefined each render; stable deps are callAdminApi and userId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callAdminApi, userId]);

  const handleAction = async () => {
    if (!actionReason.trim() && actionDialog.type !== "unblock") {
      toast.error("Please provide a reason");
      return;
    }

    setActionLoading(true);
    try {
      if (actionDialog.type === "unblock") {
        // Resolve all active flags for this user via single-tx RPC
        // (admin_resolve_all_flags), avoiding the per-flag loop.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: rpcError } = await (supabase.rpc as any)(
          "admin_resolve_all_flags",
          {
            target_user_id: userId,
            resolution_notes: actionReason || "Unblocked by admin",
          },
        );
        if (rpcError) throw new Error(rpcError.message);
        toast.success("User unblocked successfully");
      } else if (actionDialog.type === "force_signout") {
        // Calls admin-force-signout edge fn — sets banned_until to 2099,
        // invalidating all current JWTs. Audit-logged server-side.
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        const url = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/admin-force-signout`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token ?? ""}`,
          },
          body: JSON.stringify({ user_id: userId, reason: actionReason }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Force sign-out failed (${res.status})`);
        }
        const body = await res.json();
        toast.success(`User signed out — banned_until ${body.banned_until ?? "set"}`);
      } else {
        await callAdminApi("create_flag", {
          userId: userId,
          flagType: actionDialog.type === "ban" ? "banned" : "suspended",
          reason: actionReason,
          details: `Action taken by admin`,
        });
        toast.success(`User ${actionDialog.type === "ban" ? "banned" : "suspended"} successfully`);
      }

      setActionDialog({ type: "suspend", open: false });
      setActionReason("");
      fetchDetails();
      onFlagCreated?.();
    } catch (err) {
      toast.error("Action failed", { description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return <AdminLoadingState />;
  }

  if (error || !data) {
    return (
      <div className="text-center py-12 space-y-4">
        <p className="text-destructive">{error || "No data available"}</p>
        {error && (
          <Button variant="outline" onClick={fetchDetails}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        )}
      </div>
    );
  }

  const getStatusBadge = () => {
    switch (data.userStatus) {
      case "banned":
        return <Badge variant="secondary" className="bg-muted text-muted-foreground">Banned</Badge>;
      case "suspended":
        return <Badge variant="secondary" className="bg-muted text-muted-foreground">Suspended</Badge>;
      default:
        return <Badge variant="default" className="bg-primary/15 text-primary border-0">Active</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {/* User Status & Actions */}
      <Card className="bg-[#10151A] border-white/8 shadow-none">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" />
              Account Status
            </CardTitle>
            {getStatusBadge()}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {data.userStatus === "active" ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setActionDialog({ type: "suspend", open: true })}
                  className="gap-1.5 text-warning border-warning/50 hover:bg-warning/10"
                >
                  <ShieldX className="h-3.5 w-3.5" />
                  Suspend
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setActionDialog({ type: "ban", open: true })}
                  className="gap-1.5 text-destructive border-destructive/50 hover:bg-destructive/10"
                >
                  <ShieldAlert className="h-3.5 w-3.5" />
                  Ban
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setActionDialog({ type: "unblock", open: true })}
                className="gap-1.5"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Unblock User
              </Button>
            )}
            {/* Force Sign Out — invalidates the user's existing JWT by
                setting auth.users.banned_until to far future. Available
                regardless of suspend/ban status; useful when an admin
                needs to immediately kick someone off without a flag. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setActionDialog({ type: "force_signout", open: true })}
              className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
              title="Invalidate this user's active JWT — they will be signed out everywhere on next request"
            >
              <LogOut className="h-3.5 w-3.5" />
              Force Sign Out
            </Button>

            {/* Soft delete: marks profiles.deleted_at + scrubs PII, but
                preserves all related data (projects, generations) for
                recovery. Reversible by clearing deleted_at. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setDeleteDialog({ kind: "soft" }); setDeleteConfirm(""); }}
              className="gap-1.5 text-warning border-warning/40 hover:bg-warning/10"
              title="Mark user as deleted, scrub display name + avatar. Reversible."
            >
              <Archive className="h-3.5 w-3.5" />
              Soft Delete
            </Button>

            {/* Hard delete: irreversible. auth.admin.deleteUser cascades
                across all FKs (profiles, projects, generations, etc.). */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setDeleteDialog({ kind: "hard" }); setDeleteConfirm(""); }}
              className="gap-1.5 text-destructive border-destructive hover:bg-destructive/10"
              title="Permanently delete user and cascade all data. NOT REVERSIBLE."
            >
              <Trash2 className="h-3.5 w-3.5" />
              Hard Delete
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* User Info - Two Column Layout */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="bg-[#10151A] border-white/8 shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              Account
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Email</span>
              <span>{data.user.email}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Display Name</span>
              <span>{data.profile?.display_name || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Verified</span>
              <Badge variant={data.user.email_confirmed_at ? "default" : "secondary"} className="text-xs px-1.5 py-0 h-4">
                {data.user.email_confirmed_at ? "Yes" : "No"}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Created</span>
              <span>{format(new Date(data.user.created_at), "PP")}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last Sign In</span>
              <span>{data.user.last_sign_in_at ? format(new Date(data.user.last_sign_in_at), "PP") : "—"}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-[#10151A] border-white/8 shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <CreditCard className="h-3.5 w-3.5" />
              Subscription
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Plan</span>
              <Badge variant="default" className="text-xs px-1.5 py-0 h-4 capitalize">
                {data.subscription?.plan_name || "Free"}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <Badge variant={data.subscription?.status === "active" ? "default" : "secondary"} className="text-xs px-1.5 py-0 h-4">
                {data.subscription?.status || "None"}
              </Badge>
            </div>
            {data.subscription?.current_period_end && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Renewal</span>
                <span>{format(new Date(data.subscription.current_period_end), "PP")}</span>
              </div>
            )}
            {data.subscription?.cancel_at_period_end && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Cancels</span>
                <span>At period end</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Compact Stats Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="bg-[#10151A] border-white/8 shadow-none p-3 relative">
          <div className="flex items-center justify-between gap-2 text-muted-foreground mb-1">
            <div className="flex items-center gap-2">
              <Coins className="h-3.5 w-3.5" />
              <span className="text-xs uppercase tracking-wide">Credits</span>
            </div>
            <button
              type="button"
              onClick={() => setGrantOpen(true)}
              className="rounded-md p-1 text-[#11C4D0] hover:bg-[#11C4D0]/10 transition-colors"
              aria-label="Grant credits to user"
              title="Grant credits"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="text-lg">{data.credits?.credits_balance || 0}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {data.credits?.total_purchased || 0} bought · {data.credits?.total_used || 0} used
          </div>
        </Card>

        <Card className="bg-[#10151A] border-white/8 shadow-none p-3">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <DollarSign className="h-3.5 w-3.5" />
            <span className="text-xs uppercase tracking-wide">Cost</span>
          </div>
          <div className="text-lg">${data.totalGenerationCost.toFixed(2)}</div>
          <div className="text-xs text-muted-foreground mt-0.5">Total generation</div>
        </Card>

        <Card className="bg-[#10151A] border-white/8 shadow-none p-3">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Activity className="h-3.5 w-3.5" />
            <span className="text-xs uppercase tracking-wide">Activity</span>
          </div>
          <div className="text-lg">{data.totalGenerations || 0}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {data.activeGenerations || 0} active · {data.archivedGenerations || 0} deleted
          </div>
        </Card>

        <Card className="bg-[#10151A] border-white/8 shadow-none p-3">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Flag className="h-3.5 w-3.5" />
            <span className="text-xs uppercase tracking-wide">Flags</span>
          </div>
          <div className="text-lg">{data.flags?.filter(f => !f.resolved_at).length || 0}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {data.flags?.length || 0} total
          </div>
        </Card>
      </div>

      {/* Collapsible sections: Logs, Transactions, Flags */}
      <Accordion type="multiple" defaultValue={data.flags && data.flags.length > 0 ? ["flags"] : []}>

      {/* Worker System Logs */}
      {data.recentUserLogs && data.recentUserLogs.length > 0 && (
        <Card className="bg-[#10151A] border-white/8 shadow-none">
          <AccordionItem value="logs" className="border-0">
          <AccordionTrigger className="px-6 py-4 text-sm font-medium hover:no-underline">
            Worker System Logs ({data.recentUserLogs.length})
          </AccordionTrigger>
          <AccordionContent>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentUserLogs.slice(0, 15).map((log) => (
                  <TableRow key={log.id}>
                    <TableCell>
                      <Badge variant={log.category === "system_error" ? "destructive" : log.category === "system_warning" ? "secondary" : "default"}>
                        {log.category.replace("system_", "")}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{log.event_type}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{log.message}</TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {format(new Date(log.created_at), "MMM d HH:mm:ss")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
          </AccordionContent>
          </AccordionItem>
        </Card>
      )}

      {/* Recent Transactions */}
      {data.recentTransactions && data.recentTransactions.length > 0 && (
        <Card className="bg-[#10151A] border-white/8 shadow-none">
          <AccordionItem value="transactions" className="border-0">
          <AccordionTrigger className="px-6 py-4 text-sm font-medium hover:no-underline">
            Recent Transactions ({data.recentTransactions.length})
          </AccordionTrigger>
          <AccordionContent>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentTransactions.slice(0, 10).map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell>
                      <Badge variant={tx.transaction_type === "purchase" ? "default" : "secondary"}>
                        {tx.transaction_type}
                      </Badge>
                    </TableCell>
                    <TableCell className={tx.amount > 0 ? "text-primary" : "text-muted-foreground"}>
                      {tx.amount > 0 ? "+" : ""}{tx.amount}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{tx.description || "-"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(tx.created_at), "PP")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
          </AccordionContent>
          </AccordionItem>
        </Card>
      )}

      {/* User Flags — full history (active + resolved) sorted with active
          first then resolved by created_at desc, so admins can spot patterns
          across the full lifetime of the account. Includes resolved_at column
          for resolved rows so the cadence is visible. */}
      {data.flags && data.flags.length > 0 && (
        <Card className="bg-[#10151A] border-white/8 shadow-none">
          <AccordionItem value="flags" className="border-0">
          <AccordionTrigger className="px-6 py-4 text-sm font-medium hover:no-underline">
            Flag History ({data.flags.length} total · {data.flags.filter(f => !f.resolved_at).length} active)
          </AccordionTrigger>
          <AccordionContent>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Resolved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...data.flags]
                  .sort((a, b) => {
                    const aActive = !a.resolved_at;
                    const bActive = !b.resolved_at;
                    if (aActive !== bActive) return aActive ? -1 : 1;
                    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
                  })
                  .map((flag) => (
                  <TableRow key={flag.id}>
                    <TableCell>
                      <Badge variant="secondary" className="font-normal">
                        {flag.flag_type}
                      </Badge>
                    </TableCell>
                    <TableCell>{flag.reason}</TableCell>
                    <TableCell>
                      <Badge variant={flag.resolved_at ? "outline" : "secondary"} className="font-normal">
                        {flag.resolved_at ? "Resolved" : "Active"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {format(new Date(flag.created_at), "PPp")}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {flag.resolved_at ? format(new Date(flag.resolved_at), "PPp") : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
          </AccordionContent>
          </AccordionItem>
        </Card>
      )}

      </Accordion>

      {/* Delete dialogs (soft + hard share the same confirm gate but
          different copy and different backend calls). Confirmation must
          exactly match the user's email — typo-proof against accidental
          deletion of the wrong account. */}
      <Dialog open={deleteDialog.kind !== null} onOpenChange={(open) => !open && setDeleteDialog({ kind: null })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {deleteDialog.kind === "soft" ? <Archive className="h-5 w-5 text-warning" /> : <Trash2 className="h-5 w-5 text-destructive" />}
              {deleteDialog.kind === "soft" ? "Soft Delete User" : "Permanently Delete User"}
            </DialogTitle>
            <DialogDescription>
              {deleteDialog.kind === "soft" ? (
                <>This marks <span className="font-mono text-foreground">{data.user.email}</span> as deleted, scrubs their display name and avatar, but preserves all related data. Reversible by an admin manually clearing <span className="font-mono">profiles.deleted_at</span>.</>
              ) : (
                <>This <span className="text-destructive font-bold">permanently deletes</span> <span className="font-mono text-foreground">{data.user.email}</span> and cascades across every table referencing this user (projects, generations, transactions, flags, etc.). <span className="text-destructive font-bold">NOT REVERSIBLE.</span></>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label className="text-xs">
              To confirm, type the user's email below: <span className="font-mono">{data.user.email}</span>
            </Label>
            <Input
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={data.user.email}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialog({ kind: null })} disabled={deleting}>Cancel</Button>
            <Button
              variant={deleteDialog.kind === "hard" ? "destructive" : "default"}
              disabled={deleting || deleteConfirm.trim().toLowerCase() !== data.user.email.toLowerCase()}
              onClick={async () => {
                setDeleting(true);
                try {
                  if (deleteDialog.kind === "soft") {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const { data: rowCount, error } = await (supabase.rpc as any)(
                      "admin_soft_delete_user",
                      { target_user_id: userId },
                    );
                    if (error) throw error;
                    toast.success(`Soft-deleted ${rowCount} user record`);
                    setDeleteDialog({ kind: null });
                    fetchDetails();
                    onFlagCreated?.();
                  } else {
                    // Hard delete via edge function — cascades everything.
                    const { data: sessionData } = await supabase.auth.getSession();
                    const token = sessionData.session?.access_token;
                    const url = `${import.meta.env.VITE_SUPABASE_URL ?? ""}/functions/v1/admin-hard-delete-user`;
                    const res = await fetch(url, {
                      method: "POST",
                      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` },
                      body: JSON.stringify({ user_id: userId, confirmation: deleteConfirm.trim() }),
                    });
                    if (!res.ok) {
                      const body = await res.json().catch(() => ({}));
                      throw new Error(body.error || `Hard delete failed (${res.status})`);
                    }
                    toast.success(`User ${data.user.email} permanently deleted`);
                    setDeleteDialog({ kind: null });
                    onFlagCreated?.();
                  }
                } catch (err) {
                  toast.error("Delete failed", { description: err instanceof Error ? err.message : "Please try again." });
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {deleteDialog.kind === "soft" ? "Soft Delete" : "Delete Permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Action Dialog */}
      <Dialog open={actionDialog.open} onOpenChange={(open) => setActionDialog(prev => ({ ...prev, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionDialog.type === "ban" && "Ban User"}
              {actionDialog.type === "suspend" && "Suspend User"}
              {actionDialog.type === "unblock" && "Unblock User"}
              {actionDialog.type === "force_signout" && "Force Sign Out"}
            </DialogTitle>
            <DialogDescription>
              {actionDialog.type === "ban" && "This will permanently ban the user from accessing the platform."}
              {actionDialog.type === "suspend" && "This will temporarily suspend the user's access."}
              {actionDialog.type === "unblock" && "This will resolve all active flags and restore the user's access."}
              {actionDialog.type === "force_signout" && "This will invalidate the user's active JWT by setting banned_until to year 2099. They will be signed out on their next request. Audit-logged."}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              placeholder={actionDialog.type === "unblock" ? "Resolution notes (optional)" : "Reason for this action..."}
              value={actionReason}
              onChange={(e) => setActionReason(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionDialog({ type: "suspend", open: false })}>
              Cancel
            </Button>
            <Button
              onClick={handleAction}
              disabled={actionLoading}
              variant={actionDialog.type === "ban" ? "destructive" : "default"}
              className={actionDialog.type === "suspend" ? "bg-warning text-warning-foreground hover:bg-warning/90" : ""}
            >
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {actionDialog.type === "ban" && "Permanently Ban User"}
              {actionDialog.type === "suspend" && "Suspend User"}
              {actionDialog.type === "unblock" && "Unblock User"}
              {actionDialog.type === "force_signout" && "Force Sign Out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Credit-grant modal */}
      <Dialog open={grantOpen} onOpenChange={(open) => { if (!granting) setGrantOpen(open); }}>
        <DialogContent className="bg-[#10151A] border-white/10 text-[#ECEAE4]">
          <DialogHeader>
            <DialogTitle className="text-[#ECEAE4]">Grant credits</DialogTitle>
            <DialogDescription className="text-[#8A9198]">
              Add or subtract credits for {data.user.email}. Use a negative number to deduct.
              Current balance: <span className="text-[#ECEAE4]">{data.credits?.credits_balance ?? 0}</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="grant-amount" className="text-[12px] text-[#ECEAE4]">Amount (credits)</Label>
              <Input
                id="grant-amount"
                type="number"
                inputMode="numeric"
                placeholder="e.g. 100 or -50"
                value={grantAmount}
                onChange={(e) => setGrantAmount(e.target.value)}
                className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4]"
              />
              <div className="flex flex-wrap gap-1.5">
                {[50, 100, 250, 500, 1000].map((v) => (
                  <Button
                    key={v}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setGrantAmount(String(v))}
                    className="h-7 px-2 border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5 text-[11px]"
                  >
                    +{v}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="grant-reason" className="text-[12px] text-[#ECEAE4]">Reason (audit log)</Label>
              <Textarea
                id="grant-reason"
                placeholder="e.g. Refund for failed render — ticket #MM-1234"
                value={grantReason}
                onChange={(e) => setGrantReason(e.target.value)}
                rows={2}
                className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4] resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setGrantOpen(false)}
              disabled={granting}
              className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
            >
              Cancel
            </Button>
            <Button
              onClick={handleGrantCredits}
              disabled={granting || !grantAmount.trim()}
              className="bg-[#11C4D0] text-[#0A0D0F] hover:bg-[#11C4D0]/90"
            >
              {granting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
              {granting ? "Granting…" : "Grant credits"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
