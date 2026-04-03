import { useEffect, useState, useRef } from "react";
import { motion } from "framer-motion";
import { useNavigate, useLocation } from "react-router-dom";
import { Mail, Lock, ArrowRight, Eye, EyeOff, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { useForceDarkMode } from "@/hooks/useForceDarkMode";
import { ThemedLogo } from "@/components/ThemedLogo";
import { supabase } from "@/integrations/supabase/client";
import { getAuthErrorMessage } from "@/lib/authErrors";
import { PasswordStrengthMeter } from "@/components/ui/password-strength";

type AuthMode = "login" | "signup" | "reset" | "update";

// Single constant governs minimum password length across all auth flows
const MIN_PASSWORD_LENGTH = 8;
// Show rate-limit hint after this many consecutive login failures
const RATE_LIMIT_HINT_THRESHOLD = 3;

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

export default function Auth() {
  // Force dark mode on Auth page — always dark
  useForceDarkMode();

  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const modeParam = searchParams.get("mode");
  const initialMode: AuthMode = modeParam === "signin" ? "login" : modeParam === "signup" ? "signup" : "login";

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
  const failedAttemptsRef = useRef(0);
  const navigate = useNavigate();
  const returnUrl = searchParams.get("returnUrl") || "/app";
  const { signIn, signUp, resetPassword, updatePassword } = useAuth();

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
    setIsLoading(true);

    try {
      if (mode === "login") {
        const { error } = await signIn(email, password);
        if (error) {
          failedAttemptsRef.current += 1;
          if (failedAttemptsRef.current >= RATE_LIMIT_HINT_THRESHOLD) {
            setShowRateLimitHint(true);
          }
          toast.error("Sign in failed", { description: getAuthErrorMessage(error.message) });
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
        const { error } = await signUp(email, password);
        if (error) {
          toast.error("Sign up failed", { description: getAuthErrorMessage(error.message) });
          return;
        }
        // Show persistent confirmation screen instead of just a dismissible toast
        setShowEmailSent(true);
        return;
      }

      if (mode === "reset") {
        const { error } = await resetPassword(email);
        if (error) {
          toast.error("Reset failed", { description: getAuthErrorMessage(error.message) });
          return;
        }
        toast.success("Reset link sent", { description: "Check your email for a password reset link." });
        setMode("login");
        return;
      }

      // mode === "update"
      if (password.length < MIN_PASSWORD_LENGTH) {
        toast.error("Password too short", { description: `Use at least ${MIN_PASSWORD_LENGTH} characters.` });
        return;
      }
      if (password !== confirmPassword) {
        toast.error("Passwords don't match", { description: "Please retype your password." });
        return;
      }

      const { error } = await updatePassword(password);
      if (error) {
        toast.error("Update failed", { description: getAuthErrorMessage(error.message) });
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
      <AuthPageHeader onLogoClick={() => navigate("/")} />

      <main className="flex flex-1 items-center justify-center px-6 pt-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="w-full max-w-md"
        >
          <div className="rounded-2xl border border-border/50 bg-card/50 p-8 shadow-sm backdrop-blur-sm">
            <div className="mb-8 text-center">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {mode === "login" ? "Welcome back"
                  : mode === "signup" ? "Create your account"
                  : mode === "reset" ? "Reset your password"
                  : "Set a new password"}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {mode === "login" ? "Sign in to continue creating videos"
                  : mode === "signup" ? "Start turning your knowledge into cinema"
                  : mode === "reset" ? "We'll email you a reset link"
                  : "Choose a new password to finish resetting"}
              </p>
              {mode === "signup" && (
                <p className="mt-2 text-sm font-medium text-primary">
                  Free — no credit card needed
                </p>
              )}
            </div>

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
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-10"
                      required
                    />
                  </div>
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
                      onChange={(e) => setPassword(e.target.value)}
                      className="pl-10 pr-10"
                      required
                      minLength={MIN_PASSWORD_LENGTH}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
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
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="pl-10 pr-10"
                      required
                      minLength={MIN_PASSWORD_LENGTH}
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              )}

              {showRateLimitHint && mode === "login" && (
                <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded-lg px-3 py-2">
                  Too many failed attempts? You may be temporarily rate-limited. Wait a few minutes before trying again.
                </p>
              )}

              {mode === "signup" && (
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
                    {" "}and{" "}
                    <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                      Privacy Policy
                    </a>
                  </label>
                </div>
              )}

              <Button
                type="submit"
                className="w-full gap-2 rounded-lg bg-primary py-5 font-medium text-primary-foreground"
                disabled={isLoading}
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
