/**
 * build-user-mapping.mjs
 * Builds old→new user_id mapping by matching emails between
 * the OLD source DB and the NEW target DB.
 *
 * Outputs SQL INSERT statements for the user_id_map temp table
 * used by 003_fix_auth_migration.sql.
 *
 * Usage:
 *   node scripts/build-user-mapping.mjs <old_jwt> <new_jwt>
 *
 * Get JWTs from browser console:
 *   OLD: JSON.parse(localStorage.getItem('sb-hesnceozbedzrgvylqrm-auth-token'))?.access_token
 *   NEW: JSON.parse(localStorage.getItem('sb-ayjbvcikuwknqdrpsdmj-auth-token'))?.access_token
 *
 * Or use admin API to list users from both projects.
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { join } from "path";

// Source (OLD) DB
const OLD_URL  = "https://hesnceozbedzrgvylqrm.supabase.co";
const OLD_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhlc25jZW96YmVkenJndnlscXJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxNTUyOTIsImV4cCI6MjA4MzczMTI5Mn0.YU881FNTJeR_FAbOV3bTGBmUvYbbQfAX5KaHI6uq--U";

// Target (NEW) DB
const NEW_URL  = "https://ayjbvcikuwknqdrpsdmj.supabase.co";
const NEW_ANON = process.env.SUPABASE_ANON_KEY || "";

const TARGET_REF   = "ayjbvcikuwknqdrpsdmj";
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || "";

async function getAuthUsersViaAdmin(projectRef, accessToken) {
  const url = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: "SELECT id, email, created_at FROM auth.users ORDER BY created_at;",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Admin API failed: ${res.status} - ${body}`);
  }
  return res.json();
}

async function getOldUsersViaClient(jwt) {
  const sb = createClient(OLD_URL, OLD_ANON, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data, error } = await sb.from("profiles").select("user_id, display_name, created_at");
  if (error) throw new Error(`Old DB profiles query failed: ${error.message}`);
  return data || [];
}

async function getOldUserEmailsViaAdmin(oldRef, accessToken) {
  const url = `https://api.supabase.com/v1/projects/${oldRef}/database/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: "SELECT id, email, created_at FROM auth.users ORDER BY created_at;",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Old Admin API failed: ${res.status} - ${body}`);
  }
  return res.json();
}

async function main() {
  console.log("\n=== Build User ID Mapping ===\n");

  const accessToken = process.argv[2] || ACCESS_TOKEN;
  if (!accessToken) {
    console.error("Usage: node scripts/build-user-mapping.mjs <supabase_access_token>");
    console.error("");
    console.error("Get your access token from: https://supabase.com/dashboard/account/tokens");
    process.exit(1);
  }

  // Get old users from source DB
  console.log("Fetching old auth.users from source project...");
  const OLD_REF = "hesnceozbedzrgvylqrm";
  let oldUsers;
  try {
    oldUsers = await getOldUserEmailsViaAdmin(OLD_REF, accessToken);
  } catch (e) {
    console.error("Failed to fetch old users:", e.message);
    console.error("Make sure the access token has access to the source project.");
    process.exit(1);
  }

  console.log(`  Found ${oldUsers.length} old auth users`);

  // Get new users from target DB
  console.log("Fetching new auth.users from target project...");
  let newUsers;
  try {
    newUsers = await getAuthUsersViaAdmin(TARGET_REF, accessToken);
  } catch (e) {
    console.error("Failed to fetch new users:", e.message);
    process.exit(1);
  }

  console.log(`  Found ${newUsers.length} new auth users`);

  // Build email → old_user_id map
  const oldByEmail = new Map();
  for (const u of oldUsers) {
    if (u.email) oldByEmail.set(u.email.toLowerCase(), u);
  }

  // Build email → new_user_id map
  const newByEmail = new Map();
  for (const u of newUsers) {
    if (u.email) newByEmail.set(u.email.toLowerCase(), u);
  }

  // Match by email
  const mappings = [];
  const unmatchedOld = [];
  const unmatchedNew = [];

  for (const [email, oldUser] of oldByEmail) {
    const newUser = newByEmail.get(email);
    if (newUser) {
      if (oldUser.id !== newUser.id) {
        mappings.push({
          old_user_id: oldUser.id,
          new_user_id: newUser.id,
          email,
          old_created_at: oldUser.created_at,
        });
      }
      // If IDs match, no remap needed
    } else {
      unmatchedOld.push({ ...oldUser, email });
    }
  }

  for (const [email, newUser] of newByEmail) {
    if (!oldByEmail.has(email)) {
      unmatchedNew.push({ ...newUser, email });
    }
  }

  console.log(`\n  Mapped:        ${mappings.length} users (email match, different UUIDs)`);
  console.log(`  Already OK:    ${oldByEmail.size - mappings.length - unmatchedOld.length} users (same UUID)`);
  console.log(`  Unmatched old: ${unmatchedOld.length}`);
  console.log(`  Unmatched new: ${unmatchedNew.length}`);

  if (unmatchedOld.length > 0) {
    console.log("\n  ⚠ Unmatched old users (no matching email in new DB):");
    for (const u of unmatchedOld) {
      console.log(`    ${u.id} — ${u.email}`);
    }
  }

  // Generate SQL
  const lines = [
    "-- Auto-generated user_id mapping (by email)",
    `-- Generated: ${new Date().toISOString()}`,
    `-- Mappings: ${mappings.length}`,
    "",
    "-- Insert into the temp table created by 003_fix_auth_migration.sql",
    "-- OR use these INSERT statements to create a persistent mapping table:",
    "",
    "CREATE TEMP TABLE IF NOT EXISTS user_id_map (",
    "  old_user_id UUID NOT NULL PRIMARY KEY,",
    "  new_user_id UUID NOT NULL,",
    "  display_name TEXT,",
    "  email TEXT",
    ");",
    "",
  ];

  for (const m of mappings) {
    lines.push(
      `INSERT INTO user_id_map (old_user_id, new_user_id, display_name, email) ` +
      `VALUES ('${m.old_user_id}', '${m.new_user_id}', NULL, '${m.email}') ` +
      `ON CONFLICT (old_user_id) DO NOTHING;`
    );
  }

  lines.push("");
  lines.push("-- Unmatched old users (add manual mappings if needed):");
  for (const u of unmatchedOld) {
    lines.push(`-- UNMAPPED OLD: ${u.id} — ${u.email}`);
  }

  const outFile = join("scripts", "004_user_id_mapping.sql");
  writeFileSync(outFile, lines.join("\n") + "\n");
  console.log(`\n✅ Mapping SQL written to ${outFile}`);
  console.log("   Paste this into 003_fix_auth_migration.sql OR run it before the fix script.\n");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
