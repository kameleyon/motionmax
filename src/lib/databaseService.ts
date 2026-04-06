/**
 * Vendor-agnostic database service interface.
 *
 * Abstracts Supabase behind a clean contract so the rest of the app
 * never calls Supabase directly for CRUD.  If we migrate to
 * AWS / GCP / bare PostgreSQL, only this module needs to change.
 *
 * Usage:
 *   import { db } from "@/lib/databaseService";
 *   const { data, error } = await db.query("projects", q => q.select("*").eq("user_id", uid));
 */

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DbResult<T> {
  data: T | null;
  error: string | null;
}

/** Valid table names derived from the generated Database schema */
export type TableName = keyof Database["public"]["Tables"];

// Use `any` for the builder chain — callers get convenience while
// the abstraction boundary stays clean.  Internal Supabase generics
// are too complex to expose through a portable interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBuilder = any;
type BuildQuery = (builder: AnyBuilder) => AnyBuilder;

// ---------------------------------------------------------------------------
// Core service
// ---------------------------------------------------------------------------

function createDatabaseService() {
  return {
    /**
     * Run a read query against any table.
     * The `build` callback receives a PostgREST builder so callers
     * can chain `.select()`, `.eq()`, `.order()` etc.
     */
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      table: TableName,
      build: BuildQuery,
    ): Promise<DbResult<T[]>> {
      const base = (supabase as AnyBuilder).from(table).select();
      const { data, error } = await build(base);
      if (error) return { data: null, error: error.message };
      return { data: data as T[], error: null };
    },

    /**
     * Insert one or more rows.
     */
    async insert<T extends Record<string, unknown> = Record<string, unknown>>(
      table: TableName,
      rows: Record<string, unknown> | Record<string, unknown>[],
    ): Promise<DbResult<T[]>> {
      const { data, error } = await (supabase as AnyBuilder)
        .from(table)
        .insert(rows)
        .select();
      if (error) return { data: null, error: error.message };
      return { data: data as T[], error: null };
    },

    /**
     * Update rows matching the filters set by `build`.
     */
    async update<T extends Record<string, unknown> = Record<string, unknown>>(
      table: TableName,
      values: Record<string, unknown>,
      build: BuildQuery,
    ): Promise<DbResult<T[]>> {
      const base = (supabase as AnyBuilder).from(table).update(values);
      const { data, error } = await build(base).select();
      if (error) return { data: null, error: error.message };
      return { data: data as T[], error: null };
    },

    /**
     * Delete rows matching the filters set by `build`.
     */
    async remove(
      table: TableName,
      build: BuildQuery,
    ): Promise<DbResult<null>> {
      const base = (supabase as AnyBuilder).from(table).delete();
      const { error } = await build(base);
      if (error) return { data: null, error: error.message };
      return { data: null, error: null };
    },

    /**
     * Invoke a Supabase Edge Function (or any serverless function).
     * Abstracts the transport so we can swap to plain `fetch` later.
     */
    async invoke<T extends Record<string, unknown> = Record<string, unknown>>(
      fnName: string,
      body?: Record<string, unknown>,
    ): Promise<DbResult<T>> {
      const { data, error } = await supabase.functions.invoke(fnName, {
        body: body ?? {},
      });
      if (error) return { data: null, error: error.message };
      return { data: data as T, error: null };
    },

    /** Direct access — escape hatch for features not yet abstracted. */
    get raw() {
      return supabase;
    },
  };
}

/** Singleton database service */
export const db = createDatabaseService();
