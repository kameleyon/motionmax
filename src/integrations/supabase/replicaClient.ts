/**
 * Read-replica Supabase client for admin / analytics queries.
 *
 * Use this client INSTEAD OF the default `supabase` client when:
 *   • The query is a pure SELECT (no INSERT / UPDATE / DELETE).
 *   • The data is allowed to be slightly stale (admin dashboards,
 *     analytics, matview reads — typically tolerant of <1 s lag).
 *   • The query is heavy or runs from a high-cardinality call site
 *     (admin tabs polling, dashboard refreshes).
 *
 * DO NOT use it for:
 *   • Auth-critical paths (login, role check, RLS-sensitive reads
 *     where freshness matters within milliseconds).
 *   • Any write — replicas are read-only on Supabase; writes will
 *     fail with a "cannot execute X in a read-only transaction"
 *     error from Postgres.
 *   • Queries that read a row this client JUST wrote (replication
 *     lag means you might read your own un-replicated write back).
 *
 * Activation:
 *   1. In the Supabase dashboard, Settings → Database → Read
 *      Replicas → Add Replica. Requires Pro plan + at least Small
 *      compute (which you already have as of 2026-05-18).
 *   2. The dashboard issues a per-replica URL like
 *      https://<projectref>-<region>.supabase.co. Copy it.
 *   3. Set VITE_SUPABASE_REPLICA_URL=<that url> in Vercel/Vite env.
 *   4. Restart the build. Imports of `supabaseReplica` now hit the
 *      replica; absent the env var they transparently fall back to
 *      the primary `supabase` client (no behavior change).
 *
 * The authentication / RLS context auto-propagates: the same JWT
 * the user holds for `supabase` is sent on requests to `supabase
 * Replica` (supabase-js attaches the auth token from session).
 * RLS policies evaluate on the replica using the SAME policy
 * definitions as the primary (DDL is replicated).
 */

import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

import { supabase, SUPABASE_ANON_KEY } from "./client";

const REPLICA_URL = import.meta.env.VITE_SUPABASE_REPLICA_URL as string | undefined;

/**
 * Read-only client for admin/analytics queries. When
 * `VITE_SUPABASE_REPLICA_URL` is unset (current state, 2026-05-18),
 * this is the same instance as `supabase` — callers can opt-in to
 * the import without waiting for the dashboard step.
 *
 * When the env var IS set, this is a SECOND createClient pointing
 * at the replica URL; the primary `supabase` client continues to
 * handle every write.
 */
export const supabaseReplica =
  REPLICA_URL && REPLICA_URL !== ""
    ? createClient<Database>(REPLICA_URL, SUPABASE_ANON_KEY, {
        auth: {
          // Don't persist a session on the replica client — sessions
          // are owned by the primary client. The replica just rides
          // whatever JWT is in storage via the auto-attached headers.
          persistSession: false,
          autoRefreshToken: false,
        },
        global: {
          headers: { "x-connection-pooler": "supavisor" },
        },
        db: { schema: "public" },
      })
    : supabase;

/**
 * `true` when a real replica URL is configured. Callers that want
 * to log/branch on "are we on a replica" can read this flag, e.g.
 * to apply tighter staleTime in React Query when freshness matters.
 */
export const HAS_REPLICA = Boolean(REPLICA_URL && REPLICA_URL !== "");
