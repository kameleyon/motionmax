import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AUTOPOST_CREDITS_PER_RUN, isAutopostEligible } from '@/lib/planLimits';
import { useSubscription } from '@/hooks/useSubscription';
import {
  Clock, Wand2, Loader2, RefreshCw, Plug, Youtube, Instagram, Music2,
  Send, Mail, FolderHeart, X as XIcon, Zap,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import {
  SCHEDULE_INTERVALS, RUNS_PER_MONTH,
  type ScheduleInterval,
} from './_scheduleConstants';

/** How the rendered video gets out of the system after each scheduled run. */
export type DeliveryMethod = 'social' | 'email' | 'library_only';

/** Persisted state — what the parent <IntakeForm /> reads on submit. */
export interface ScheduleState {
  enabled: boolean;
  interval: ScheduleInterval | null;
  /** Topics the user has CHECKED — these become the schedule's queue. */
  topics: string[];
  /** Last batch the worker generated, for the UI to render the checkbox list. */
  generatedTopics: string[];
  /** autopost_social_accounts.id values selected for publishing. */
  platformAccountIds: string[];
  /** Where rendered videos go: social platforms, email, or library only. */
  deliveryMethod: DeliveryMethod;
  /** Email addresses to notify when each render completes. Used when
   *  deliveryMethod === 'email'. Default-seeded with the user's auth email. */
  emailRecipients: string[];
  termsAgreed: boolean;
}

export interface ScheduleBlockProps {
  enabled: boolean;
  onChange: (s: ScheduleState) => void;
  /** Read by the topic-generation worker as the seed for ideation. */
  intakeSummary: { prompt: string; styleId: string; aspect: string; voice: string; language?: string; sourceAttachments?: import('@/components/workspace/SourceInput').SourceAttachment[] };
  /** Whole-block visibility gate — soft launch is admins only. */
  isAdmin: boolean;
}

const DRAFT_KEY = 'motionmax.scheduleblock.draft';
const TOPIC_POLL_MS = 1500;
// Worker callGemini timeout for search-grounded topic gen is 180s, and
// the retryClassifier auto-retries up to 3x on AbortError. We poll for
// 5 min — enough to cover one retry attempt without leaving the
// intake form spinning forever.
const TOPIC_POLL_TIMEOUT_MS = 300_000;
/** Per-run cost estimate used for the "X credits/month" helper. The
 *  intake form's full cost calculator is downstream of which mode
 *  the user picked; we use a conservative single number here so the
 *  helper is honest without being precise. Wave B2 can replace this
 *  with a live read from the parent's `totalCost`. */
// Re-exported as a const for backwards-compat with the existing
// monthly-cost calculation below. Mirrors the flat-45 SQL deduction.
const PER_RUN_CREDIT_ESTIMATE = AUTOPOST_CREDITS_PER_RUN;

const PLATFORMS: Array<{ id: 'youtube' | 'instagram' | 'tiktok'; label: string; Icon: typeof Youtube }> = [
  { id: 'youtube',   label: 'YouTube',   Icon: Youtube },
  { id: 'instagram', label: 'Instagram', Icon: Instagram },
  { id: 'tiktok',    label: 'TikTok',    Icon: Music2 },
];

interface SocialAccountRow {
  id: string;
  platform: 'youtube' | 'instagram' | 'tiktok';
  display_name: string;
  status: string;
}

export default function ScheduleBlock({
  enabled, onChange, intakeSummary, isAdmin: _isAdmin,
}: ScheduleBlockProps) {
  const { user } = useAuth();
  // Plan gate: autopost is a Creator/Studio feature. Free users see
  // the toggle but it's disabled with an upgrade CTA. Server-side the
  // SQL functions and INSERT policy reject free users regardless.
  const { plan } = useSubscription();
  const planEligible = isAutopostEligible(plan);

  // ── Block state — kept here, mirrored up via onChange so the parent
  //    handleGenerate() can read the latest values without prop drilling. ──
  const [interval, setInterval] = useState<ScheduleInterval | null>('daily');
  const [generatedTopics, setGeneratedTopics] = useState<string[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<Set<string>>(new Set());
  const [platformAccountIds, setPlatformAccountIds] = useState<Set<string>>(new Set());
  // Delivery mode + email recipients (Wave E). Default 'social' so the
  // existing user flow is unchanged; default-seed the recipient list with
  // the signed-in user's auth email below so email-mode is one click.
  // Default to 'library_only' while social-publishing is gated behind
  // Google's pending data-access verification. Flip back to 'social'
  // once the verification clears.
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>('library_only');
  const [emailRecipients, setEmailRecipients] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [generatingTopics, setGeneratingTopics] = useState(false);
  // Tracks whether a draft was loaded from localStorage on mount so the
  // mirror-up effect doesn't fire before hydration finishes — otherwise
  // the hydrated values would be immediately overwritten by the empty
  // initial state on the first render after hydration.
  const hydrated = useRef(false);

  // ── Hydrate from localStorage (OAuth round-trip return path) ──
  // When the user clicks "Connect" on a platform, we save the form
  // state, redirect to /api/autopost/connect/{platform}/start, and
  // expect them to land back on the intake page. On mount we restore
  // the draft so they don't have to re-type or re-pick anything.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) { hydrated.current = true; return; }
      const draft = JSON.parse(raw) as Partial<ScheduleState> & { savedAt?: number };
      // Discard drafts older than 30 minutes so a stale OAuth attempt
      // doesn't clobber a fresh form a week later.
      const STALE_MS = 30 * 60 * 1000;
      if (typeof draft.savedAt === 'number' && Date.now() - draft.savedAt > STALE_MS) {
        localStorage.removeItem(DRAFT_KEY);
        hydrated.current = true;
        return;
      }
      if (draft.interval) setInterval(draft.interval);
      if (Array.isArray(draft.generatedTopics)) setGeneratedTopics(draft.generatedTopics);
      if (Array.isArray(draft.topics)) setSelectedTopics(new Set(draft.topics));
      if (Array.isArray(draft.platformAccountIds)) setPlatformAccountIds(new Set(draft.platformAccountIds));
      if (
        draft.deliveryMethod === 'social'
        || draft.deliveryMethod === 'email'
        || draft.deliveryMethod === 'library_only'
      ) {
        setDeliveryMethod(draft.deliveryMethod);
      }
      if (Array.isArray(draft.emailRecipients)) setEmailRecipients(draft.emailRecipients);
      if (typeof draft.termsAgreed === 'boolean') setTermsAgreed(draft.termsAgreed);
      // Once hydrated we DON'T clear the draft — the user might still
      // round-trip through another platform's OAuth and we want every
      // hop to start from the latest state.
    } catch {
      // Corrupted draft — wipe so we don't keep tripping over it.
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    } finally {
      hydrated.current = true;
    }
  }, []);

  // ── Seed recipient list with the user's auth email ──
  // Runs once after hydration: if the draft (or initial state) left
  // emailRecipients empty AND we have a logged-in user, default the chip
  // list to their auth email. The user can still remove it. We don't
  // overwrite a non-empty list — that means the user already curated.
  useEffect(() => {
    if (!hydrated.current) return;
    if (emailRecipients.length > 0) return;
    const email = user?.email?.trim();
    if (email) setEmailRecipients([email]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated.current, user?.email]);

  // ── Mirror state up to the parent on every change ──
  useEffect(() => {
    if (!hydrated.current) return;
    onChange({
      enabled,
      interval,
      topics: Array.from(selectedTopics),
      generatedTopics,
      platformAccountIds: Array.from(platformAccountIds),
      deliveryMethod,
      emailRecipients,
      termsAgreed,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, interval, generatedTopics, selectedTopics, platformAccountIds, deliveryMethod, emailRecipients, termsAgreed]);

  // ── Connected accounts query — TanStack as required ──
  const accountsQuery = useQuery({
    queryKey: ['autopost-accounts-picker', user?.id],
    enabled: !!user && enabled,
    queryFn: async (): Promise<SocialAccountRow[]> => {
      const { data, error } = await supabase
        .from('autopost_social_accounts')
        .select('id, platform, display_name, status')
        .eq('user_id', user!.id)
        .order('connected_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as SocialAccountRow[];
    },
  });

  // Group rows by platform so we can render at most one section per
  // platform (with N checkboxes for users who connected multiple
  // accounts to the same platform — common with YouTube channels).
  const accountsByPlatform = useMemo(() => {
    const map: Record<string, SocialAccountRow[]> = { youtube: [], instagram: [], tiktok: [] };
    for (const row of accountsQuery.data ?? []) {
      if (map[row.platform]) map[row.platform].push(row);
    }
    return map;
  }, [accountsQuery.data]);

  // ── Topic generation flow ──
  // Insert a video_generation_jobs row, poll for `result.topics`.
  async function handleGenerateTopics() {
    if (!user) { toast.error('Please sign in to generate topics.'); return; }
    if ((intakeSummary.prompt ?? '').trim().length < 4) {
      toast.error('Add a content idea above first — even a sentence is enough.');
      return;
    }
    setGeneratingTopics(true);
    try {
      // Enrich the prompt with whatever the user attached (text files +
      // images already-inlined, URLs/YouTube/GitHub passed as markers
      // for the worker to fetch). If nothing was attached, this is "".
      const { processAttachments } = await import('@/lib/attachmentProcessor');
      const sources = intakeSummary.sourceAttachments && intakeSummary.sourceAttachments.length > 0
        ? await processAttachments(intakeSummary.sourceAttachments)
        : '';

      const { data: job, error } = await supabase
        .from('video_generation_jobs')
        .insert({
          user_id: user.id,
          task_type: 'generate_topics',
          status: 'pending',
          payload: {
            prompt: intakeSummary.prompt.trim(),
            styleId: intakeSummary.styleId,
            count: 15,
            sources,
            language: intakeSummary.language ?? 'en',
            // On regenerate we pass the previous batch so the worker
            // can dedup. Empty array on first run.
            existingTopics: generatedTopics,
          } as unknown as never,
        })
        .select('id')
        .single();
      if (error || !job) throw new Error(error?.message ?? 'queue failed');

      const deadline = Date.now() + TOPIC_POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, TOPIC_POLL_MS));
        const { data: row } = await supabase
          .from('video_generation_jobs')
          .select('status, result, error_message')
          .eq('id', job.id)
          .single();
        if (row?.status === 'completed') {
          const topics = (row.result as { topics?: string[] } | null)?.topics ?? [];
          if (!Array.isArray(topics) || topics.length === 0) {
            throw new Error('Worker returned no topics');
          }
          setGeneratedTopics(topics);
          // Default-select all so the user starts with a usable queue.
          setSelectedTopics(new Set(topics));
          toast.success(`Generated ${topics.length} topic ideas — uncheck any you don't want.`);
          return;
        }
        if (row?.status === 'failed') {
          throw new Error(row.error_message ?? 'Topic generation failed');
        }
      }
      throw new Error('Timed out waiting for topics — try again.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't generate topics: ${msg}`);
    } finally {
      setGeneratingTopics(false);
    }
  }

  /** Save the current draft to localStorage before redirecting to OAuth. */
  function persistDraftForOAuth() {
    try {
      const draft: ScheduleState & { savedAt: number } = {
        enabled,
        interval,
        topics: Array.from(selectedTopics),
        generatedTopics,
        platformAccountIds: Array.from(platformAccountIds),
        deliveryMethod,
        emailRecipients,
        termsAgreed,
        savedAt: Date.now(),
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Quota or disabled — not fatal, OAuth still works, user just
      // re-picks topics on return.
    }
  }

  function handleConnectPlatform(platform: 'youtube' | 'instagram' | 'tiktok') {
    persistDraftForOAuth();
    // Wave B1 frontend: build the start URL with current session token
    // so the callback can match the user. The auth token is passed via
    // the Supabase auth helper rather than embedded so we don't ship a
    // JWT through localStorage.
    supabase.auth.getSession().then(({ data: { session } }) => {
      const token = session?.access_token ?? '';
      const url = `/api/autopost/connect/${platform}/start?token=${encodeURIComponent(token)}`;
      window.location.href = url;
    });
  }

  function toggleTopic(topic: string) {
    setSelectedTopics((prev) => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic); else next.add(topic);
      return next;
    });
  }

  function selectAllTopics(checked: boolean) {
    setSelectedTopics(checked ? new Set(generatedTopics) : new Set());
  }

  function togglePlatformAccount(id: string) {
    setPlatformAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ── Email chip helpers ──
  // Loose email check — matches "x@y.z" with any non-whitespace head/tail
  // and a dot in the domain. Resend will do the real validation server-
  // side; this is just to stop obvious typos from creating useless chips.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function tryAddEmail(raw: string): boolean {
    const candidate = raw.trim().replace(/[,;]+$/, '');
    if (!candidate) return false;
    if (!EMAIL_RE.test(candidate)) {
      toast.error(`"${candidate}" doesn't look like a valid email.`);
      return false;
    }
    if (emailRecipients.includes(candidate)) {
      // Silent dedupe — adding the same one twice is an obvious no-op.
      return false;
    }
    setEmailRecipients((prev) => [...prev, candidate]);
    return true;
  }
  function removeEmail(addr: string) {
    setEmailRecipients((prev) => prev.filter((e) => e !== addr));
  }
  function handleEmailKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault();
      if (tryAddEmail(emailDraft)) setEmailDraft('');
    } else if (e.key === 'Backspace' && emailDraft === '' && emailRecipients.length > 0) {
      // Backspace on empty input pops the last chip — common chip-input
      // affordance, lets keyboard users undo without grabbing the mouse.
      setEmailRecipients((prev) => prev.slice(0, -1));
    }
  }
  function handleEmailBlur() {
    // Commit any in-flight text on blur so a partially-typed address
    // doesn't get silently dropped on submit.
    if (emailDraft.trim()) {
      if (tryAddEmail(emailDraft)) setEmailDraft('');
    }
  }

  // Visibility gate intentionally removed — automation is now GA for
  // every plan tier. Free users can walk the entire setup flow and
  // get the upgrade dialog at submit time (see IntakeForm.tsx). The
  // `isAdmin` prop is no longer consulted here; it's kept on the
  // interface so callers don't have to change.
  const monthlyRuns = interval ? RUNS_PER_MONTH[interval] : 0;
  // Cap displayed cost at 4 figures so a "Every 3 minutes" pick doesn't
  // print a 7-digit nightmare number — instead we say "1M+" and trust
  // the user to read the run-count hint above.
  const monthlyCost = monthlyRuns * PER_RUN_CREDIT_ESTIMATE;
  const monthlyCostLabel = monthlyCost > 99_999
    ? '99,999+'
    : monthlyCost.toLocaleString();

  const selectedCount = selectedTopics.size;

  return (
    <Card
      className={
        // Subtle teal glow + accent border when the toggle is OFF so
        // the row reads as a CTA, not just another setting card. Once
        // enabled, the glow recedes (it's no longer a marketing
        // surface — it's an active schedule editor).
        enabled
          ? 'bg-[#151B20] border-white/5 rounded-xl overflow-hidden text-[#ECEAE4] transition-colors'
          : 'bg-gradient-to-br from-[#14C8CC]/[0.07] via-[#151B20] to-[#151B20] border border-[#14C8CC]/30 rounded-xl overflow-hidden text-[#ECEAE4] shadow-[0_0_28px_-12px_rgba(20,200,204,0.55)] transition-colors'
      }
    >
      {/* Header — promoted from a plain "Run on a schedule" toggle to
          a discoverable Autopost CTA. The teal-glow card and the
          large icon make the row stand out as a marketing surface
          rather than blending into the rest of the intake settings.
          Label "Turn on Autopost" — clear value (Autopost is the
          product brand) + action verb. Sub-line spells the benefit so
          users can decide without expanding the section. */}
      <div className="flex items-center justify-between gap-3 px-4 py-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className={
            'w-9 h-9 shrink-0 rounded-lg grid place-items-center ' +
            (enabled
              ? 'bg-[#14C8CC]/10 text-[#14C8CC]'
              : 'bg-[#14C8CC]/15 text-[#14C8CC] ring-1 ring-[#14C8CC]/40')
          }>
            <Zap className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-[14px] font-semibold tracking-tight truncate">
                {enabled ? 'Autopost is on' : 'Turn on Autopost'}
              </div>
              {!planEligible && (
                <span className="shrink-0 text-[10px] uppercase tracking-wider text-[#E4C875] border border-[#E4C875]/30 bg-[#E4C875]/5 rounded px-1.5 py-0.5">
                  Creator+
                </span>
              )}
            </div>
            <div className="text-[11.5px] text-[#8A9198] mt-0.5 leading-snug">
              {enabled
                ? 'Videos generate on the schedule below — set it once.'
                : 'Generate fresh videos automatically on a schedule. Set it once.'}
            </div>
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => {
            onChange({
              enabled: v,
              interval,
              topics: Array.from(selectedTopics),
              generatedTopics,
              platformAccountIds: Array.from(platformAccountIds),
              deliveryMethod,
              emailRecipients,
              termsAgreed,
            });
          }}
          aria-label="Turn on Autopost"
        />
      </div>

      {!planEligible && enabled && (
        <div className="px-4 pb-3 -mt-1">
          <div className="rounded-md border border-[#E4C875]/30 bg-[#E4C875]/5 px-3 py-2 text-[12px] text-[#ECEAE4] flex items-start gap-2">
            <Clock className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[#E4C875]" />
            <div className="flex-1 min-w-0">
              <span className="text-[#E4C875] font-medium">Heads up — Autopost is a Creator/Studio feature.</span>{' '}
              <span className="text-[#8A9198]">You can configure your schedule below; you'll be prompted to upgrade when you click Generate. {AUTOPOST_CREDITS_PER_RUN} credits per run on Creator+.</span>{' '}
              <a href="/pricing" className="text-[#14C8CC] hover:underline whitespace-nowrap">See plans →</a>
            </div>
          </div>
        </div>
      )}

      {enabled && (
        <div className="border-t border-white/5">
          {/* ── Frequency picker ── */}
          <div className="px-4 py-3.5 border-b border-white/5">
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] mb-2">
              How often?
            </div>
            <Select
              value={interval ?? undefined}
              onValueChange={(v) => setInterval(v as ScheduleInterval)}
            >
              <SelectTrigger className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4] hover:border-[#14C8CC]/40">
                <SelectValue placeholder="Select a frequency" />
              </SelectTrigger>
              <SelectContent className="bg-[#151B20] border-white/10 text-[#ECEAE4]">
                {SCHEDULE_INTERVALS.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                    className="text-[#ECEAE4] focus:bg-[#14C8CC]/10 focus:text-[#ECEAE4]"
                  >
                    <span>{opt.label}</span>
                    <span className="text-xs text-muted-foreground ml-2">— {opt.hint}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {interval && (
              <div className="mt-2 text-[11.5px] text-[#8A9198] flex items-center gap-1.5">
                <span aria-hidden>💡</span>
                <span>
                  Estimated cost: ~{monthlyCostLabel} credits/month
                  <span className="text-[#5A6268] ml-1">({monthlyRuns.toLocaleString()} runs)</span>
                </span>
              </div>
            )}
          </div>

          {/* ── Pre-plan / topic generation ── */}
          <div className="px-4 py-3.5 border-b border-white/5">
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] mb-1.5">
              Pre-plan your content
            </div>
            <p className="text-[12px] leading-[1.5] text-[#8A9198] mb-3">
              Generate 15 topic suggestions — select which to queue for scheduled generation.
            </p>

            <Button
              type="button"
              onClick={handleGenerateTopics}
              disabled={generatingTopics}
              className="w-full bg-[#14C8CC]/10 border border-[#14C8CC]/30 text-[#14C8CC] hover:bg-[#14C8CC]/20 hover:text-[#ECEAE4]"
              variant="outline"
            >
              {generatingTopics ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 autopost-spin" />
                  Generating…
                </>
              ) : generatedTopics.length > 0 ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Regenerate
                </>
              ) : (
                <>
                  <Wand2 className="w-4 h-4 mr-2" />
                  Generate Topics
                </>
              )}
            </Button>

            {generatedTopics.length > 0 && (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-[10.5px] text-[#8A9198] tracking-wide">
                    {selectedCount} of {generatedTopics.length} selected
                  </span>
                  <button
                    type="button"
                    onClick={() => selectAllTopics(selectedCount !== generatedTopics.length)}
                    className="font-mono text-[10.5px] text-[#14C8CC] hover:text-[#ECEAE4] transition-colors"
                  >
                    {selectedCount === generatedTopics.length ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                <ul className="grid gap-1.5 max-h-[260px] overflow-y-auto pr-1">
                  {generatedTopics.map((t, idx) => {
                    const checked = selectedTopics.has(t);
                    const id = `topic-${idx}`;
                    return (
                      <li key={id} className="flex items-start gap-2.5 px-2.5 py-2 rounded-md border border-white/5 bg-[#0A0D0F] hover:border-white/10 transition-colors">
                        <Checkbox
                          id={id}
                          checked={checked}
                          onCheckedChange={() => toggleTopic(t)}
                          className="mt-0.5 border-[#14C8CC]/40 data-[state=checked]:bg-[#14C8CC] data-[state=checked]:text-[#0A0D0F]"
                        />
                        <label htmlFor={id} className="text-[12.5px] leading-[1.45] text-[#ECEAE4] cursor-pointer flex-1">
                          {t}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          {/* ── Delivery method picker (Wave E) ── */}
          {/* Three modes: publish to social, email per render, or just
              save to library. School / work / personal-library users
              can now schedule automations without ever connecting a
              social account. */}
          <div className="px-4 py-3.5 border-b border-white/5">
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] mb-2.5">
              Where it goes
            </div>
            <div
              role="radiogroup"
              aria-label="Where the rendered video is delivered"
              className="grid gap-2"
            >
              {[
                // 'social' is disabled until Google completes
                // youtube.upload data-access verification (4–8 wk
                // SLA). Re-enable by removing `disabled: true` here.
                { value: 'social' as const,       label: 'Publish to social media',         Icon: Send,        disabled: true },
                { value: 'email' as const,        label: 'Email me when each video is ready', Icon: Mail,        disabled: false },
                { value: 'library_only' as const, label: 'Just save to my library',         Icon: FolderHeart, disabled: false },
              ].map(({ value, label, Icon, disabled }) => {
                const selected = deliveryMethod === value;
                const inputId = `delivery-${value}`;
                return (
                  <label
                    key={value}
                    htmlFor={inputId}
                    aria-disabled={disabled}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border transition-colors ${
                      disabled
                        ? 'border-white/5 bg-[#0A0D0F] opacity-50 cursor-not-allowed'
                        : selected
                          ? 'border-[#14C8CC]/50 bg-[#14C8CC]/[0.06] cursor-pointer'
                          : 'border-white/5 bg-[#0A0D0F] hover:border-white/10 cursor-pointer'
                    }`}
                  >
                    <input
                      id={inputId}
                      type="radio"
                      name="autopost-delivery-method"
                      value={value}
                      checked={selected}
                      disabled={disabled}
                      onChange={() => { if (!disabled) setDeliveryMethod(value); }}
                      className="sr-only"
                    />
                    <span
                      aria-hidden
                      className={`w-3 h-3 rounded-full border-2 shrink-0 flex items-center justify-center ${
                        selected && !disabled ? 'border-[#14C8CC]' : 'border-white/20'
                      }`}
                    >
                      {selected && !disabled && <span className="w-1 h-1 rounded-full bg-[#14C8CC]" />}
                    </span>
                    <Icon className="w-3.5 h-3.5 text-[#14C8CC] shrink-0" />
                    <span className="text-[12px] text-[#ECEAE4] truncate">{label}</span>
                    {disabled && (
                      <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-[#E4C875] border border-[#E4C875]/30 bg-[#E4C875]/5 rounded px-1.5 py-0.5">
                        coming soon
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>

          {/* ── Mode-specific section ── */}
          {deliveryMethod === 'social' && (
            <div className="px-4 py-3.5 border-b border-white/5">
              <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] mb-2">
                Where to publish
              </div>
              {accountsQuery.isLoading && (
                <div className="text-[12px] text-[#8A9198] flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 autopost-spin" />
                  Loading connected accounts…
                </div>
              )}
              {!accountsQuery.isLoading && (
                <div className="grid gap-2 sm:gap-2.5">
                  {PLATFORMS.map(({ id, label, Icon }) => {
                    const accounts = accountsByPlatform[id] ?? [];
                    if (accounts.length === 0) {
                      return (
                        <div
                          key={id}
                          className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-md border border-white/5 bg-[#0A0D0F]"
                        >
                          <span className="flex items-center gap-2 text-[12.5px] text-[#8A9198]">
                            <Icon className="w-3.5 h-3.5 text-[#5A6268]" />
                            {label}
                            <span className="text-[#5A6268]">— Not connected</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => handleConnectPlatform(id)}
                            className="inline-flex items-center gap-1.5 font-mono text-[10.5px] tracking-wider uppercase text-[#e4c875] hover:text-[#ECEAE4] transition-colors"
                          >
                            <Plug className="w-3 h-3" />
                            Connect
                          </button>
                        </div>
                      );
                    }
                    return accounts.map((acc) => {
                      const checked = platformAccountIds.has(acc.id);
                      const idAttr = `acct-${acc.id}`;
                      return (
                        <div
                          key={acc.id}
                          className="flex items-center gap-2.5 px-3 py-2.5 rounded-md border border-white/5 bg-[#0A0D0F]"
                        >
                          <Checkbox
                            id={idAttr}
                            checked={checked}
                            onCheckedChange={() => togglePlatformAccount(acc.id)}
                            className="border-[#14C8CC]/40 data-[state=checked]:bg-[#14C8CC] data-[state=checked]:text-[#0A0D0F]"
                          />
                          <label htmlFor={idAttr} className="flex-1 flex items-center gap-2 text-[12.5px] text-[#ECEAE4] cursor-pointer">
                            <Icon className="w-3.5 h-3.5 text-[#14C8CC]" />
                            <span>{label}</span>
                            <span className="text-[#8A9198] truncate">— {acc.display_name}</span>
                          </label>
                          {acc.status !== 'connected' && (
                            <span className="font-mono text-[9.5px] tracking-wider uppercase text-[#e4c875]">
                              {acc.status}
                            </span>
                          )}
                        </div>
                      );
                    });
                  })}
                </div>
              )}
            </div>
          )}

          {deliveryMethod === 'email' && (
            <div className="px-4 py-3.5 border-b border-white/5">
              <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] mb-2">
                Email recipients
              </div>
              <p className="text-[12px] leading-[1.5] text-[#8A9198] mb-2.5">
                We'll send a download link to each address every time a render finishes.
                Press Enter or comma to add — Backspace to remove the last one.
              </p>
              {/* Chip + input row. We render the chips inline with the
                  input so it visually behaves like a single text field
                  the way GitHub / Notion email pickers do. */}
              <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2 rounded-md bg-[#0A0D0F] border border-white/10 focus-within:border-[#14C8CC]/40">
                {emailRecipients.map((addr) => (
                  <span
                    key={addr}
                    className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#14C8CC]/10 border border-[#14C8CC]/30 text-[#14C8CC] text-[12px]"
                  >
                    <Mail className="w-3 h-3" />
                    <span className="truncate max-w-[180px]">{addr}</span>
                    <button
                      type="button"
                      onClick={() => removeEmail(addr)}
                      className="hover:text-[#ECEAE4] transition-colors"
                      aria-label={`Remove ${addr}`}
                    >
                      <XIcon className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                <Input
                  type="email"
                  value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  onKeyDown={handleEmailKeyDown}
                  onBlur={handleEmailBlur}
                  placeholder={emailRecipients.length === 0 ? 'name@example.com' : 'Add another…'}
                  className="flex-1 min-w-[180px] bg-transparent border-0 px-1 h-7 text-[12.5px] text-[#ECEAE4] focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-[#5A6268]"
                />
              </div>
              <p className="mt-2 text-[11px] text-[#5A6268]">
                Each recipient gets a 7-day signed download link per render.
              </p>
            </div>
          )}

          {deliveryMethod === 'library_only' && (
            <div className="px-4 py-2.5 border-b border-white/5">
              <p className="text-[11px] text-[#5A6268] leading-[1.5] pl-1">
                Note: videos will appear in your Run History only — nothing is published or emailed. You can still download them from there.
              </p>
            </div>
          )}

          {/* ── Terms acknowledgement ── */}
          <div className="px-4 py-3.5">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <Checkbox
                checked={termsAgreed}
                onCheckedChange={(v) => setTermsAgreed(v === true)}
                className="mt-0.5 border-[#14C8CC]/40 data-[state=checked]:bg-[#14C8CC] data-[state=checked]:text-[#0A0D0F]"
              />
              <span className="text-[12px] leading-[1.5] text-[#ECEAE4]">
                I agree to the terms — credits will be deducted for each scheduled run, and posts will go out
                automatically once topics are queued.
              </span>
            </label>
          </div>
        </div>
      )}
    </Card>
  );
}
