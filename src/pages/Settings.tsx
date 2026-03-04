import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { 
  User, 
  Shield,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { ThemedLogo } from "@/components/ThemedLogo";
import { supabase } from "@/integrations/supabase/client";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { useSidebarState } from "@/hooks/useSidebarState";
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

/** Calculate a 0–100 password strength score */
function getPasswordStrength(password: string): { score: number; label: string; color: string } {
  if (!password) return { score: 0, label: "", color: "bg-muted" };
  let score = 0;
  if (password.length >= 8) score += 25;
  else if (password.length >= 6) score += 10;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 25;
  if (/\d/.test(password)) score += 25;
  if (/[^a-zA-Z0-9]/.test(password)) score += 25;

  if (score <= 25) return { score, label: "Weak", color: "bg-destructive" };
  if (score <= 50) return { score, label: "Fair", color: "bg-orange-500" };
  if (score <= 75) return { score, label: "Good", color: "bg-yellow-500" };
  return { score, label: "Strong", color: "bg-green-500" };
}

export default function Settings() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { isOpen: sidebarOpen, setIsOpen: setSidebarOpen } = useSidebarState();

  const [displayName, setDisplayName] = useState("");
  const [isSavingName, setIsSavingName] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [isChangingEmail, setIsChangingEmail] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  const passwordStrength = useMemo(() => getPasswordStrength(newPassword), [newPassword]);

  useEffect(() => {
    const fetchProfile = async () => {
      if (!user?.id) return;
      const { data } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("user_id", user.id)
        .single();
      if (data?.display_name) {
        setDisplayName(data.display_name);
      } else {
        setDisplayName(user.email?.split("@")[0] || "");
      }
    };
    fetchProfile();
  }, [user]);

  const handleSaveDisplayName = async () => {
    if (!user?.id || !displayName.trim()) {
      toast.error("Please enter a display name.");
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
    } catch (error: any) {
      toast.error(error.message || "Please try again.");
    } finally {
      setIsSavingName(false);
    }
  };

  const handleChangeEmail = async () => {
    if (!newEmail.trim()) { toast.error("Please enter a new email address."); return; }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) { toast.error("Please enter a valid email address."); return; }
    setIsChangingEmail(true);
    try {
      const { error } = await supabase.auth.updateUser({ email: newEmail });
      if (error) throw error;
      toast.success("Confirmation email sent. Check your new inbox to confirm the change.");
      setNewEmail("");
    } catch (error: any) {
      toast.error(error.message || "Please try again.");
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
    } catch (error: any) {
      toast.error(error.message || "Please try again.");
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== "DELETE") return;
    setIsDeletingAccount(true);
    try {
      // Send deletion request via support email
      window.open(
        `mailto:support@motionmax.io?subject=Account%20Deletion%20Request&body=Please%20delete%20my%20account%20associated%20with%20email%3A%20${encodeURIComponent(user?.email || "")}%0A%0AUser%20ID%3A%20${encodeURIComponent(user?.id || "")}%0A%0AI%20understand%20this%20action%20is%20permanent%20and%20all%20my%20data%20will%20be%20deleted.`,
        "_blank"
      );
      toast.success("A deletion request email has been prepared. Please send it to complete your request.");
      setShowDeleteDialog(false);
      setDeleteConfirmText("");
    } catch (error: any) {
      toast.error("Failed to initiate account deletion. Please contact support directly.");
    } finally {
      setIsDeletingAccount(false);
    }
  };

  return (
    <SidebarProvider defaultOpen={sidebarOpen} onOpenChange={setSidebarOpen}>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />

        <main className="flex-1 flex flex-col">
          {/* Header */}
          <header className="sticky top-0 z-40 grid h-14 sm:h-16 grid-cols-3 items-center border-b border-border/30 bg-background/80 px-4 sm:px-6 backdrop-blur-sm">
            <div className="flex items-center justify-start gap-2">
              <SidebarTrigger />
              <ThemedLogo className="hidden lg:block h-10 w-auto" />
            </div>
            <div className="flex justify-center lg:hidden">
              <ThemedLogo className="h-10 w-auto" />
            </div>
            <div className="flex items-center justify-end">
              <ThemeToggle />
            </div>
          </header>

          {/* Content */}
          <div className="flex-1 overflow-auto">
            <div className="mx-auto max-w-4xl px-4 sm:px-6 py-6 sm:py-10">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
              >
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">Settings</h1>
                <p className="mt-1 text-sm text-muted-foreground">Manage your account and preferences</p>

                <Tabs defaultValue="account" className="mt-6 sm:mt-8">
                  <TabsList className="grid w-full grid-cols-2 rounded-xl bg-muted/50 p-1">
                    <TabsTrigger value="account" className="gap-2 rounded-lg data-[state=active]:bg-background">
                      <User className="h-4 w-4" />
                      <span className="hidden sm:inline">Account</span>
                    </TabsTrigger>
                    <TabsTrigger value="security" className="gap-2 rounded-lg data-[state=active]:bg-background">
                      <Shield className="h-4 w-4" />
                      <span className="hidden sm:inline">Security</span>
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="account" className="mt-6">
                    <Card className="border-border/50 bg-card/50">
                      <CardHeader>
                        <CardTitle>Account Information</CardTitle>
                        <CardDescription>Update your account details</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-6">
                        <div className="space-y-2">
                          <Label>Display Name</Label>
                          <Input
                            placeholder="Enter your display name"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                          />
                        </div>
                        <Button onClick={handleSaveDisplayName} disabled={isSavingName} className="gap-2 rounded-full">
                          {isSavingName && <Loader2 className="h-4 w-4 animate-spin" />}
                          Save Changes
                        </Button>

                        <div className="border-t border-border/50 pt-6 mt-6">
                          <Label>Current Email</Label>
                          <Input value={user?.email || ""} disabled className="bg-muted/50 mt-2" />
                          <p className="text-xs text-muted-foreground mt-1">To change your email, enter a new one below</p>
                        </div>
                        <div className="space-y-2">
                          <Label>New Email Address</Label>
                          <Input
                            type="email"
                            placeholder="Enter new email address"
                            value={newEmail}
                            onChange={(e) => setNewEmail(e.target.value)}
                          />
                        </div>
                        <Button onClick={handleChangeEmail} disabled={isChangingEmail} variant="outline" className="gap-2 rounded-full">
                          {isChangingEmail && <Loader2 className="h-4 w-4 animate-spin" />}
                          Update Email
                        </Button>
                      </CardContent>
                    </Card>

                    {/* Danger Zone */}
                    <Card className="mt-6 border-destructive/50 bg-destructive/5">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-destructive">
                          <AlertTriangle className="h-5 w-5" />
                          Danger Zone
                        </CardTitle>
                        <CardDescription>
                          Irreversible actions that permanently affect your account
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
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
                      </CardContent>
                    </Card>
                  </TabsContent>

                  <TabsContent value="security" className="mt-6">
                    <Card className="border-border/50 bg-card/50">
                      <CardHeader>
                        <CardTitle>Security Settings</CardTitle>
                        <CardDescription>Manage your account security</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-6">
                        <div className="space-y-4">
                          <Label>Change Password</Label>
                          <p className="text-sm text-muted-foreground">
                            Enter a new password to update your account security. Password must be at least 8 characters with a mix of character types.
                          </p>
                          <Input type="password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                          {newPassword && (
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-muted-foreground">Password strength</span>
                                <span className={`font-medium ${
                                  passwordStrength.score <= 25 ? "text-destructive" :
                                  passwordStrength.score <= 50 ? "text-orange-500" :
                                  passwordStrength.score <= 75 ? "text-yellow-600" :
                                  "text-green-600"
                                }`}>
                                  {passwordStrength.label}
                                </span>
                              </div>
                              <Progress value={passwordStrength.score} className="h-1.5" />
                              <ul className="text-[11px] text-muted-foreground space-y-0.5 mt-1">
                                <li className={newPassword.length >= 8 ? "text-green-600" : ""}>• At least 8 characters</li>
                                <li className={/[a-z]/.test(newPassword) && /[A-Z]/.test(newPassword) ? "text-green-600" : ""}>• Uppercase and lowercase letters</li>
                                <li className={/\d/.test(newPassword) ? "text-green-600" : ""}>• At least one number</li>
                                <li className={/[^a-zA-Z0-9]/.test(newPassword) ? "text-green-600" : ""}>• At least one special character</li>
                              </ul>
                            </div>
                          )}
                          <Input type="password" placeholder="Confirm new password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
                          <Button onClick={handleChangePassword} disabled={isChangingPassword} className="gap-2 rounded-full">
                            {isChangingPassword && <Loader2 className="h-4 w-4 animate-spin" />}
                            Update Password
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </TabsContent>
                </Tabs>
              </motion.div>
            </div>
          </div>
        </main>
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
              disabled={deleteConfirmText !== "DELETE" || isDeletingAccount}
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
    </SidebarProvider>
  );
}
