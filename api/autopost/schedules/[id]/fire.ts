/**
 * POST /api/autopost/schedules/:id/fire
 *
 * Manually queues a one-off run for the given schedule. Used for
 * end-to-end testing — bypasses the pg_cron tick. Worker polling on
 * autopost_runs.status='queued' picks it up.
 *
 * Auth: admin session JWT, ownership verified.
 */

import { requireAdmin, isResponse } from '../../../_shared/auth';
import { handlePreflight, corsHeaders } from '../../../_shared/cors';
import { logError } from '../../../_shared/platformConfig';

type ScheduleRow = {
  id: string;
  user_id: string;
  prompt_template: string;
  topic_pool: string[] | null;
  active: boolean;
};

function extractScheduleIdFromUrl(req: Request): string | null {
  try {
    const u = new URL(req.url);
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.lastIndexOf('schedules');
    if (i >= 0 && parts.length > i + 1) {
      return decodeURIComponent(parts[i + 1]!);
    }
    return null;
  } catch {
    return null;
  }
}

function pickTopic(pool: string[] | null): string | null {
  if (!pool || pool.length === 0) return null;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] ?? null;
}

function resolvePrompt(template: string, topic: string | null): string {
  const today = new Date();
  const day = today.toLocaleDateString('en-US', { weekday: 'long' });
  const date = today.toISOString().slice(0, 10);
  return template
    .replace(/\{topic\}/g, topic ?? '')
    .replace(/\{day\}/g, day)
    .replace(/\{date\}/g, date);
}

export default async function handler(req: Request): Promise<Response> {
  const pf = handlePreflight(req);
  if (pf) return pf;

  const origin = req.headers.get('origin');

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const scheduleId = extractScheduleIdFromUrl(req);
  if (!scheduleId) {
    return new Response(JSON.stringify({ error: 'missing_schedule_id' }), {
      status: 400,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  let user, supabase;
  try {
    ({ user, supabase } = await requireAdmin(req));
  } catch (e) {
    if (isResponse(e)) return e;
    logError('autopost.schedules.fire.auth', e);
    return new Response(JSON.stringify({ error: 'auth_error' }), {
      status: 500,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  // Ownership check.
  const { data: schedule, error: selectErr } = await supabase
    .from('autopost_schedules')
    .select('id, user_id, prompt_template, topic_pool, active')
    .eq('id', scheduleId)
    .maybeSingle();

  if (selectErr) {
    logError('autopost.schedules.fire.select', selectErr, { scheduleId });
    return new Response(
      JSON.stringify({ error: 'db_query_failed', message: selectErr.message }),
      {
        status: 500,
        headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
      }
    );
  }
  if (!schedule) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }
  const sched = schedule as ScheduleRow;
  if (sched.user_id !== user.id) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
  }

  const topic = pickTopic(sched.topic_pool);
  const promptResolved = resolvePrompt(sched.prompt_template, topic);

  const { data: run, error: insertErr } = await supabase
    .from('autopost_runs')
    .insert({
      schedule_id: sched.id,
      topic,
      prompt_resolved: promptResolved,
      status: 'queued',
    })
    .select('id, schedule_id, status, fired_at')
    .single();

  if (insertErr) {
    logError('autopost.schedules.fire.insert', insertErr, { scheduleId });
    return new Response(
      JSON.stringify({ error: 'db_insert_failed', message: insertErr.message }),
      {
        status: 500,
        headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
      }
    );
  }

  return new Response(JSON.stringify({ ok: true, run }), {
    status: 201,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
    },
  });
}
