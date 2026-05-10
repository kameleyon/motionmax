/**
 * CookiePreferencesSection — Settings → Security → Cookie preferences.
 *
 * In-product withdrawal mechanism for cookie consent (B-NEW-9 / GDPR
 * Art. 7(3)). The user must be able to change their mind as easily as
 * they gave consent, so we mirror the banner here without the modal
 * pressure. Source of truth is `@/lib/cookieConsent`.
 *
 * Visual chrome reuses the `.settings-shell .card` tokens defined in
 * `src/styles/settings-tokens.css` (aqua + gold; no red, no green).
 */

import { useEffect, useState } from "react";
import { Loader2, Cookie, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  CONSENT_POLICY_VERSION,
  getConsent,
  onConsentChange,
  revokeConsent,
  setConsent,
} from "@/lib/cookieConsent";

export default function CookiePreferencesSection() {
  const [functional, setFunctional] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Sync from storage on mount and on cross-component change.
  useEffect(() => {
    function load() {
      const record = getConsent();
      if (record) {
        setFunctional(record.categories.functional);
        setAnalytics(record.categories.analytics);
        setMarketing(record.categories.marketing);
        setSavedAt(record.timestamp);
        setSavedVersion(record.version);
      } else {
        setFunctional(false);
        setAnalytics(false);
        setMarketing(false);
        setSavedAt(null);
        setSavedVersion(null);
      }
    }
    load();
    return onConsentChange(load);
  }, []);

  const handleSave = () => {
    setIsSaving(true);
    try {
      setConsent({ functional, analytics, marketing });
      toast.success("Cookie preferences saved.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleRevoke = () => {
    revokeConsent();
    toast.success("Preferences forgotten. The cookie banner will reappear.");
  };

  return (
    <div className="card">
      <h3 style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <Cookie size={18} style={{ color: "var(--cyan)" }} />
        Cookie preferences
      </h3>
      <p style={{ fontSize: 12.5, color: "var(--ink-mute)", margin: "0 0 14px", lineHeight: 1.55 }}>
        Choose which categories of cookies you allow. Necessary cookies (auth,
        security, billing) are always on because the site cannot function
        without them. You can withdraw consent for any other category at any
        time — withdrawal is as easy as consent (GDPR Art. 7).
      </p>

      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 0 }}>
        <CookieRow
          id="cps-necessary"
          title="Necessary"
          description="Auth, security, billing. Required for the site to work."
          checked
          disabled
        />
        <CookieRow
          id="cps-functional"
          title="Functional"
          description="Language preference and theme persistence."
          checked={functional}
          onChange={setFunctional}
        />
        <CookieRow
          id="cps-analytics"
          title="Analytics"
          description="Anonymised usage statistics and Sentry session replay on errors."
          checked={analytics}
          onChange={setAnalytics}
        />
        <CookieRow
          id="cps-marketing"
          title="Marketing"
          description="Pixel tracking and retargeting. Reserved — currently unused by MotionMax."
          checked={marketing}
          onChange={setMarketing}
        />
      </ul>

      {savedAt && (
        <p style={{ fontSize: 11.5, color: "var(--ink-mute)", margin: "10px 0 0", lineHeight: 1.5 }}>
          Last saved {new Date(savedAt).toLocaleString()} · policy version{" "}
          <code style={{ fontFamily: "var(--mono)" }}>{savedVersion ?? CONSENT_POLICY_VERSION}</code>
        </p>
      )}
      {!savedAt && (
        <p style={{ fontSize: 11.5, color: "var(--ink-mute)", margin: "10px 0 0", lineHeight: 1.5 }}>
          No saved preferences yet. The banner will appear on next page load.
        </p>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn-ghost"
          onClick={handleRevoke}
          aria-label="Forget my cookie preferences"
        >
          <RotateCcw size={14} />
          Forget my preferences
        </button>
        <button
          type="button"
          className="btn-cyan"
          onClick={handleSave}
          disabled={isSaving}
          aria-label="Save cookie preferences"
        >
          {isSaving && <Loader2 size={14} className="animate-spin" />}
          Save preferences
        </button>
      </div>
    </div>
  );
}

interface CookieRowProps {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (next: boolean) => void;
}

function CookieRow({ id, title, description, checked, disabled, onChange }: CookieRowProps) {
  return (
    <li
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
        padding: "12px 0",
        borderTop: "1px solid var(--line)",
      }}
    >
      <label htmlFor={id} style={{ flex: 1, cursor: disabled ? "not-allowed" : "pointer", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>
          {title}
          {disabled && (
            <span
              style={{
                fontSize: 9.5,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                background: "var(--gold-dim)",
                color: "var(--gold)",
                padding: "2px 6px",
                borderRadius: 4,
                fontWeight: 600,
              }}
            >
              Always on
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-mute)", lineHeight: 1.5, marginTop: 2 }}>
          {description}
        </div>
      </label>
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-label={`${title} cookies`}
        disabled={disabled}
        onClick={() => !disabled && onChange?.(!checked)}
        style={{
          position: "relative",
          flexShrink: 0,
          width: 38,
          height: 22,
          borderRadius: 999,
          border: "1px solid var(--line-2)",
          background: checked ? "var(--cyan)" : "var(--panel-3)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
          transition: "background-color 0.15s ease",
          marginTop: 2,
          padding: 0,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: 999,
            background: "var(--bg)",
            transition: "left 0.15s ease",
          }}
        />
      </button>
    </li>
  );
}
