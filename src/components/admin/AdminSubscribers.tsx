import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { Search, ChevronLeft, ChevronRight, Eye, AlertTriangle, DollarSign, ArrowUpDown, ArrowUp, ArrowDown, RefreshCw } from "lucide-react";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  const [sortField, setSortField] = useState<string>("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [planFilter, setPlanFilter] = useState<string>("all");

  const fetchSubscribers = useCallback(async () => {
    try {
      setLoading(true);
      const result = await callAdminApi("subscribers_list", { page, search, limit: 50 });
      setData(result as typeof data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load subscribers");
    } finally {
      setLoading(false);
    }
  }, [callAdminApi, page, search]);

  useEffect(() => {
    const debounce = setTimeout(() => { fetchSubscribers(); }, 300);
    return () => clearTimeout(debounce);
  }, [fetchSubscribers]);

  // Client-side sort + filter (API returns all users, we sort/filter locally)
  const sortedUsers = (() => {
    if (!data?.users) return [];
    let users = [...data.users];

    // Plan filter
    if (planFilter !== "all") {
      users = users.filter(u => u.plan === planFilter);
    }

    // Sort
    users.sort((a, b) => {
      let av: number | string = 0, bv: number | string = 0;
      switch (sortField) {
        case "plan": av = a.plan; bv = b.plan; break;
        case "credits": av = a.creditsBalance; bv = b.creditsBalance; break;
        case "generations": av = a.generationCount; bv = b.generationCount; break;
        case "flags": av = a.flagCount; bv = b.flagCount; break;
        case "createdAt": av = a.createdAt; bv = b.createdAt; break;
        case "costs": av = a.costs?.total || 0; bv = b.costs?.total || 0; break;
        default: av = a.createdAt; bv = b.createdAt;
      }
      if (typeof av === "string" && typeof bv === "string") {
        return sortOrder === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortOrder === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });

    return users;
  })();

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(prev => prev === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 text-muted-foreground/50" />;
    return sortOrder === "asc" ? <ArrowUp className="h-3 w-3 text-primary" /> : <ArrowDown className="h-3 w-3 text-primary" />;
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchSubscribers();
  };

  const getPlanBadge = (plan: string) => {
    const isDefault = plan === "free";
    return (
      <Badge variant={isDefault ? "secondary" : "default"} className="capitalize">
        {plan}
      </Badge>
    );
  };

  const getStatusBadge = (user: Subscriber) => {
    const hasActiveFlags = user.flagCount > 0;
    if (hasActiveFlags) {
      return (
        <span className="text-xs text-muted-foreground flex items-center gap-0.5">
          <AlertTriangle className="h-2.5 w-2.5" />
          flagged
        </span>
      );
    }
    return (
      <span className="text-xs text-primary">
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
          <h2 className="font-serif text-[26px] font-medium">Subscribers</h2>
          <p className="text-muted-foreground">
            {data?.total || 0} total users
          </p>
        </div>

        <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-56">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search email or name..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-9"
            />
          </div>
          <Select value={planFilter} onValueChange={(v) => { setPlanFilter(v); setPage(1); }}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Plan" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Plans</SelectItem>
              <SelectItem value="free">Free</SelectItem>
              <SelectItem value="starter">Starter</SelectItem>
              <SelectItem value="creator">Creator</SelectItem>
              <SelectItem value="professional">Professional</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="bg-[#10151A] border-white/8 shadow-none shadow-sm overflow-hidden">
        <CardHeader>
          <CardTitle className="text-lg">User List</CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-6">
          {loading ? (
            <LoadingSpinner className="py-12" />
          ) : error ? (
            <div className="text-center py-12 space-y-4">
              <p className="text-destructive">{error}</p>
              <Button onClick={fetchSubscribers} variant="outline">
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            </div>
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden lg:block">
                <Table><caption className="sr-only">Subscriber list</caption>
                  <TableHeader>
                    <TableRow className="text-xs">
                      <TableHead className="py-2 px-2">User</TableHead>
                      <TableHead className="py-2 px-2 cursor-pointer select-none" onClick={() => toggleSort("plan")}>
                        <span className="flex items-center gap-1">Plan <SortIcon field="plan" /></span>
                      </TableHead>
                      <TableHead className="py-2 px-2 text-center cursor-pointer select-none" onClick={() => toggleSort("credits")}>
                        <span className="flex items-center justify-center gap-1">Credits <SortIcon field="credits" /></span>
                      </TableHead>
                      <TableHead className="py-2 px-2 text-center cursor-pointer select-none" onClick={() => toggleSort("generations")}>
                        <span className="flex items-center justify-center gap-1">Gens <SortIcon field="generations" /></span>
                      </TableHead>
                      <TableHead className="py-2 px-2 text-center cursor-pointer select-none" onClick={() => toggleSort("flags")}>
                        <span className="flex items-center justify-center gap-1">Flags <SortIcon field="flags" /></span>
                      </TableHead>
                      <TableHead className="py-2 px-2 cursor-pointer select-none" onClick={() => toggleSort("costs")}>
                        <span className="flex items-center gap-1">Costs <SortIcon field="costs" /></span>
                      </TableHead>
                      <TableHead className="py-2 px-2 cursor-pointer select-none" onClick={() => toggleSort("createdAt")}>
                        <span className="flex items-center gap-1">Joined <SortIcon field="createdAt" /></span>
                      </TableHead>
                      <TableHead className="py-2 px-2 w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedUsers.map((user) => (
                      <TableRow key={user.id} className="text-xs">
                        <TableCell className="py-2 px-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <Avatar className="h-6 w-6 shrink-0">
                              <AvatarImage src={user.avatarUrl || undefined} />
                              <AvatarFallback className="text-xs">
                                {user.displayName?.charAt(0)?.toUpperCase() || "U"}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <div className="font-medium truncate max-w-[200px]">{user.displayName}</div>
                              <div className="text-muted-foreground truncate max-w-[200px]">{user.email}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="py-2 px-2">{getPlanBadge(user.plan)}</TableCell>
                        <TableCell className="py-2 px-2 text-center whitespace-nowrap">
                          <span className="font-medium">{user.creditsBalance}</span>
                          <span className="text-muted-foreground"> bal</span>
                          {user.totalUsed > 0 && (
                            <span className="text-xs text-muted-foreground ml-1">· {user.totalUsed} used</span>
                          )}
                        </TableCell>
                        <TableCell className="py-2 px-2 text-center font-medium">{user.generationCount}</TableCell>
                        <TableCell className="py-2 px-2 text-center">
                          {user.flagCount > 0 ? (
                            <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
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
                {sortedUsers.map((user) => (
                  <div key={user.id} className="p-3 space-y-1.5 text-xs">
                    {/* Row 1: Name | Plan + Eye */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Avatar className="h-6 w-6 shrink-0">
                          <AvatarImage src={user.avatarUrl || undefined} />
                          <AvatarFallback className="text-xs">
                            {user.displayName?.charAt(0)?.toUpperCase() || "U"}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="font-medium truncate">{user.displayName}</div>
                          <div className="text-muted-foreground truncate">{user.email}</div>
                        </div>
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
                          <span className="text-xs">cr</span>
                        </span>
                        <span>
                          <span className="font-medium text-foreground">{user.generationCount}</span>
                          <span className="text-xs">gen</span>
                        </span>
                        {user.flagCount > 0 ? (
                          <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                            <AlertTriangle className="h-2.5 w-2.5" />
                            {user.flagCount}
                          </span>
                        ) : (
                          <span>
                            <span className="font-medium text-foreground">0</span>
                            <span className="text-xs">fl</span>
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
