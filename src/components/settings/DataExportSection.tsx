/**
 * DataExportSection — Settings → Security → Data export (GDPR Article 20)
 *
 * Surfaces the existing `export-my-data` Edge Function so users can actually
 * exercise their right to data portability. The function returns a JSON
 * blob (Content-Type: application/json, Content-Disposition: attachment)
 * containing every row owned by the caller across the user-data tables.
 *
 * Implementation notes:
 *   • We use direct fetch (not supabase.functions.invoke) because invoke
 *     parses JSON and we want the raw bytes to hand back as a Blob the
 *     user downloads. The function URL pattern is
 *     `${SUPABASE_URL}/functions/v1/export-my-data`.
 *   • The function rate-limits to 1 export/hour and caps at 10 MB —
 *     these limits are surfaced as user-readable errors when triggered.
 *   • All errors are toasted with a clear support@motionmax.io reference.
 *
 * GDPR Art. 20 — Data portability requirement is binding under EU law
 * regardless of where the user is located; we offer it to all accounts.
 */

import { useState } from "react";
import { Loader2, Download, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { supabase, SUPABASE_URL } from "@/integrations/supabase/client";

export default function DataExportSection() {
  const [isExporting, setIsExporting] = useState(false);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const [readyAt, setReadyAt] = useState<string | null>(null);

  const handleExport = async () => {
    setIsExporting(true);
    setReadyUrl(null);
    setReadyAt(null);
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      const token = sessionData.session?.access_token;
      if (!token) {
        toast.error("You appear to be signed out. Please sign in and try again, or contact support@motionmax.io.");
        return;
      }

      // Direct fetch so we can grab the response as a Blob (the function
      // returns the JSON body with a Content-Disposition: attachment header).
      const res = await fetch(`${SUPABASE_URL}/functions/v1/export-my-data`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        // Try to parse a JSON error body; if not JSON, fall back to status text.
        let message = `Request failed with status ${res.status}.`;
        try {
          const errBody = await res.json();
          if (errBody?.message) message = String(errBody.message);
          else if (errBody?.error) message = String(errBody.error);
        } catch {
          /* not JSON, keep default */
        }
        if (res.status === 429) {
          toast.error(`Rate limit reached. ${message}`);
        } else if (res.status === 413) {
          toast.error(`${message} If you need help, email support@motionmax.io.`);
        } else if (res.status === 401) {
          toast.error("Your session expired. Please sign in again, or contact support@motionmax.io.");
        } else {
          toast.error(`${message} If this persists, email support@motionmax.io.`);
        }
        return;
      }

      // The function returns JSON. Grab it as a blob and stage a download.
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      // Try to extract a filename from Content-Disposition; fall back to a sensible default.
      const cd = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(cd);
      const filename = match?.[1] ?? `motionmax-data-export-${new Date().toISOString().slice(0, 10)}.json`;

      // Auto-trigger a download so the user gets the file immediately.
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      // Also keep the link visible on the page in case the auto-download was blocked by the browser.
      setReadyUrl(url);
      setReadyAt(new Date().toISOString());
      toast.success("Your data export is ready. Download starting…");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Couldn't generate your export: ${message}. Please try again or contact support@motionmax.io.`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="card">
      <h3 style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <ShieldCheck size={18} style={{ color: "var(--cyan)" }} />
        Export my data (GDPR Article 20)
      </h3>
      <p
        style={{
          fontSize: 13,
          color: "var(--ink-dim)",
          margin: "0 0 14px",
          lineHeight: 1.55,
        }}
      >
        We&apos;ll send you a JSON archive of your account data — projects, voices,
        billing history, generated content metadata. This typically takes a few
        seconds; large accounts may take longer. You&apos;ll receive an email when
        it&apos;s ready, or you can wait on this page.
      </p>
      <p
        style={{
          fontSize: 12,
          color: "var(--ink-mute)",
          margin: "0 0 14px",
          lineHeight: 1.55,
        }}
      >
        Limit: one export per hour. Max archive size 10&nbsp;MB. If your archive
        exceeds the limit, email{" "}
        <a href="mailto:support@motionmax.io" style={{ color: "var(--cyan)" }}>
          support@motionmax.io
        </a>{" "}
        and we&apos;ll process it manually.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {readyUrl && (
          <a
            href={readyUrl}
            download
            className="btn-ghost"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            data-export-ready-at={readyAt ?? undefined}
          >
            <Download size={14} />
            Download archive
          </a>
        )}
        <button
          type="button"
          className="btn-cyan"
          onClick={handleExport}
          disabled={isExporting}
        >
          {isExporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {isExporting ? "Preparing export…" : "Request export"}
        </button>
      </div>
    </div>
  );
}
