#!/usr/bin/env node
/**
 * setup-betterstack-monitors.mjs
 * ─────────────────────────────────────────────────────────────────────
 * Idempotent BetterStack Uptime + Status Page provisioner for
 * MotionMax. Mirror of iac/betterstack/main.tf — use this when you
 * can't run terraform from your shell (Windows dev box, restricted
 * CI runner, fresh laptop) and you need monitors live NOW.
 *
 * Audit context: C-9-3 (external synthetic uptime) + C-9-4 (public
 * status page). Both were declared in iac/betterstack/main.tf but
 * never `terraform apply`'d, so a regional Supabase outage today
 * shows "everything is fine" in our in-app dashboard and there is no
 * public page customers can check while we're scrambling.
 *
 * USAGE
 *
 *   # 1) Drop a BETTERSTACK_API_TOKEN into .env.local (Settings →
 *   #    API tokens → "+ Create token"; full access for first run,
 *   #    can be downgraded to "Monitors" + "Status pages" scope).
 *   #
 *   # 2) Dry run to see what would be created:
 *   #    node scripts/setup-betterstack-monitors.mjs --dry-run
 *   #
 *   # 3) Real run (creates monitors + status page, idempotent):
 *   #    node scripts/setup-betterstack-monitors.mjs
 *   #
 *   # 4) Skip the status page (just monitors):
 *   #    node scripts/setup-betterstack-monitors.mjs --no-status-page
 *
 * WHAT IT CREATES — idempotent: looks up existing resources by
 * pronounceable_name / status-page subdomain before creating.
 *
 *   MONITORS
 *     - MotionMax Frontend Health   https://app.motionmax.io/health
 *     - MotionMax Worker Health     https://api.motionmax.io/health
 *     - MotionMax Worker Ready      https://api.motionmax.io/ready
 *     - Supabase Project Health     https://<project>.supabase.co/health/v1
 *
 *   STATUS PAGE — https://status.motionmax.io
 *     Resources: Frontend, Worker, Database & Auth.
 *
 * AFTER RUNNING:
 *   - Point `status.motionmax.io` CNAME at the BetterStack status-page
 *     subdomain (the script prints the target). See iac/cloudflare/dns.tf
 *     for the matching Terraform resource and add to it; or set
 *     manually in the Cloudflare dashboard.
 *   - Wire an escalation policy in BetterStack (Settings → On-Call →
 *     Policies). Pass its ID via --policy-id <id> on re-run to attach
 *     it to all monitors.
 *
 * REFERENCE
 *   BetterStack API docs: https://betterstack.com/docs/uptime/api/
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ── .env.local loader (no dotenv dep) ───────────────────────────────────────
function loadEnvLocal() {
  const candidates = [
    path.join(REPO_ROOT, ".env.local"),
    path.join(REPO_ROOT, ".env"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  }
}
loadEnvLocal();

// ── CLI args ────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const SKIP_STATUS_PAGE = args.has("--no-status-page");
const policyIdArgIdx = process.argv.indexOf("--policy-id");
const POLICY_ID =
  policyIdArgIdx > 0 ? process.argv[policyIdArgIdx + 1] : process.env.BETTERSTACK_POLICY_ID || "";

const TOKEN = process.env.BETTERSTACK_API_TOKEN || process.env.BETTERSTACK_TOKEN || "";
if (!TOKEN) {
  console.error("ERROR: BETTERSTACK_API_TOKEN not set in .env.local or environment.");
  console.error("Get one from https://uptime.betterstack.com/team/<id>/api-tokens");
  process.exit(1);
}

const API_BASE = "https://uptime.betterstack.com/api/v2";

// ── Monitor definitions — keep in lock-step with iac/betterstack/main.tf ─
const SUPABASE_HEALTH_URL =
  process.env.SUPABASE_HEALTH_URL ||
  "https://ayjbvcikuwknqdrpsdmj.supabase.co/health/v1";

const MONITORS = [
  {
    pronounceable_name: "MotionMax Frontend Health",
    url: "https://app.motionmax.io/health",
    check_frequency: 60,
    request_timeout: 10,
    confirmation_period: 120,
    expected_status_codes: [200],
    ssl_expiration: 14,
    domain_expiration: 30,
    status_page_label: "App (motionmax.io)",
    status_page_position: 0,
  },
  {
    pronounceable_name: "MotionMax Worker Health",
    url: "https://api.motionmax.io/health",
    check_frequency: 60,
    request_timeout: 15,
    confirmation_period: 120,
    expected_status_codes: [200],
    ssl_expiration: 14,
    status_page_label: "Render API & Worker",
    status_page_position: 1,
  },
  {
    pronounceable_name: "MotionMax Worker Ready",
    url: "https://api.motionmax.io/ready",
    check_frequency: 60,
    request_timeout: 15,
    confirmation_period: 120,
    expected_status_codes: [200],
    ssl_expiration: 14,
    // /ready returns 503 during graceful shutdown so it alerts BEFORE /health.
    // Not surfaced on the public status page (worker_health covers it).
  },
  {
    pronounceable_name: "Supabase Project Health",
    url: SUPABASE_HEALTH_URL,
    check_frequency: 120,
    request_timeout: 10,
    confirmation_period: 180,
    expected_status_codes: [200],
    ssl_expiration: 14,
    status_page_label: "Database & Auth",
    status_page_position: 2,
  },
];

const STATUS_PAGE = {
  company_name: "MotionMax",
  company_url: "https://app.motionmax.io",
  contact_url: "https://app.motionmax.io/support",
  subdomain: "motionmax",
  custom_domain: "status.motionmax.io",
  timezone: "Etc/UTC",
  history: 90,
  layout: "vertical",
  theme: "dark",
  hide_from_search_engines: false,
};

// ── HTTP helper ─────────────────────────────────────────────────────────────
async function api(method, pathname, body) {
  const url = `${API_BASE}${pathname}`;
  if (DRY_RUN && method !== "GET") {
    console.log(`  [dry-run] ${method} ${pathname}`);
    return { dryRun: true };
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const detail = json?.errors ? JSON.stringify(json.errors) : text.slice(0, 400);
    throw new Error(`${method} ${pathname} → ${res.status}: ${detail}`);
  }
  return json;
}

async function listAllMonitors() {
  const out = [];
  let nextPage = "/monitors?per_page=50";
  while (nextPage) {
    const res = await api("GET", nextPage);
    if (!res?.data) break;
    out.push(...res.data);
    const nextUrl = res?.pagination?.next || null;
    if (!nextUrl) break;
    // Strip the absolute base if BetterStack returns a fully qualified URL.
    nextPage = nextUrl.replace(API_BASE, "");
  }
  return out;
}

async function ensureMonitor(spec, existingByName) {
  const existing = existingByName.get(spec.pronounceable_name);
  const payload = {
    monitor_type: "expected_status_code",
    url: spec.url,
    pronounceable_name: spec.pronounceable_name,
    check_frequency: spec.check_frequency,
    request_timeout: spec.request_timeout,
    recovery_period: 0,
    confirmation_period: spec.confirmation_period,
    regions: ["us", "eu"],
    expected_status_codes: spec.expected_status_codes,
    ssl_expiration: spec.ssl_expiration,
    ...(spec.domain_expiration ? { domain_expiration: spec.domain_expiration } : {}),
    ...(POLICY_ID ? { policy_id: POLICY_ID } : {}),
    email: true,
    push: true,
    sms: false,
    call: false,
  };

  if (existing) {
    console.log(`  · already exists: ${spec.pronounceable_name} (id=${existing.id})`);
    return { id: existing.id, created: false };
  }
  console.log(`  + creating: ${spec.pronounceable_name}`);
  const res = await api("POST", "/monitors", payload);
  if (DRY_RUN) return { id: null, created: true };
  return { id: res?.data?.id, created: true };
}

async function listStatusPages() {
  const out = [];
  let nextPage = "/status-pages?per_page=50";
  while (nextPage) {
    const res = await api("GET", nextPage);
    if (!res?.data) break;
    out.push(...res.data);
    const nextUrl = res?.pagination?.next || null;
    if (!nextUrl) break;
    nextPage = nextUrl.replace(API_BASE, "");
  }
  return out;
}

async function ensureStatusPage() {
  const pages = await listStatusPages();
  const existing = pages.find(
    (p) =>
      p?.attributes?.subdomain === STATUS_PAGE.subdomain ||
      p?.attributes?.custom_domain === STATUS_PAGE.custom_domain,
  );
  if (existing) {
    console.log(`  · status page already exists (id=${existing.id})`);
    return existing.id;
  }
  console.log("  + creating status page");
  const res = await api("POST", "/status-pages", STATUS_PAGE);
  if (DRY_RUN) return null;
  return res?.data?.id ?? null;
}

async function ensureStatusPageResource(pageId, monitorId, spec) {
  if (!pageId || !monitorId) return;
  if (DRY_RUN) {
    console.log(`    [dry-run] would attach ${spec.status_page_label}`);
    return;
  }
  // List existing resources for this page so we don't double-attach.
  const existing = await api("GET", `/status-pages/${pageId}/resources`);
  const alreadyAttached = (existing?.data ?? []).some(
    (r) => r?.attributes?.resource_id === monitorId,
  );
  if (alreadyAttached) {
    console.log(`    · resource already attached: ${spec.status_page_label}`);
    return;
  }
  await api("POST", `/status-pages/${pageId}/resources`, {
    resource_id: monitorId,
    resource_type: "Monitor",
    public_name: spec.status_page_label,
    position: spec.status_page_position,
  });
  console.log(`    + attached resource: ${spec.status_page_label}`);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `BetterStack setup — ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}; policy_id=${POLICY_ID || "(none, no auto-page)"}`,
  );
  console.log("");

  console.log("Monitors:");
  const existingMonitors = await listAllMonitors();
  const byName = new Map();
  for (const m of existingMonitors) {
    const name = m?.attributes?.pronounceable_name;
    if (name) byName.set(name, { id: m.id, ...m.attributes });
  }

  const monitorIds = new Map();
  for (const spec of MONITORS) {
    const { id } = await ensureMonitor(spec, byName);
    if (id) monitorIds.set(spec.pronounceable_name, id);
  }

  if (!SKIP_STATUS_PAGE) {
    console.log("");
    console.log("Status page:");
    const pageId = await ensureStatusPage();
    if (pageId) {
      for (const spec of MONITORS) {
        if (!spec.status_page_label) continue;
        const monitorId =
          monitorIds.get(spec.pronounceable_name) ??
          byName.get(spec.pronounceable_name)?.id;
        await ensureStatusPageResource(pageId, monitorId, spec);
      }
    }
  }

  console.log("");
  console.log("Done.");
  console.log("");
  console.log("NEXT STEPS:");
  console.log("  1. Point DNS: status.motionmax.io  CNAME  <subdomain>.betteruptime.com");
  console.log("     (Cloudflare TF: iac/cloudflare/dns.tf — copy an existing block and");
  console.log("      set name = 'status.${var.apex_domain}'.)");
  console.log("  2. In BetterStack, create an escalation policy and re-run with");
  console.log("     --policy-id <id>  to attach it to every monitor.");
  console.log("  3. Verify each /health endpoint is publicly reachable: ");
  console.log("       curl -sI https://app.motionmax.io/health");
  console.log("       curl -sI https://api.motionmax.io/health");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
