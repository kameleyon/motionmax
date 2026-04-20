import { useEffect, useState, useRef } from "react";
import { Helmet } from "react-helmet-async";
import { motion } from "framer-motion";
import { useNavigate, useLocation } from "react-router-dom";
import { Mail, Lock, ArrowRight, Eye, EyeOff, Loader2, CheckCircle2, ShieldCheck, Lock as LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { useForceDarkMode } from "@/hooks/useForceDarkMode";
import { ThemedLogo } from "@/components/ThemedLogo";
import { supabase } from "@/integrations/supabase/client";
import { getAuthErrorMessage } from "@/lib/errorMessages";
import { PasswordStrengthMeter } from "@/components/ui/password-strength";

type AuthMode = "login" | "signup" | "reset" | "update";

// Single constant governs minimum password length across all auth flows
const MIN_PASSWORD_LENGTH = 8;
// Show rate-limit hint after this many consecutive login failures
const RATE_LIMIT_HINT_THRESHOLD = 3;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 30_000; // 30 seconds

function AuthPageHeader({ onLogoClick }: { onLogoClick: () => void }) {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border/30 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <button onClick={onLogoClick} className="flex items-center gap-2">
          <ThemedLogo className="h-10 w-auto" />
        </button>
      </div>
    </header>
  );
}

function AuthPageFooter() {
  return (
    <p className="mt-6 text-center text-xs text-muted-foreground/60">
      By continuing, you agree to our{" "}
      <a href="/terms" className="underline hover:text-muted-foreground">Terms of Service</a>
      {" "}and{" "}
      <a href="/privacy" className="underline hover:text-muted-foreground">Privacy Policy</a>.
    </p>
  );
}

// ── Referral capture helpers ──────────────────────────────────────
// Persist the ?ref= code in sessionStorage so it survives a page-mode switch
// (e.g. user lands on signup link, gets redirected to login first).
const REF_SESSION_KEY = "mm_referral_code";

function captureReferralCode(search: string): void {
  const params = new URLSearchParams(search);
  const ref = params.get("ref");
  if (ref && /^MM-[A-Z0-9]{6}$/.test(ref)) {
    sessionStorage.setItem(REF_SESSION_KEY, ref);
  }
}

async function applyStoredReferralCode(userId: string): Promise<void> {
  const code = sessionStorage.getItem(REF_SESSION_KEY);
  if (!code) return;
  sessionStorage.removeItem(REF_SESSION_KEY);
  try {
    await supabase.rpc("apply_referral_code", {
      p_code: code,
      p_referred_user_id: userId,
    });
  } catch {
    // Non-critical — never let referral errors surface to the user
  }
}

export default function Auth() {
  // Force dark mode on Auth page — always dark
  useForceDarkMode();

  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const modeParam = searchParams.get("mode");
  const initialMode: AuthMode = modeParam === "signin" ? "login" : modeParam === "signup" ? "signup" : "login";

  // Capture referral code from URL on first render
  useEffect(() => {
    captureReferralCode(location.search);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showEmailSent, setShowEmailSent] = useState(false);
  const [showRateLimitHint, setShowRateLimitHint] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [ageVerified, setAgeVerified] = useState(false);
  const failedAttemptsRef = useRef(0);
  const [lockedUntil, setLockedUntil] = useState<number>(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const navigate = useNavigate();
  const rawReturnUrl = searchParams.get("returnUrl") || "/app";
  const returnUrl = rawReturnUrl.startsWith("/") && !rawReturnUrl.startsWith("//")
    ? rawReturnUrl
    : "/app";
  const { signIn, signUp, resetPassword, updatePassword } = useAuth();
  const [oauthLoading, setOauthLoading] = useState<"google" | "github" | null>(null);

  const handleOAuthSignIn = async (provider: "google" | "github") => {
    setOauthLoading(provider);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${window.location.origin}${returnUrl}` },
      });
      if (error) toast.error(getAuthErrorMessage(error.message));
    } catch {
      toast.error("Sign-in failed. Please try again.");
    } finally {
      setOauthLoading(null);
    }
  };

  useEffect(() => {
    // Rely solely on the PASSWORD_RECOVERY event — no fragile manual hash parsing
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setMode("update");
        // Clean the recovery hash from the URL immediately when the event fires
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Lockout check
    if (Date.now() < lockedUntil) {
      const secsLeft = Math.ceil((lockedUntil - Date.now()) / 1000);
      toast.error(`Too many attempts. Try again in ${secsLeft}s.`);
      return;
    }

    setErrors({});
    setIsLoading(true);

    try {
      if (mode === "login") {
        const { error } = await signIn(email, password);
        if (error) {
          failedAttemptsRef.current += 1;
          if (failedAttemptsRef.current >= LOCKOUT_THRESHOLD) {
            setLockedUntil(Date.now() + LOCKOUT_DURATION_MS);
            failedAttemptsRef.current = 0;
            toast.error("Too many failed attempts. Locked for 30 seconds.");
            return;
          }
          if (failedAttemptsRef.current >= RATE_LIMIT_HINT_THRESHOLD) {
            setShowRateLimitHint(true);
          }
          const msg = getAuthErrorMessage(error.message);
          setErrors({ email: msg, password: " " });
          toast.error("Sign in failed", { description: msg });
          return;
        }
        failedAttemptsRef.current = 0;
        setShowRateLimitHint(false);
        navigate(returnUrl);
        return;
      }

      if (mode === "signup") {
        if (!acceptedTerms) {
          toast.error("Terms required", { description: "You must accept the Terms of Service and Privacy Policy to create an account." });
          return;
        }
        const { data: signUpData, error } = await signUp(email, password);
        if (error) {
          const msg = getAuthErrorMessage(error.message);
          setErrors({ email: msg });
          toast.error("Sign up failed", { description: msg });
          return;
        }
        // Apply referral code if one is stored — fire-and-forget
        const newUserId = (signUpData as { user?: { id?: string } } | null)?.user?.id;
        if (newUserId) {
          applyStoredReferralCode(newUserId);
        }
        // Show persistent confirmation screen instead of just a dismissible toast
        setShowEmailSent(true);
        return;
      }

      if (mode === "reset") {
        const { error } = await resetPassword(email);
        if (error) {
          const msg = getAuthErrorMessage(error.message);
          setErrors({ email: msg });
          toast.error("Reset failed", { description: msg });
          return;
        }
        toast.success("Reset link sent", { description: "Check your email for a password reset link." });
        setMode("login");
        return;
      }

      // mode === "update"
      if (password.length < MIN_PASSWORD_LENGTH) {
        const msg = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
        setErrors({ password: msg });
        toast.error("Password too short", { description: msg });
        return;
      }
      if (password !== confirmPassword) {
        setErrors({ confirmPassword: "Passwords don't match" });
        toast.error("Passwords don't match", { description: "Please retype your password." });
        return;
      }

      const { error } = await updatePassword(password);
      if (error) {
        const msg = getAuthErrorMessage(error.message);
        setErrors({ password: msg });
        toast.error("Update failed", { description: msg });
        return;
      }

      window.history.replaceState({}, document.title, window.location.pathname);
      toast.success("Password updated", { description: "You're signed in." });
      navigate(returnUrl);
    } finally {
      setIsLoading(false);
    }
  };

  if (showEmailSent) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <AuthPageHeader onLogoClick={() => navigate("/")} />
        <main className="flex flex-1 items-center justify-center px-6 pt-16">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="w-full max-w-md"
          >
            <div className="rounded-2xl border border-border/50 bg-card/50 p-8 shadow-sm backdrop-blur-sm text-center">
              <div className="flex items-center justify-center mb-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                  <CheckCircle2 className="h-7 w-7 text-primary" />
                </div>
              </div>
              <h1 className="text-xl font-semibold text-foreground mb-2">Check your email</h1>
              <p className="text-sm text-muted-foreground mb-1">We sent a confirmation link to</p>
              <p className="text-sm font-semibold text-foreground mb-4 break-all">{email}</p>
              <p className="text-xs text-muted-foreground mb-6">
                Click the link in the email to activate your account. If you don't see it, check your spam or junk folder.
              </p>
              <Button
                variant="outline"
                className="w-full rounded-lg"
                onClick={() => { setShowEmailSent(false); setMode("login"); setPassword(""); }}
              >
                Back to Sign In
              </Button>
            </div>
            <AuthPageFooter />
          </motion.div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Helmet><meta name="robots" content="noindex, nofollow" /></Helmet>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-background focus:text-foreground">Skip to content</a>
      <AuthPageHeader onLogoClick={() => navigate("/")} />

      <main id="main-content" className="flex flex-1 items-center justify-center px-6 pt-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="w-full max-w-md"
        >
          <div className="rounded-2xl border border-border/50 bg-card/50 p-8 shadow-sm backdrop-blur-sm">
            <div className="mb-8 text-center">
              <h1 className="type-h1 tracking-tight text-foreground">
                {mode === "login" ? "Welcome back"
                  : mode === "signup" ? "Create your account"
                  : mode === "reset" ? "Reset your password"
                  : "Set a new password"}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {mode === "login" ? "Sign in to continue creating videos"
                  : mode === "signup" ? "Create professional videos from your text in minutes"
                  : mode === "reset" ? "We'll email you a reset link"
                  : "Choose a new password to finish resetting"}
              </p>
              {mode === "signup" && (
                <p className="mt-2 text-sm font-medium text-primary">
                  Free — no credit card needed
                </p>
              )}
            </div>

            {(mode === "login" || mode === "signup") && (
              <>
                <div className="space-y-3 mb-6">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full gap-3 rounded-lg"
                    onClick={() => handleOAuthSignIn("google")}
                    disabled={!!oauthLoading || isLoading}
                  >
                    {oauthLoading === "google" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                      </svg>
                    )}
                    Continue with Google
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full gap-3 rounded-lg"
                    onClick={() => handleOAuthSignIn("github")}
                    disabled={!!oauthLoading || isLoading}
                  >
                    {oauthLoading === "github" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                        <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
                      </svg>
                    )}
                    Continue with GitHub
                  </Button>
                </div>
                <div className="relative mb-6">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-border/50" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card/50 px-2 text-muted-foreground backdrop-blur-sm">or continue with email</span>
                  </div>
                </div>
              </>
            )}

            <form onSubmit={handleSubmit} className="space-y-5">
              {mode !== "update" && (
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-sm font-medium">Email</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      autoFocus
                      autoComplete="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => { setEmail(e.target.value); if (errors.email) setErrors(prev => ({ ...prev, email: undefined })); }}
                      className="pl-10"
                      required
                      aria-invalid={!!errors.email}
                      aria-describedby={errors.email ? "email-error" : undefined}
                    />
                  </div>
                  {errors.email && errors.email.trim() && (
                    <p id="email-error" role="alert" className="text-xs text-destructive">{errors.email}</p>
                  )}
                </div>
              )}

              {(mode === "login" || mode === "signup" || mode === "update") && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password" className="text-sm font-medium">
                      {mode === "update" ? "New password" : "Password"}
                    </Label>
                    {mode === "login" && (
                      <button
                        type="button"
                        onClick={() => { setMode("reset"); setPassword(""); setConfirmPassword(""); }}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); if (errors.password) setErrors(prev => ({ ...prev, password: undefined })); }}
                      className="pl-10 pr-10"
                      required
                      minLength={MIN_PASSWORD_LENGTH}
                      autoComplete={mode === "login" ? "current-password" : "new-password"}
                      aria-invalid={!!errors.password}
                      aria-describedby={errors.password && errors.password.trim() ? "password-error" : undefined}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      aria-pressed={showPassword}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {errors.password && errors.password.trim() && (
                    <p id="password-error" role="alert" className="text-xs text-destructive">{errors.password}</p>
                  )}
                  {mode === "signup" && <PasswordStrengthMeter password={password} />}
                  {mode === "update" && (
                    <p className="text-xs text-muted-foreground">Minimum {MIN_PASSWORD_LENGTH} characters required.</p>
                  )}
                </div>
              )}

              {mode === "update" && (
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword" className="text-sm font-medium">Confirm new password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="confirmPassword"
                      type={showConfirmPassword ? "text" : "password"}
                      placeholder="••••••••"
                      value={confirmPassword}
                      onChange={(e) => { setConfirmPassword(e.target.value); if (errors.confirmPassword) setErrors(prev => ({ ...prev, confirmPassword: undefined })); }}
                      className="pl-10 pr-10"
                      required
                      minLength={MIN_PASSWORD_LENGTH}
                      autoComplete="new-password"
                      aria-invalid={!!errors.confirmPassword}
                      aria-describedby={errors.confirmPassword ? "confirm-password-error" : undefined}
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                      aria-pressed={showConfirmPassword}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {errors.confirmPassword && (
                    <p id="confirm-password-error" role="alert" className="text-xs text-destructive">{errors.confirmPassword}</p>
                  )}
                </div>
              )}

              {showRateLimitHint && mode === "login" && (
                <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded-xl px-3 py-2">
                  Too many failed attempts? You may be temporarily rate-limited. Wait a few minutes before trying again.
                </p>
              )}

              {mode === "signup" && (
                <>
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="terms"
                      checked={acceptedTerms}
                      onCheckedChange={(checked) => setAcceptedTerms(checked === true)}
                      className="mt-0.5"
                    />
                    <label htmlFor="terms" className="text-xs text-muted-foreground leading-relaxed cursor-pointer">
                      I agree to the{" "}
                      <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        Terms of Service
                      </a>
                      {", "}
                      <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        Privacy Policy
                      </a>
                      {", and "}
                      <a href="/acceptable-use" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        Acceptable Use Policy
                      </a>
                    </label>
                  </div>
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="age-verify"
                      checked={ageVerified}
                      onCheckedChange={(checked) => setAgeVerified(checked === true)}
                      className="mt-0.5"
                    />
                    <label htmlFor="age-verify" className="text-xs text-muted-foreground leading-relaxed cursor-pointer">
                      I confirm that I am 18 years of age or older
                    </label>
                  </div>
                </>
              )}

              <Button
                type="submit"
                className="w-full gap-2 rounded-lg bg-primary py-5 font-medium text-primary-foreground"
                disabled={isLoading || Date.now() < lockedUntil || (mode === "signup" && (!acceptedTerms || !ageVerified))}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    {mode === "login" ? "Sign In"
                      : mode === "signup" ? "Create Account"
                      : mode === "reset" ? "Send Reset Link"
                      : "Update Password"}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>

              {/* Security/compliance trust indicators */}
              <div className="flex items-center justify-center gap-4 mt-4 flex-wrap">
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5 text-brand-aqua" />
                  SSL secured
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <LockIcon className="h-3.5 w-3.5 text-brand-aqua" />
                  GDPR compliant
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5 text-brand-aqua" />
                  No credit card required
                </span>
              </div>
            </form>

            <div className="mt-6 text-center">
              <p className="text-sm text-muted-foreground">
                {mode === "login" && (
                  <>
                    Don&apos;t have an account?{" "}
                    <button type="button" onClick={() => { setMode("signup"); setShowRateLimitHint(false); }} className="font-medium text-primary hover:underline">
                      Sign up
                    </button>
                  </>
                )}
                {mode === "signup" && (
                  <>
                    Already have an account?{" "}
                    <button type="button" onClick={() => setMode("login")} className="font-medium text-primary hover:underline">
                      Sign in
                    </button>
                  </>
                )}
                {mode === "reset" && (
                  <>
                    Remembered your password?{" "}
                    <button type="button" onClick={() => setMode("login")} className="font-medium text-primary hover:underline">
                      Sign in
                    </button>
                  </>
                )}
                {mode === "update" && (
                  <>
                    Want to go back?{" "}
                    <button
                      type="button"
                      onClick={() => { window.history.replaceState({}, document.title, window.location.pathname); setMode("login"); setPassword(""); setConfirmPassword(""); }}
                      className="font-medium text-primary hover:underline"
                    >
                      Sign in
                    </button>
                  </>
                )}
              </p>
            </div>
          </div>

          <AuthPageFooter />
        </motion.div>
      </main>
    </div>
  );
}
