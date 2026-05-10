import { Helmet } from "react-helmet-async";
import { useState, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  AlertTriangle,
  Mail,
  Clock,
  Activity as ActivityIcon,
  Shield,
} from "lucide-react";
import { CURRENT_POLICY_VERSION } from "@/lib/policyVersion";
import { loadAdminFonts } from "@/lib/loadCaptionFonts";

// §5 PERF-002 fix (2026-05-10): settings-tokens.css references
// Instrument Serif + JetBrains Mono via --serif / --mono. Both were
// removed from the public index.html font load to keep the landing
// critical path lean. Idempotent inject when this page mounts.
loadAdminFonts();
import { useAuth } from "@/hooks/useAuth";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import IntegrationsTab from "@/components/settings/IntegrationsTab";
import DataExportSection from "@/components/settings/DataExportSection";
import CookiePreferencesSection from "@/components/settings/CookiePreferencesSection";
import AITrainingOptInSection from "@/components/settings/AITrainingOptInSection";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { invokeWithTrace, shortTraceRef } from "@/lib/tracing";
import { PasswordStrengthMeter, getPasswordStrength } from "@/components/ui/password-strength";
import AppShell from "@/components/dashboard/AppShell";
import { Input } from "@/components/ui/input";
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

type TabKey =
  | "profile"
  | "workspace"
  | "notifications"
  | "security"
  | "integrations"
  | "api"
  | "activity";

export default function Settings() {
  const { user } = useAuth();
  const { isAdmin } = useAdminAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabKey>("profile");
  const [displayName, setDisplayName] = useState("");
  const [isSavingName, setIsSavingName] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [isChangingEmail, setIsChangingEmail] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  // C-3-5: Multi-step deletion. The original flow let any user with an
  // open session schedule a 7-day-fuse deletion by typing "DELETE" — no
  // password reprompt, no out-of-band confirmation. A logged-in attacker
  // (shared device, cookie-stealing extension, lost laptop) could nuke
  // the account with no signal to the real user. The flow is now:
  //   1. Type the account email exactly (intent + identifier match)
  //   2. Re-enter password (proves identity even mid-session)
  //   3. Edge function schedules deletion + sends a confirmation email
  //      with a cancel link, so the real user gets an out-of-band notice
  //      and can cancel within the 7-day window even if their session
  //      was hijacked.
  const [deleteStep, setDeleteStep] = useState<"email" | "password" | "scheduled">("email");
  const [deleteEmailInput, setDeleteEmailInput] = useState("");
  const [deletePasswordInput, setDeletePasswordInput] = useState("");
  const [deletePasswordError, setDeletePasswordError] = useState<string | null>(null);
  const [deleteScheduledAt, setDeleteScheduledAt] = useState<string | null>(null);
  const [emailChangePending, setEmailChangePending] = useState(false);
  const [pendingEmail, setPendingEmail] = useState("");
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [activityLogs, setActivityLogs] = useState<
    Array<{ id: string; event_type: string; message: string; created_at: string }>
  >([]);
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

  // Auto-fetch activity when the activity tab opens (preserves existing
  // onClick fetch trigger semantics from the prior implementation).
  useEffect(() => {
    if (activeTab === "activity") {
      void fetchActivityLogs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, user?.id]);

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

  // C-3-5: Reset every step's transient state. Called on cancel / on
  // dialog close. Without this, re-opening the modal would land on the
  // 'scheduled' step with the email/password blanks pre-filled.
  const resetDeleteFlow = () => {
    setDeleteStep("email");
    setDeleteEmailInput("");
    setDeletePasswordInput("");
    setDeletePasswordError(null);
    setDeleteScheduledAt(null);
  };

  // C-3-5 step 1 → 2: user typed the account email correctly. We do a
  // case-insensitive trim/match so a user with shift-lock-on or a
  // trailing space doesn't get gaslit by the form. The match is
  // strictly informational — the actual destructive call happens after
  // a password verify in step 2.
  const handleDeleteEmailNext = () => {
    const expected = (user?.email ?? "").trim().toLowerCase();
    const got = deleteEmailInput.trim().toLowerCase();
    if (!expected) {
      toast.error("Couldn't read your account email. Please refresh and try again.");
      return;
    }
    if (got !== expected) {
      toast.error("That email doesn't match your account. Please type it exactly.");
      return;
    }
    setDeleteStep("password");
  };

  // C-3-5 step 2 → 3: re-authenticate via signInWithPassword. This
  // proves the user knows the current password even if their session
  // was hijacked (the attacker would have a valid session token but no
  // password). On success we hand off to the delete-account edge
  // function which:
  //   - cancels Stripe (existing behaviour)
  //   - inserts the deletion_requests row with a 7-day fuse
  //   - sends a confirmation email with a cancel link (NEW — see
  //     supabase/functions/delete-account/index.ts)
  // Then we IMMEDIATELY sign out the session so the same device can't
  // be used to immediately cancel the request without re-authing.
  const handleDeletePasswordSubmit = async () => {
    if (!user?.email) {
      setDeletePasswordError("Account email missing — please refresh and try again.");
      return;
    }
    if (!deletePasswordInput) {
      setDeletePasswordError("Please enter your password.");
      return;
    }
    setIsDeletingAccount(true);
    setDeletePasswordError(null);
    try {
      // Reauth — Supabase's signInWithPassword refreshes the session
      // when the credentials are correct (no separate verify endpoint
      // exists). On wrong password it errors WITHOUT touching the
      // current session, so the user stays logged in either way.
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: deletePasswordInput,
      });
      if (reauthError) {
        setDeletePasswordError("That password didn't match. Try again.");
        return;
      }

      // Reauth succeeded — fire the edge function. Audit C-9-6 wraps this
      // in invokeWithTrace so support can correlate "I tried to delete my
      // account and it didn't work" tickets to the exact backend call.
      const { data, error: invokeError, traceId } = await invokeWithTrace<{
        success?: boolean;
        scheduled_at?: string;
        error?: string;
      }>("delete-account", { method: "POST" });
      if (invokeError) {
        const msg = invokeError instanceof Error ? invokeError.message : "Failed to schedule deletion";
        throw new Error(`${msg} (Ref: ${shortTraceRef(traceId)})`);
      }
      if (data?.error) {
        throw new Error(`${data.error} (Ref: ${shortTraceRef(traceId)})`);
      }

      const scheduledAt =
        data?.scheduled_at ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      setDeleteScheduledAt(scheduledAt);
      setPendingDeletion({ id: "pending", scheduled_at: scheduledAt });
      setDeleteStep("scheduled");
      // Wipe sensitive transient state — password should not linger in
      // React tree memory after we're done with it.
      setDeletePasswordInput("");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Failed to schedule deletion.";
      setDeletePasswordError(msg);
      toast.error(msg);
    } finally {
      setIsDeletingAccount(false);
    }
  };

  // C-3-5 step 3 close: user has seen the "scheduled" confirmation;
  // sign them out so the device they used can't be used to immediately
  // cancel without re-auth. (Cancel-deletion is gated by an authed
  // session — anyone re-signing-in with the password can cancel within
  // the 7-day window. The confirmation email also includes a cancel
  // link tokenized for that same flow.)
  const handleDeleteScheduledAcknowledge = async () => {
    setShowDeleteDialog(false);
    resetDeleteFlow();
    await supabase.auth.signOut();
  };

  // Avatar initial — first char of display name or email
  const initial = (displayName || user?.email || "?").trim().charAt(0).toUpperCase();
  const joinedAt = user?.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, { month: "long", year: "numeric" })
    : null;

  return (
    <AppShell breadcrumb="Settings">
      <Helmet>
        <title>Settings · MotionMax</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="settings-shell">
        <div className="set-wrap">
          {/* Hero */}
          <div className="set-head">
            <div>
              <h1>Account <em>settings</em></h1>
              <p className="lede">
                Manage your profile, workspace, security and integrations. Changes save instantly unless noted.
              </p>
            </div>
            <div className="who">
              <span className="pl">{(displayName || user?.email?.split("@")[0] || "Account").toUpperCase()}</span>
            </div>
          </div>

          {/* Tab strip */}
          <div className="set-tabs" role="tablist">
            <TabBtn id="profile" active={activeTab} onClick={setActiveTab} ariaLabel="Profile">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
              </svg>
              <span className="t-label">Profile</span>
            </TabBtn>
            <TabBtn id="workspace" active={activeTab} onClick={setActiveTab} ariaLabel="Workspace">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 3v18" />
              </svg>
              <span className="t-label">Workspace</span>
            </TabBtn>
            <TabBtn id="notifications" active={activeTab} onClick={setActiveTab} ariaLabel="Notifications">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
              </svg>
              <span className="t-label">Notifications</span>
            </TabBtn>
            <TabBtn id="security" active={activeTab} onClick={setActiveTab} ariaLabel="Security">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <path d="M12 2L4 6v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V6z" />
              </svg>
              <span className="t-label">Security</span>
            </TabBtn>
            {isAdmin && (
              <TabBtn id="integrations" active={activeTab} onClick={setActiveTab} ariaLabel="Integrations">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                  <circle cx="6" cy="12" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="18" cy="18" r="3" />
                  <path d="M9 12h6M15 7l-6 4M15 17l-6-4" />
                </svg>
                <span className="t-label">Integrations</span>
              </TabBtn>
            )}
            <TabBtn id="api" active={activeTab} onClick={setActiveTab} ariaLabel="API keys">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zM15.5 8.5l4-4M19 1l4 4-9 9-3-3z" />
              </svg>
              <span className="t-label">API keys <span className="pill">DEV</span></span>
            </TabBtn>
            <TabBtn id="activity" active={activeTab} onClick={setActiveTab} ariaLabel="Activity">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <path d="M3 12h4l3-9 4 18 3-9h4" />
              </svg>
              <span className="t-label">Activity</span>
            </TabBtn>
          </div>

          {/* Profile tab — covers existing wiring: display name, email, danger zone */}
          {activeTab === "profile" && (
            <section>
              <div className="card">
                <h3>Your profile</h3>
                <div className="av-row">
                  <div className="av-big">{initial}</div>
                  <div className="info">
                    <div className="n">{displayName || user?.email?.split("@")[0] || "Account"}</div>
                    <div className="h">
                      {user?.email}
                      {joinedAt ? ` · joined ${joinedAt}` : ""}
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid-2" style={{ marginTop: 18 }}>
                <div className="card">
                  <h3>Personal info</h3>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div className="fld">
                      <label htmlFor="set-display-name">Display name</label>
                      <input
                        id="set-display-name"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        maxLength={50}
                        placeholder="Enter your display name"
                      />
                    </div>
                    <div className="fld">
                      <label htmlFor="set-current-email">Current email</label>
                      <input id="set-current-email" type="email" value={user?.email || ""} disabled />
                    </div>
                    <div className="fld">
                      <label htmlFor="set-new-email">New email</label>
                      <input
                        id="set-new-email"
                        type="email"
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        placeholder="Enter new email address"
                      />
                      <div className="hint">A verification will be sent if you change this.</div>
                    </div>
                    {emailChangePending && (
                      <div className="pending-strip">
                        <Mail size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                        <span>
                          Confirmation email sent to <strong>{pendingEmail}</strong>. Check your inbox to complete the change.
                        </span>
                      </div>
                    )}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={handleChangeEmail}
                        disabled={isChangingEmail || !newEmail.trim()}
                      >
                        {isChangingEmail && <Loader2 size={14} className="animate-spin" />}
                        Update email
                      </button>
                      <button
                        type="button"
                        className="btn-cyan"
                        onClick={handleSaveDisplayName}
                        disabled={isSavingName}
                      >
                        {isSavingName && <Loader2 size={14} className="animate-spin" />}
                        Save changes
                      </button>
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="h-row">
                    <h3>Preferences</h3>
                    <span className="soon-tag">Coming soon</span>
                  </div>
                  <div className="set-row">
                    <div className="info">
                      <div className="t">Theme</div>
                      <div className="d">Dark studio is currently the only option</div>
                    </div>
                    <span className="lbl-pill cyan">DARK STUDIO</span>
                  </div>
                  <div className="set-row">
                    <div className="info">
                      <div className="t">Language</div>
                      <div className="d">Interface language preferences</div>
                    </div>
                    <span className="lbl-pill muted">EN-US</span>
                  </div>
                  <div className="set-row">
                    <div className="info">
                      <div className="t">Time zone</div>
                      <div className="d">Used for scheduling and timestamps</div>
                    </div>
                    <span className="lbl-pill muted">SYSTEM</span>
                  </div>
                </div>
              </div>

              {/* Danger zone — preserves existing delete-account + cancel-deletion wiring */}
              <div className="card danger-card" style={{ marginTop: 18 }}>
                <h3>
                  <AlertTriangle size={18} />
                  Danger zone
                </h3>

                {pendingDeletion ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div className="del-banner">
                      <AlertTriangle size={16} className="icon" />
                      <div style={{ minWidth: 0 }}>
                        <div className="t">Account deletion scheduled</div>
                        <div className="d">
                          Your account and all data will be permanently deleted on{" "}
                          <strong style={{ color: "var(--ink)" }}>
                            {new Date(pendingDeletion.scheduled_at).toLocaleDateString(undefined, { dateStyle: "long" })}
                          </strong>
                          . You can cancel this request before that date.
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <button
                        type="button"
                        className="btn-ghost danger"
                        onClick={handleCancelDeletion}
                        disabled={isCancellingDeletion}
                      >
                        {isCancellingDeletion && <Loader2 size={14} className="animate-spin" />}
                        Cancel deletion request
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="set-row" style={{ borderTop: 0, paddingTop: 0 }}>
                      <div className="info">
                        <div className="t">Delete account</div>
                        <div className="d">
                          Permanently delete your account and all data including projects, generations, voice clones and remaining credits. This cannot be undone.
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn-ghost danger"
                        onClick={() => setShowDeleteDialog(true)}
                      >
                        Delete account
                      </button>
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {/* Workspace — not implemented yet */}
          {activeTab === "workspace" && (
            <section>
              <ComingSoonCard
                title="Workspace"
                body="Workspace name, handle, default privacy, brand kit defaults and team-member seats are coming soon. Today MotionMax accounts are single-user."
              />
            </section>
          )}

          {/* Notifications — not implemented yet */}
          {activeTab === "notifications" && (
            <section>
              <ComingSoonCard
                title="Notifications"
                body="Email and in-app notification preferences (render finished, weekly summary, comments, quiet hours) will land here. For now, transactional emails are sent from your auth provider only."
              />
            </section>
          )}

          {/* Security — preserves existing policy-consent + change-password wiring */}
          {activeTab === "security" && (
            <section>
              <div className="card">
                <h3>Policy consent</h3>
                {acceptedPolicyVersion ? (
                  <>
                    <div className="consent-row">
                      <span className="k">Version accepted</span>
                      <span className="v">{acceptedPolicyVersion}</span>
                    </div>
                    {acceptedPolicyAt && (
                      <div className="consent-row">
                        <span className="k">Accepted on</span>
                        <span className="v">{new Date(acceptedPolicyAt).toLocaleDateString()}</span>
                      </div>
                    )}
                    {acceptedPolicyVersion !== CURRENT_POLICY_VERSION && (
                      <p className="consent-warn">
                        A newer policy version ({CURRENT_POLICY_VERSION}) is in effect. You will be asked to re-accept on next sign-in.
                      </p>
                    )}
                  </>
                ) : (
                  <p style={{ color: "var(--ink-mute)", fontSize: 12.5, margin: 0 }}>
                    No consent record found — this may be a legacy account created before version tracking was introduced (current policy: {CURRENT_POLICY_VERSION}).
                  </p>
                )}
                <div className="consent-links">
                  <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
                  <a href="/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a>
                </div>
              </div>

              <div style={{ marginTop: 18 }}>
                <DataExportSection />
              </div>

              <div style={{ marginTop: 18 }}><CookiePreferencesSection /></div>

              <div className="card" style={{ marginTop: 18 }}>
                <h3>Password</h3>
                <p style={{ fontSize: 13, color: "var(--ink-dim)", margin: "0 0 14px", lineHeight: 1.55 }}>
                  Enter a new password to update your account security. Password must be at least 8 characters with a mix of character types.
                </p>
                <div className="grid-2" style={{ gap: 14 }}>
                  <div className="fld">
                    <label htmlFor="set-new-password">New password</label>
                    <input
                      id="set-new-password"
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Min 8 characters"
                    />
                  </div>
                  <div className="fld">
                    <label htmlFor="set-confirm-password">Confirm new password</label>
                    <input
                      id="set-confirm-password"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Repeat new password"
                    />
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <PasswordStrengthMeter password={newPassword} />
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
                  <button
                    type="button"
                    className="btn-cyan"
                    onClick={handleChangePassword}
                    disabled={isChangingPassword}
                  >
                    {isChangingPassword && <Loader2 size={14} className="animate-spin" />}
                    Update password
                  </button>
                </div>
              </div>

              <div className="card" style={{ marginTop: 18 }}>
                <div className="h-row">
                  <h3>Two-factor authentication</h3>
                  <span className="soon-tag">Coming soon</span>
                </div>
                <div className="set-row">
                  <div className="info">
                    <div className="t">Authenticator app</div>
                    <div className="d">TOTP-based 2FA (Google Authenticator, 1Password, Authy)</div>
                  </div>
                  <span className="lbl-pill muted">NOT YET</span>
                </div>
                <div className="set-row">
                  <div className="info">
                    <div className="t">Backup codes</div>
                    <div className="d">Single-use recovery codes</div>
                  </div>
                  <span className="lbl-pill muted">NOT YET</span>
                </div>
              </div>

              <div className="card" style={{ marginTop: 18 }}>
                <div className="h-row">
                  <h3>Active sessions</h3>
                  <span className="soon-tag">Coming soon</span>
                </div>
                <p style={{ fontSize: 12.5, color: "var(--ink-mute)", margin: 0, lineHeight: 1.55 }}>
                  Per-device session management is on the roadmap. For now, signing out from this device clears the local session;
                  use your account email's reset flow to invalidate elsewhere.
                </p>
              </div>

              <div style={{ marginTop: 18 }}><AITrainingOptInSection /></div>
            </section>
          )}

          {/* Integrations — preserves existing IntegrationsTab wiring (admin only) */}
          {activeTab === "integrations" && isAdmin && (
            <section>
              <div className="card" style={{ padding: 0, background: "transparent", border: 0 }}>
                <IntegrationsTab />
              </div>
            </section>
          )}

          {/* API keys — not implemented yet */}
          {activeTab === "api" && (
            <section>
              <ComingSoonCard
                title="API keys"
                body="Programmatic access keys, webhooks and rate-limit dashboards will live here once the public API ships. The product currently runs server-side only via Supabase Auth + RLS."
              />
            </section>
          )}

          {/* Activity — preserves existing system_logs wiring */}
          {activeTab === "activity" && (
            <section>
              <div className="card">
                <div className="h-row">
                  <h3 style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <ActivityIcon size={18} style={{ color: "var(--cyan)" }} />
                    Account activity
                  </h3>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={fetchActivityLogs}
                    disabled={isLoadingActivity}
                    style={{ padding: "6px 10px", fontSize: 12 }}
                  >
                    {isLoadingActivity ? <Loader2 size={12} className="animate-spin" /> : <Clock size={12} />}
                    Refresh
                  </button>
                </div>
                <p style={{ fontSize: 12.5, color: "var(--ink-mute)", margin: "0 0 14px", lineHeight: 1.55 }}>
                  Recent security events for your account. Logs are retained for 90 days.
                </p>
                {isLoadingActivity ? (
                  <div className="act-empty">
                    <Loader2 size={20} className="animate-spin" />
                    <span>Loading activity…</span>
                  </div>
                ) : activityLogs.length === 0 ? (
                  <div className="act-empty">
                    <Clock size={28} style={{ opacity: 0.5 }} />
                    <span>No activity recorded yet.</span>
                  </div>
                ) : (
                  <ul className="act-list">
                    {activityLogs.map((log) => (
                      <li key={log.id}>
                        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", minWidth: 0 }}>
                          <Shield size={14} style={{ color: "var(--ink-mute)", flexShrink: 0, marginTop: 2 }} />
                          <div style={{ minWidth: 0 }}>
                            <div className="ev-name">{log.event_type.replace(/_/g, " ")}</div>
                            <div className="ev-msg">{log.message}</div>
                          </div>
                        </div>
                        <time dateTime={log.created_at} className="when">
                          {new Date(log.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                        </time>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}
        </div>
      </div>

      {/* C-3-5: Delete Account flow — three steps. Modal chrome stays
          gold-on-dark (brand: aqua + gold only, no red). Each step
          guards the next so a user can't speedrun past identity
          verification by tabbing fast. */}
      <AlertDialog
        open={showDeleteDialog}
        onOpenChange={(next) => {
          setShowDeleteDialog(next);
          if (!next) resetDeleteFlow();
        }}
      >
        <AlertDialogContent className="settings-modal-content">
          <AlertDialogHeader>
            <AlertDialogTitle style={{ display: "flex", alignItems: "center", gap: 8, color: "#E4C875" }}>
              <AlertTriangle size={20} />
              {deleteStep === "scheduled" ? "Deletion scheduled" : "Delete your account?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, color: "#8A9198", fontSize: 13.5, lineHeight: 1.55 }}>
                {deleteStep === "email" && (
                  <>
                    <p style={{ margin: 0 }}>
                      This will <strong style={{ color: "#ECEAE4" }}>submit a deletion request</strong>. Once processed, all of your data
                      will be permanently removed, including:
                    </p>
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.7 }}>
                      <li>All projects and video generations</li>
                      <li>Voice clones and audio files</li>
                      <li>Remaining credits (no refund)</li>
                      <li>Your account and profile</li>
                    </ul>
                    <p style={{ margin: 0, fontSize: 12, fontStyle: "italic", color: "#5A6268" }}>
                      Your account is scheduled for deletion 7 days after the request, which gives you a window to cancel.
                    </p>
                    <p style={{ margin: "4px 0 0", color: "#ECEAE4" }}>
                      To start, type your account email exactly:
                    </p>
                    <Input
                      type="email"
                      autoComplete="off"
                      value={deleteEmailInput}
                      onChange={(e) => setDeleteEmailInput(e.target.value)}
                      placeholder={user?.email ?? "you@example.com"}
                      className="bg-[#151B20] border-white/10 text-[#ECEAE4]"
                    />
                  </>
                )}

                {deleteStep === "password" && (
                  <>
                    <p style={{ margin: 0 }}>
                      Confirm your <strong style={{ color: "#ECEAE4" }}>password</strong> to schedule deletion. We do this even though you're
                      signed in so a forgotten session on a shared device can't nuke your account.
                    </p>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      value={deletePasswordInput}
                      onChange={(e) => {
                        setDeletePasswordInput(e.target.value);
                        if (deletePasswordError) setDeletePasswordError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !isDeletingAccount) {
                          e.preventDefault();
                          void handleDeletePasswordSubmit();
                        }
                      }}
                      placeholder="Enter your current password"
                      className="bg-[#151B20] border-white/10 text-[#ECEAE4]"
                    />
                    {deletePasswordError && (
                      <p style={{ margin: 0, fontSize: 12, color: "#E4C875" }}>{deletePasswordError}</p>
                    )}
                    <p style={{ margin: 0, fontSize: 12, color: "#5A6268" }}>
                      A confirmation email will be sent to <strong style={{ color: "#ECEAE4" }}>{user?.email}</strong> with a cancel link, so even if your session was compromised, you'll still get the heads-up.
                    </p>
                  </>
                )}

                {deleteStep === "scheduled" && (
                  <>
                    <p style={{ margin: 0, color: "#ECEAE4" }}>
                      Your account is scheduled for permanent deletion on{" "}
                      <strong style={{ color: "#E4C875" }}>
                        {deleteScheduledAt
                          ? new Date(deleteScheduledAt).toLocaleDateString(undefined, {
                              dateStyle: "long",
                            })
                          : "in 7 days"}
                      </strong>
                      .
                    </p>
                    <p style={{ margin: 0 }}>
                      We just emailed <strong style={{ color: "#ECEAE4" }}>{user?.email}</strong> a confirmation with a cancel link. You can also cancel from the Profile tab any time before the scheduled date.
                    </p>
                    <p style={{ margin: 0, fontSize: 12, color: "#5A6268" }}>
                      You'll be signed out when you close this dialog. Sign back in to cancel the deletion before the fuse runs out.
                    </p>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {deleteStep === "email" && (
              <>
                <AlertDialogCancel
                  onClick={resetDeleteFlow}
                  className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
                >
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    handleDeleteEmailNext();
                  }}
                  disabled={!deleteEmailInput.trim()}
                  className="bg-[#E4C875] text-[#0A0D0F] hover:bg-[#C9A75A]"
                >
                  Continue
                </AlertDialogAction>
              </>
            )}
            {deleteStep === "password" && (
              <>
                <AlertDialogCancel
                  onClick={() => setDeleteStep("email")}
                  className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
                >
                  Back
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    void handleDeletePasswordSubmit();
                  }}
                  disabled={!deletePasswordInput || isDeletingAccount}
                  className="bg-[#E4C875] text-[#0A0D0F] hover:bg-[#C9A75A]"
                >
                  {isDeletingAccount ? (
                    <Loader2 size={14} className="animate-spin" style={{ marginRight: 6 }} />
                  ) : null}
                  Confirm and schedule deletion
                </AlertDialogAction>
              </>
            )}
            {deleteStep === "scheduled" && (
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  void handleDeleteScheduledAcknowledge();
                }}
                className="bg-[#E4C875] text-[#0A0D0F] hover:bg-[#C9A75A]"
              >
                I understand · sign me out
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* Small subcomponents                                            */
/* ────────────────────────────────────────────────────────────── */

function TabBtn({
  id, active, onClick, children, ariaLabel,
}: {
  id: TabKey;
  active: TabKey;
  onClick: (t: TabKey) => void;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className={active === id ? "on" : ""}
      onClick={() => onClick(id)}
      role="tab"
      aria-selected={active === id}
      aria-label={ariaLabel}
      data-t={id}
    >
      {children}
    </button>
  );
}

function ComingSoonCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="soon-card">
      <span className="pill">Coming soon</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
