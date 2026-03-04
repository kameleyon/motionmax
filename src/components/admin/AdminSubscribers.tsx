import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { Loader2, Search, ChevronLeft, ChevronRight, Eye, AlertTriangle, DollarSign } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AdminUserDetails } from "./AdminUserDetails";
import { format } from "date-fns";

interface CostBreakdown {
  openrouter: number;
  replicate: number;
  hypereal: number;
  googleTts: number;
  total: number;
}

interface Subscriber {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: string;
  lastSignIn: string | null;
  plan: string;
  status: string;
  creditsBalance: number;
  totalPurchased: number;
  totalUsed: number;
  generationCount: number;
  flagCount: number;
  costs?: CostBreakdown;
}

interface SubscribersResponse {
  users: Subscriber[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export function AdminSubscribers() {
  const { callAdminApi } = useAdminAuth();
  const [data, setData] = useState<SubscribersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const fetchSubscribers = useCallback(async () => {
    try {
      setLoading(true);
      const result = await callAdminApi("subscribers_list", { page, search, limit: 20 });
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load subscribers");
    } finally {
      setLoading(false);
    }
  }, [callAdminApi, page, search]);

  useEffect(() => {
    const debounce = setTimeout(() => {
      fetchSubscribers();
    }, 300);

    return () => clearTimeout(debounce);
  }, [fetchSubscribers]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchSubscribers();
  };

  const getPlanBadge = (plan: string) => {
    const isDefault = plan === "free";
    return (
      <span className={`text-[10px] px-2 py-0.5 rounded-full capitalize ${
        isDefault 
          ? "bg-muted text-muted-foreground" 
          : "bg-primary/15 text-primary"
      }`}>
        {plan}
      </span>
    );
  };

  const getStatusBadge = (user: Subscriber) => {
    const hasActiveFlags = user.flagCount > 0;
    if (hasActiveFlags) {
      return (
        <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
          <AlertTriangle className="h-2.5 w-2.5" />
          flagged
        </span>
      );
    }
    return (
      <span className="text-[10px] text-primary">
        active
      </span>
    );
  };

  const formatCost = (cost: number | undefined) => {
    if (cost === undefined || cost === null) return "$0.00";
    return `$${cost.toFixed(4)}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <div>
          <h2 className="text-2xl font-bold">Subscribers</h2>
          <p className="text-muted-foreground">
            {data?.total || 0} total users
          </p>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by email or name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </div>

      <Card className="shadow-sm overflow-hidden">
        <CardHeader>
          <CardTitle className="text-lg">User List</CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <p className="text-destructive">{error}</p>
            </div>
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden lg:block">
                <Table>
                  <TableHeader>
                    <TableRow className="text-xs">
                      <TableHead className="py-2 px-2">User</TableHead>
                      <TableHead className="py-2 px-2">Plan</TableHead>
                      <TableHead className="py-2 px-2 text-center">Credits</TableHead>
                      <TableHead className="py-2 px-2 text-center">Gens</TableHead>
                      <TableHead className="py-2 px-2 text-center">Flags</TableHead>
                      <TableHead className="py-2 px-2">Costs</TableHead>
                      <TableHead className="py-2 px-2">Joined</TableHead>
                      <TableHead className="py-2 px-2 w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.users.map((user) => (
                      <TableRow key={user.id} className="text-xs">
                        <TableCell className="py-2 px-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <Avatar className="h-6 w-6 shrink-0">
                              <AvatarImage src={user.avatarUrl || undefined} />
                              <AvatarFallback className="text-[10px]">
                                {user.displayName?.charAt(0)?.toUpperCase() || "U"}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <div className="font-medium truncate max-w-[120px]">{user.displayName}</div>
                              <div className="text-muted-foreground truncate max-w-[120px]">{user.email}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="py-2 px-2">{getPlanBadge(user.plan)}</TableCell>
                        <TableCell className="py-2 px-2 text-center whitespace-nowrap">
                          <span className="font-medium">{user.creditsBalance}</span>
                          <span className="text-muted-foreground">/{user.totalPurchased}</span>
                        </TableCell>
                        <TableCell className="py-2 px-2 text-center font-medium">{user.generationCount}</TableCell>
                        <TableCell className="py-2 px-2 text-center">
                          {user.flagCount > 0 ? (
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                              <AlertTriangle className="h-2.5 w-2.5" />
                              {user.flagCount}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                        <TableCell className="py-2 px-2">
                          {user.costs ? (
                            <Dialog>
                              <DialogTrigger asChild>
                                <Button variant="ghost" size="sm" className="h-auto py-0.5 px-1 text-left">
                                  <span className="font-medium text-primary text-xs">
                                    {formatCost(user.costs.total)}
                                  </span>
                                </Button>
                              </DialogTrigger>
                              <DialogContent className="max-w-sm">
                                <DialogHeader>
                                  <DialogTitle className="text-sm">Costs: {user.displayName}</DialogTitle>
                                </DialogHeader>
                                <div className="space-y-3">
                                  <div className="grid grid-cols-2 gap-2">
                                    <div className="p-3 rounded-lg bg-card border shadow-sm">
                                      <p className="text-xs text-muted-foreground">OpenRouter</p>
                                      <p className="text-lg font-bold text-primary">{formatCost(user.costs.openrouter)}</p>
                                    </div>
                                    <div className="p-3 rounded-lg bg-card border shadow-sm">
                                      <p className="text-xs text-muted-foreground">Replicate</p>
                                      <p className="text-lg font-bold text-primary">{formatCost(user.costs.replicate)}</p>
                                    </div>
                                    <div className="p-3 rounded-lg bg-card border shadow-sm">
                                      <p className="text-xs text-muted-foreground">Hypereal</p>
                                      <p className="text-lg font-bold text-primary">{formatCost(user.costs.hypereal)}</p>
                                    </div>
                                    <div className="p-3 rounded-lg bg-card border shadow-sm">
                                      <p className="text-xs text-muted-foreground">Google TTS</p>
                                      <p className="text-lg font-bold text-primary">{formatCost(user.costs.googleTts)}</p>
                                    </div>
                                  </div>
                                  <div className="p-3 rounded-lg bg-card border border-primary shadow-sm">
                                    <p className="text-xs text-muted-foreground">Total Cost</p>
                                    <p className="text-xl font-bold text-primary">{formatCost(user.costs.total)}</p>
                                  </div>
                                </div>
                              </DialogContent>
                            </Dialog>
                          ) : (
                            <span className="text-muted-foreground">$0.00</span>
                          )}
                        </TableCell>
                        <TableCell className="py-2 px-2 text-muted-foreground whitespace-nowrap">
                          {format(new Date(user.createdAt), "MM/dd/yy")}
                        </TableCell>
                        <TableCell className="py-2 px-2">
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                                onClick={() => setSelectedUserId(user.id)}
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto p-6">
                              <DialogHeader>
                                <DialogTitle>User Details</DialogTitle>
                              </DialogHeader>
                              <AdminUserDetails userId={user.id} />
                            </DialogContent>
                          </Dialog>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile/Tablet Card Layout */}
              <div className="lg:hidden divide-y">
                {data?.users.map((user) => (
                  <div key={user.id} className="p-3 space-y-1.5 text-xs">
                    {/* Row 1: Name | Plan + Eye */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Avatar className="h-6 w-6 shrink-0">
                          <AvatarImage src={user.avatarUrl || undefined} />
                          <AvatarFallback className="text-[10px]">
                            {user.displayName?.charAt(0)?.toUpperCase() || "U"}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-medium truncate">{user.displayName}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {getStatusBadge(user)}
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0"
                              onClick={() => setSelectedUserId(user.id)}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto p-6">
                            <DialogHeader>
                              <DialogTitle>User Details</DialogTitle>
                            </DialogHeader>
                            <AdminUserDetails userId={user.id} />
                          </DialogContent>
                        </Dialog>
                      </div>
                    </div>

                    {/* Row 2: Plan | Credits, Projects, Flags */}
                    <div className="flex items-center justify-between gap-2">
                      {getPlanBadge(user.plan)}
                      <div className="flex items-center gap-3 shrink-0 text-muted-foreground">
                        <span>
                          <span className="font-medium text-foreground">{user.creditsBalance}</span>
                          <span className="text-[10px]">cr</span>
                        </span>
                        <span>
                          <span className="font-medium text-foreground">{user.generationCount}</span>
                          <span className="text-[10px]">gen</span>
                        </span>
                        {user.flagCount > 0 ? (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                            <AlertTriangle className="h-2.5 w-2.5" />
                            {user.flagCount}
                          </span>
                        ) : (
                          <span>
                            <span className="font-medium text-foreground">0</span>
                            <span className="text-[10px]">fl</span>
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Row 3: Joined | Costs */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">
                        Joined {format(new Date(user.createdAt), "MM/dd/yy")}
                      </span>
                      <div className="shrink-0">
                        {user.costs ? (
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-auto py-0.5 px-1 text-left">
                                <DollarSign className="h-3 w-3 mr-0.5" />
                                <span className="font-medium text-primary text-xs">
                                  {formatCost(user.costs.total)}
                                </span>
                              </Button>
                            </DialogTrigger>
                            <DialogContent className="max-w-sm">
                              <DialogHeader>
                                <DialogTitle className="text-sm">Costs: {user.displayName}</DialogTitle>
                              </DialogHeader>
                              <div className="space-y-3">
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="p-3 rounded-lg bg-card border shadow-sm">
                                    <p className="text-xs text-muted-foreground">OpenRouter</p>
                                    <p className="text-lg font-bold text-primary">{formatCost(user.costs.openrouter)}</p>
                                  </div>
                                  <div className="p-3 rounded-lg bg-card border shadow-sm">
                                    <p className="text-xs text-muted-foreground">Replicate</p>
                                    <p className="text-lg font-bold text-primary">{formatCost(user.costs.replicate)}</p>
                                  </div>
                                  <div className="p-3 rounded-lg bg-card border shadow-sm">
                                    <p className="text-xs text-muted-foreground">Hypereal</p>
                                    <p className="text-lg font-bold text-primary">{formatCost(user.costs.hypereal)}</p>
                                  </div>
                                  <div className="p-3 rounded-lg bg-card border shadow-sm">
                                    <p className="text-xs text-muted-foreground">Google TTS</p>
                                    <p className="text-lg font-bold text-primary">{formatCost(user.costs.googleTts)}</p>
                                  </div>
                                </div>
                                <div className="p-3 rounded-lg bg-card border border-primary shadow-sm">
                                  <p className="text-xs text-muted-foreground">Total Cost</p>
                                  <p className="text-xl font-bold text-primary">{formatCost(user.costs.total)}</p>
                                </div>
                              </div>
                            </DialogContent>
                          </Dialog>
                        ) : (
                          <span className="text-muted-foreground text-xs">$0.00</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {data && data.totalPages > 1 && (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-4 pt-4 border-t px-4 sm:px-0">
                  <p className="text-sm text-muted-foreground">
                    Showing {((page - 1) * data.limit) + 1} to {Math.min(page * data.limit, data.total)} of {data.total}
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
                      onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                      disabled={page === data.totalPages}
                    >
                      <span className="hidden sm:inline">Next</span>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
