import { Progress } from "@/components/ui/progress";

// eslint-disable-next-line react-refresh/only-export-components
/** Calculate a 0–100 password strength score */
export function getPasswordStrength(password: string): { score: number; label: string; color: string } {
  if (!password) return { score: 0, label: "", color: "bg-muted" };
  let score = 0;
  if (password.length >= 8) score += 25;
  else if (password.length >= 6) score += 10;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 25;
  if (/\d/.test(password)) score += 25;
  if (/[^a-zA-Z0-9]/.test(password)) score += 25;

  // Wave A PART F (2026-05-10): brand palette has no red/orange/green for
  // decorative meter states (per Canon: aqua + gold only; --destructive is
  // reserved for actual errors, not "weak password" guidance). The ramp is
  // now: Weak = charcoal (muted-foreground), Fair = brand gold-dark
  // (--warning), Good = brand gold (--gold), Strong = brand aqua
  // (--primary). The colour itself communicates progress along brand —
  // intensity rises rather than swapping hues.
  if (score <= 25) return { score, label: "Weak", color: "bg-muted-foreground" };
  if (score <= 50) return { score, label: "Fair", color: "bg-warning" };
  if (score <= 75) return { score, label: "Good", color: "bg-gold" };
  return { score, label: "Strong", color: "bg-primary" };
}

interface PasswordStrengthMeterProps {
  password: string;
  showRequirements?: boolean;
}

export function PasswordStrengthMeter({ password, showRequirements = true }: PasswordStrengthMeterProps) {
  if (!password) return null;

  const strength = getPasswordStrength(password);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Password strength</span>
        <span className={`font-medium ${
          strength.score <= 25 ? "text-muted-foreground" :
          strength.score <= 50 ? "text-warning" :
          strength.score <= 75 ? "text-gold" :
          "text-primary"
        }`}>
          {strength.label}
        </span>
      </div>
      <Progress value={strength.score} className="h-1.5" />
      {showRequirements && (
        <ul className="text-xs text-muted-foreground space-y-0.5 mt-1">
          <li className={password.length >= 8 ? "text-primary" : ""}>{password.length >= 8 ? "✓" : "✗"} At least 8 characters</li>
          <li className={/[a-z]/.test(password) && /[A-Z]/.test(password) ? "text-primary" : ""}>{/[a-z]/.test(password) && /[A-Z]/.test(password) ? "✓" : "✗"} Uppercase and lowercase letters</li>
          <li className={/\d/.test(password) ? "text-primary" : ""}>{/\d/.test(password) ? "✓" : "✗"} At least one number</li>
          <li className={/[^a-zA-Z0-9]/.test(password) ? "text-primary" : ""}>{/[^a-zA-Z0-9]/.test(password) ? "✓" : "✗"} At least one special character</li>
        </ul>
      )}
    </div>
  );
}
