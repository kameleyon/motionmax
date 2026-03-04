import { useEffect, useState } from "react";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Mail, Calendar, CreditCard, Activity, Flag, Coins, DollarSign, Trash2, ShieldAlert, ShieldX, ShieldCheck } from "lucide-react";
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
  const { callAdminApi, user: adminUser } = useAdminAuth();
  const [data, setData] = useState<UserDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionDialog, setActionDialog] = useState<{ type: "suspend" | "ban" | "unblock"; open: boolean }>({ type: "suspend", open: false });
  const [actionReason, setActionReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const fetchDetails = async () => {
    try {
      setLoading(true);
      const result = await callAdminApi("user_details", { targetUserId: userId });
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load user details");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetails();
  }, [callAdminApi, userId]);

  const handleAction = async () => {
    if (!actionReason.trim() && actionDialog.type !== "unblock") {
      toast.error("Please provide a reason");
      return;
    }

    setActionLoading(true);
    try {
      if (actionDialog.type === "unblock") {
        // Resolve all active flags for this user
        const activeFlags = data?.flags?.filter(f => !f.resolved_at) || [];
        for (const flag of activeFlags) {
          await callAdminApi("resolve_flag", {
            flagId: flag.id,
            resolutionNotes: actionReason || "Unblocked by admin",
          });
        }
        toast.success("User unblocked successfully");
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
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">{error || "No data available"}</p>
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
      <Card>
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
                  className="gap-1.5"
                >
                  <ShieldX className="h-3.5 w-3.5" />
                  Suspend
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setActionDialog({ type: "ban", open: true })}
                  className="gap-1.5"
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
          </div>
        </CardContent>
      </Card>

      {/* User Info - Two Column Layout */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
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
              <Badge variant={data.user.email_confirmed_at ? "default" : "secondary"} className="text-[10px] px-1.5 py-0 h-4">
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

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <CreditCard className="h-3.5 w-3.5" />
              Subscription
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Plan</span>
              <Badge variant="default" className="text-[10px] px-1.5 py-0 h-4 capitalize">
                {data.subscription?.plan_name || "Free"}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <Badge variant={data.subscription?.status === "active" ? "default" : "secondary"} className="text-[10px] px-1.5 py-0 h-4">
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
      <div className="grid grid-cols-4 gap-3">
        <Card className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Coins className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wide">Credits</span>
          </div>
          <div className="text-lg">{data.credits?.credits_balance || 0}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">
            {data.credits?.total_purchased || 0} bought · {data.credits?.total_used || 0} used
          </div>
        </Card>

        <Card className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <DollarSign className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wide">Cost</span>
          </div>
          <div className="text-lg">${data.totalGenerationCost.toFixed(2)}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">Total generation</div>
        </Card>

        <Card className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Activity className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wide">Activity</span>
          </div>
          <div className="text-lg">{data.totalGenerations || 0}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">
            {data.activeGenerations || 0} active · {data.archivedGenerations || 0} deleted
          </div>
        </Card>

        <Card className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <Flag className="h-3.5 w-3.5" />
            <span className="text-[10px] uppercase tracking-wide">Flags</span>
          </div>
          <div className="text-lg">{data.flags?.filter(f => !f.resolved_at).length || 0}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">
            {data.flags?.length || 0} total
          </div>
        </Card>
      </div>

      {/* Recent Transactions */}
      {data.recentTransactions && data.recentTransactions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Recent Transactions</CardTitle>
          </CardHeader>
          <CardContent>
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
        </Card>
      )}

      {/* Flags */}
      {data.flags && data.flags.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">User Flags</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.flags.map((flag) => (
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
                    <TableCell className="text-muted-foreground">
                      {format(new Date(flag.created_at), "PP")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Action Dialog */}
      <Dialog open={actionDialog.open} onOpenChange={(open) => setActionDialog(prev => ({ ...prev, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionDialog.type === "ban" && "Ban User"}
              {actionDialog.type === "suspend" && "Suspend User"}
              {actionDialog.type === "unblock" && "Unblock User"}
            </DialogTitle>
            <DialogDescription>
              {actionDialog.type === "ban" && "This will permanently ban the user from accessing the platform."}
              {actionDialog.type === "suspend" && "This will temporarily suspend the user's access."}
              {actionDialog.type === "unblock" && "This will resolve all active flags and restore the user's access."}
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
            <Button onClick={handleAction} disabled={actionLoading}>
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {actionDialog.type === "ban" && "Ban User"}
              {actionDialog.type === "suspend" && "Suspend User"}
              {actionDialog.type === "unblock" && "Unblock User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
