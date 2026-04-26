import { Helmet } from "react-helmet-async";
import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import {
  User,
  Shield,
  Loader2,
  AlertTriangle,
  Mail,
  Clock,
  Activity,
  FileText,
} from "lucide-react";
import { CURRENT_POLICY_VERSION } from "@/lib/policyVersion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getPasswordStrength, PasswordStrengthMeter } from "@/components/ui/password-strength";
import AppShell from "@/components/dashboard/AppShell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function Settings() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [isSavingName, setIsSavingName] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [isChangingEmail, setIsChangingEmail] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [emailChangePending, setEmailChangePending] = useState(false);
  const [pendingEmail, setPendingEmail] = useState("");
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [activityLogs, setActivityLogs] = useState<Array<{ id: string; event_type: string; message: string; created_at: string }>>([]);
  const [isLoadingActivity, setIsLoadingActivity] = useState(false);
  const [pendingDeletion, setPendingDeletion] = useState<{ id: string; scheduled_at: string } | null>(null);
  const [isCancellingDeletion, setIsCancellingDeletion] = useState(false);
  const [acceptedPolicyVersion, setAcceptedPolicyVersion] = useState<string | null>(null);
  const [acceptedPolicyAt, setAcceptedPolicyAt] = useState<string | null>(null);

  const passwordStrength = useMemo(() => getPasswordStrength(newPassword), [newPassword]);

  const fetchActivityLogs = async () => {
    if (!user?.id) return;
    setIsLoadingActivity(true);
    try {
      const { data } = await supabase
        .from("system_logs" as never)
        .select("id, event_type, message, created_at")
        .eq("user_id" as never, user.id)
        .eq("category" as never, "user_activity")
        .order("created_at" as never, { ascending: false })
        .limit(50) as { data: Array<{ id: string; event_type: string; message: string; created_at: string }> | null };
      setActivityLogs(data ?? []);
    } finally {
      setIsLoadingActivity(false);
    }
  };

  useEffect(() => {
    const fetchProfile = async () => {
      if (!user?.id) return;
      // Cast to any: accepted_policy_version/at are new columns not yet in generated types.
      const { data } = await (supabase
        .from("profiles")
        .select("display_name, accepted_policy_version, accepted_policy_at")
        .eq("user_id", user.id)
        .single() as unknown as Promise<{ data: { display_name: string | null; accepted_policy_version: string | null; accepted_policy_at: string | null } | null }>);
      if (data?.display_name) {
        setDisplayName(data.display_name);
      } else {
        setDisplayName(user.email?.split("@")[0] || "");
      }
      setAcceptedPolicyVersion(data?.accepted_policy_version ?? null);
      setAcceptedPolicyAt(data?.accepted_policy_at ?? null);
    };
    const fetchPendingDeletion = async () => {
      if (!user?.id) return;
      const { data } = await supabase
        .from("deletion_requests" as never)
        .select("id, scheduled_at")
        .eq("user_id" as never, user.id)
        .eq("status" as never, "pending")
        .maybeSingle() as { data: { id: string; scheduled_at: string } | null };
      setPendingDeletion(data ?? null);
    };
    fetchProfile();
    fetchPendingDeletion();
  }, [user]);

  const handleCancelDeletion = async () => {
    if (!pendingDeletion) return;
    setIsCancellingDeletion(true);
    try {
      const { error } = await supabase
        .from("deletion_requests" as never)
        .update({ status: "cancelled" } as never)
        .eq("id" as never, pendingDeletion.id);
      if (error) throw error;
      setPendingDeletion(null);
      toast.success("Account deletion cancelled. Your account will remain active.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to cancel deletion. Please contact support@motionmax.io.");
    } finally {
      setIsCancellingDeletion(false);
    }
  };

  const DISPLAY_NAME_REGEX = /^[a-zA-Z0-9\s\-_]{1,50}$/;

  const handleSaveDisplayName = async () => {
    if (!user?.id || !displayName.trim()) {
      toast.error("Please enter a display name.");
      return;
    }
    if (!DISPLAY_NAME_REGEX.test(displayName.trim())) {
      toast.error("Display name can only contain letters, numbers, spaces, hyphens, and underscores.");
      return;
    }
    setIsSavingName(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .upsert({
          user_id: user.id,
          display_name: displayName.trim(),
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ["user-profile", user.id] });
      toast.success("Display name saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Please try again.");
    } finally {
      setIsSavingName(false);
    }
  };

  const handleChangeEmail = async () => {
    if (!newEmail.trim()) { toast.error("Please enter a new email address."); return; }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!emailRegex.test(newEmail)) { toast.error("Please enter a valid email address."); return; }
    setIsChangingEmail(true);
    try {
      const { error } = await supabase.auth.updateUser({ email: newEmail });
      if (error) throw error;
      toast.success("Confirmation email sent. Check your new inbox to confirm the change.");
      setEmailChangePending(true);
      setPendingEmail(newEmail.trim());
      setNewEmail("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Please try again.");
    } finally {
      setIsChangingEmail(false);
    }
  };

  const handleChangePassword = async () => {
    if (!newPassword || !confirmPassword) { toast.error("Please fill in both password fields."); return; }
    if (newPassword.length < 8) { toast.error("Password must be at least 8 characters long."); return; }
    if (passwordStrength.score < 50) { toast.error("Please choose a stronger password with a mix of uppercase, lowercase, numbers, or symbols."); return; }
    if (newPassword !== confirmPassword) { toast.error("Passwords don't match."); return; }
    setIsChangingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      toast.success("Password updated successfully.");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Please try again.");
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText.toUpperCase() !== "DELETE") return;
    setIsDeletingAccount(true);
    try {
      // Log deletion request with 7-day grace period (replaces mailto: flow)
      const { error } = await supabase
        .from("deletion_requests" as never)
        .insert({ user_id: user!.id, email: user?.email } as never);
      if (error) throw error;
      toast.success("Deletion request submitted. Your account will be permanently deleted in 7 days. You have been signed out.");
      setShowDeleteDialog(false);
      setDeleteConfirmText("");
      setPendingDeletion(null);
      // Sign out immediately so the session can't be used after the request
      await supabase.auth.signOut();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to submit deletion request. Please contact support@motionmax.io.");
    } finally {
      setIsDeletingAccount(false);
    }
  };

  return (
    <AppShell breadcrumb="Settings">
      <Helmet>
        <title>Settings · MotionMax</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="px-3 sm:px-4 md:px-6 lg:px-8 py-5 sm:py-7 max-w-[960px] mx-auto">
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35 }}
              >
                <h1 className="font-serif text-[28px] sm:text-[34px] font-medium tracking-tight text-[#ECEAE4] leading-[1.05]">Settings</h1>
                <p className="text-[13px] sm:text-[14px] text-[#8A9198] mt-1.5">Manage your account and preferences.</p>

                <Tabs defaultValue="account" className="mt-6 sm:mt-8">
                  <TabsList className="grid w-full grid-cols-3 rounded-xl bg-[#10151A] border border-white/8 p-1">
                    <TabsTrigger value="account" className="gap-2 rounded-lg text-[#8A9198] data-[state=active]:bg-[#14C8CC]/10 data-[state=active]:text-[#14C8CC] data-[state=active]:shadow-none">
                      <User className="h-4 w-4" />
                      <span className="hidden sm:inline">Account</span>
                    </TabsTrigger>
                    <TabsTrigger value="security" className="gap-2 rounded-lg text-[#8A9198] data-[state=active]:bg-[#14C8CC]/10 data-[state=active]:text-[#14C8CC] data-[state=active]:shadow-none">
                      <Shield className="h-4 w-4" />
                      <span className="hidden sm:inline">Security</span>
                    </TabsTrigger>
                    <TabsTrigger value="activity" className="gap-2 rounded-lg text-[#8A9198] data-[state=active]:bg-[#14C8CC]/10 data-[state=active]:text-[#14C8CC] data-[state=active]:shadow-none" onClick={fetchActivityLogs}>
                      <Activity className="h-4 w-4" />
                      <span className="hidden sm:inline">Activity</span>
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="account" className="mt-6">
                    <Card className="bg-[#10151A] border-white/8 shadow-none">
                      <CardHeader>
                        <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4]">Account information</CardTitle>
                        <CardDescription className="text-[#8A9198] text-[12.5px]">Update your account details.</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-6">
                        <div className="space-y-2">
                          <Label className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium">Display name</Label>
                          <Input
                            placeholder="Enter your display name"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            maxLength={50}
                          />
                        </div>
                        <Button onClick={handleSaveDisplayName} disabled={isSavingName} className="gap-2 rounded-lg">
                          {isSavingName && <Loader2 className="h-4 w-4 animate-spin" />}
                          Save Changes
                        </Button>

                        <div className="border-t border-white/8 pt-6 mt-6">
                          <Label className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium">Current email</Label>
                          <Input value={user?.email || ""} disabled className="bg-[#0A0D0F] border border-white/8 text-[#ECEAE4] mt-2" />
                          <p className="text-[11.5px] text-[#5A6268] mt-1.5">To change your email, enter a new one below.</p>
                        </div>
                        <div className="space-y-2">
                          <Label className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium">New email address</Label>
                          <Input
                            type="email"
                            placeholder="Enter new email address"
                            value={newEmail}
                            onChange={(e) => setNewEmail(e.target.value)}
                          />
                        </div>
                        {emailChangePending && (
                          <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700/50 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 mb-3">
                            <Mail className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            <span>Confirmation email sent to <strong>{pendingEmail}</strong>. Check your inbox to complete the change.</span>
                          </div>
                        )}
                        <Button onClick={handleChangeEmail} disabled={isChangingEmail} variant="outline" className="gap-2 rounded-lg">
                          {isChangingEmail && <Loader2 className="h-4 w-4 animate-spin" />}
                          Update Email
                        </Button>
                      </CardContent>
                    </Card>

                    {/* Danger Zone */}
                    <Card className="mt-6 bg-[#10151A] border-[#E4C875]/30 shadow-none">
                      <CardHeader>
                        <CardTitle className="font-serif text-[18px] font-medium text-[#E4C875] flex items-center gap-2">
                          <AlertTriangle className="h-5 w-5" />
                          Danger zone
                        </CardTitle>
                        <CardDescription className="text-[#8A9198] text-[12.5px]">
                          Irreversible actions that permanently affect your account.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {pendingDeletion ? (
                          <div className="space-y-4">
                            <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3">
                              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-destructive">Account deletion scheduled</p>
                                <p className="text-xs text-muted-foreground mt-1">
                                  Your account and all data will be permanently deleted on{" "}
                                  <strong>{new Date(pendingDeletion.scheduled_at).toLocaleDateString(undefined, { dateStyle: "long" })}</strong>.
                                  You can cancel this request before that date.
                                </p>
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              className="rounded-full border-destructive/50 text-destructive hover:bg-destructive/10"
                              onClick={handleCancelDeletion}
                              disabled={isCancellingDeletion}
                            >
                              {isCancellingDeletion && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                              Cancel Deletion Request
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                            <div>
                              <p className="text-sm font-medium text-foreground">Delete Account</p>
                              <p className="text-xs text-muted-foreground mt-1">
                                Permanently delete your account and all associated data including projects, generations, and voice clones.
                              </p>
                            </div>
                            <Button
                              variant="destructive"
                              className="rounded-full shrink-0"
                              onClick={() => setShowDeleteDialog(true)}
                            >
                              Delete Account
                            </Button>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </TabsContent>

                  <TabsContent value="security" className="mt-6">
                    <Card className="bg-[#10151A] border-white/8 shadow-none mb-4">
                      <CardHeader>
                        <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4] flex items-center gap-2">
                          <FileText className="h-5 w-5 text-[#14C8CC]" />
                          Policy consent
                        </CardTitle>
                        <CardDescription className="text-[#8A9198] text-[12.5px]">Privacy Policy and Terms of Service acceptance on record.</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3 text-sm">
                        {acceptedPolicyVersion ? (
                          <>
                            <div className="flex items-center justify-between">
                              <span className="text-muted-foreground">Version accepted</span>
                              <span className="font-mono text-foreground">{acceptedPolicyVersion}</span>
                            </div>
                            {acceptedPolicyAt && (
                              <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">Accepted on</span>
                                <span className="text-foreground">{new Date(acceptedPolicyAt).toLocaleDateString()}</span>
                              </div>
                            )}
                            {acceptedPolicyVersion !== CURRENT_POLICY_VERSION && (
                              <p className="text-amber-600 dark:text-amber-400 text-xs pt-1">
                                A newer policy version ({CURRENT_POLICY_VERSION}) is in effect. You will be asked to re-accept on next sign-in.
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="text-muted-foreground text-xs">
                            No consent record found — this may be a legacy account created before version tracking was introduced (current policy: {CURRENT_POLICY_VERSION}).
                          </p>
                        )}
                        <div className="flex gap-3 pt-1">
                          <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-xs">Privacy Policy</a>
                          <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-xs">Terms of Service</a>
                        </div>
                      </CardContent>
                    </Card>

                    <Card className="bg-[#10151A] border-white/8 shadow-none">
                      <CardHeader>
                        <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4]">Security settings</CardTitle>
                        <CardDescription className="text-[#8A9198] text-[12.5px]">Manage your account security.</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-6">
                        <div className="space-y-4">
                          <Label className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium">Change password</Label>
                          <p className="text-sm text-muted-foreground">
                            Enter a new password to update your account security. Password must be at least 8 characters with a mix of character types.
                          </p>
                          <Input type="password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                          <PasswordStrengthMeter password={newPassword} />
                          <Input type="password" placeholder="Confirm new password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
                          <Button onClick={handleChangePassword} disabled={isChangingPassword} className="gap-2 rounded-lg">
                            {isChangingPassword && <Loader2 className="h-4 w-4 animate-spin" />}
                            Update Password
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </TabsContent>

                  <TabsContent value="activity" className="mt-6">
                    <Card className="bg-[#10151A] border-white/8 shadow-none">
                      <CardHeader>
                        <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4] flex items-center gap-2">
                          <Activity className="h-5 w-5 text-[#14C8CC]" />
                          Account activity
                        </CardTitle>
                        <CardDescription className="text-[#8A9198] text-[12.5px]">
                          Recent security events for your account. Logs are retained for 90 days.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {isLoadingActivity ? (
                          <div className="flex items-center justify-center py-10">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                          </div>
                        ) : activityLogs.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
                            <Clock className="h-8 w-8 text-muted-foreground/50" />
                            <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
                          </div>
                        ) : (
                          <ul className="divide-y divide-border/40">
                            {activityLogs.map((log) => (
                              <li key={log.id} className="flex items-start justify-between gap-4 py-3 text-sm">
                                <div className="flex items-start gap-3 min-w-0">
                                  <Shield className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                                  <div className="min-w-0">
                                    <p className="font-medium text-foreground truncate">{log.event_type.replace(/_/g, " ")}</p>
                                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{log.message}</p>
                                  </div>
                                </div>
                                <time
                                  dateTime={log.created_at}
                                  className="shrink-0 text-xs text-muted-foreground whitespace-nowrap"
                                >
                                  {new Date(log.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                                </time>
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="mt-4 pt-4 border-t border-border/40">
                          <Button variant="outline" size="sm" className="gap-2 rounded-lg" onClick={fetchActivityLogs} disabled={isLoadingActivity}>
                            {isLoadingActivity ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
                            Refresh
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </TabsContent>
                </Tabs>
              </motion.div>
      </div>

      {/* Delete Account Confirmation */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete Your Account?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>
                This will <strong>submit a deletion request</strong> to our support team. Once processed, all your data will be permanently removed, including:
              </p>
              <ul className="list-disc list-inside text-sm space-y-1">
                <li>All projects and video generations</li>
                <li>Voice clones and audio files</li>
                <li>Remaining credits (no refund)</li>
                <li>Your account and profile</li>
              </ul>
              <p className="text-xs text-muted-foreground italic">
                Our team typically processes deletion requests within 48 hours. You will receive a confirmation email once complete.
              </p>
              <p>
                Type <strong>DELETE</strong> below to confirm:
              </p>
              <Input
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="Type DELETE to confirm"
                className="mt-2"
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteConfirmText("")}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAccount}
              disabled={deleteConfirmText.toUpperCase() !== "DELETE" || isDeletingAccount}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeletingAccount ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Submit Deletion Request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
