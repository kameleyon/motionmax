import { useMemo } from 'react';
import { Play, Pause, SkipBack, SkipForward, Lock } from 'lucide-react';
import type { EditorScene, EditorState } from '@/hooks/useEditorState';
import { useActiveJobs } from './useActiveJobs';

/** Multi-track timeline. Scene N's clip width is canonical:
 *  duration = audioDurationMs (narration) when known, else estDurationMs.
 *  Video + Voice + Captions tracks all honor this width.
 *  Music track (if intake.music.on) is one full-width chip.
 *  SFX track (if intake.music.sfx) is per-scene small chips.
 *
 *  V1 is read-only except click-to-select-scene. Trim + drag +
 *  zoom live in a later phase. */

function formatMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function sceneDurationMs(scene: EditorScene): number {
  return scene.audioDurationMs ?? scene.estDurationMs ?? 10_000;
}

export default function Timeline({
  state,
  selectedSceneIndex,
  onSelectScene,
  onSelectVoice,
  playing,
  onPlayToggle,
  generationFullyReady = true,
}: {
  state: EditorState;
  selectedSceneIndex: number;
  onSelectScene: (index: number) => void;
  /** Called when the user clicks a VOICE track clip. The editor page
   *  uses this to both select the scene AND focus the Inspector's
   *  Voice tab, so one click puts the user right at Regenerate voice. */
  onSelectVoice?: (index: number) => void;
  playing: boolean;
  onPlayToggle: () => void;
  /** When false, Play + Prev/Next + track clicks are disabled. Set by
   *  Editor.tsx when any scene is still missing its required assets
   *  (imageUrl + audioUrl + optional videoUrl for cinematic). */
  generationFullyReady?: boolean;
}) {
  const { tasksForScene, bulkOpActive, bulkOpKind } = useActiveJobs(state.project?.id ?? null);
  const bulkOpLabel =
    bulkOpKind === 'export'
      ? 'Exporting full video'
      : bulkOpKind === 'captions-apply'
        ? 'Burning captions across all scenes'
        : bulkOpKind === 'voice-apply-all'
          ? 'Re-rendering every voiceover'
          : bulkOpKind === 'motion-apply-all'
            ? 'Applying motion to every scene'
            : 'Project re-rendering';
  const totalMs = useMemo(() => {
    if (state.totalDurationMs > 0) return state.totalDurationMs;
    // Fallback: approximate from scene count while still rendering.
    return Math.max(10_000, state.scenes.length * 10_000);
  }, [state.totalDurationMs, state.scenes.length]);

  // Cumulative offset for each scene.
  const sceneOffsets = useMemo(() => {
    let acc = 0;
    return state.scenes.map((s) => {
      const start = acc;
      acc += sceneDurationMs(s);
      return start;
    });
  }, [state.scenes]);

  // Preserved for when the music/SFX UI is re-enabled — currently
  // disabled while Lyria is unreliable. Void-ref prevents the lint
  // unused-var warning without deleting the derivations.
  const hasMusic = !!state.intake.music?.on;
  const hasSfx = !!state.intake.music?.sfx;
  void hasMusic; void hasSfx;
  const hasCaptions = state.intake.captionStyle && state.intake.captionStyle !== 'none';

  // Give every scene at least ~110 px on the timeline. A 15-scene
  // project at 100% width would cram each clip into 6% of the track
  // (~24 px on mobile) — thumbnails and titles are unreadable there.
  // Setting a pixel-based min-width and scrolling horizontally lets
  // the whole timeline breathe; the ruler + every track sit on the
  // same scrolled rail so they stay aligned.
  const MIN_PX_PER_SCENE = 110;
  const tracksMinPx = Math.max(state.scenes.length * MIN_PX_PER_SCENE, 600);

  return (
    <div className="h-full flex flex-col text-[#ECEAE4]">
      {/* Transport */}
      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-white/5 bg-[#10151A]">
        <button
          type="button"
          title={!generationFullyReady ? 'Waiting for all scenes to finish rendering' : 'Previous scene'}
          aria-label="Previous scene"
          disabled={selectedSceneIndex <= 0 || !generationFullyReady}
          onClick={() => onSelectScene(Math.max(0, selectedSceneIndex - 1))}
          className="w-7 h-7 grid place-items-center rounded-md text-[#8A9198] hover:bg-[#1B2228] hover:text-[#ECEAE4] disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <SkipBack className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onPlayToggle}
          disabled={state.phase !== 'ready' || !generationFullyReady}
          title={!generationFullyReady ? 'Waiting for all scenes to finish rendering' : (playing ? 'Pause' : 'Play')}
          aria-label={playing ? 'Pause' : 'Play'}
          className="w-9 h-9 grid place-items-center rounded-full bg-[#ECEAE4] text-[#0A0D0F] hover:brightness-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {playing ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
        </button>
        <button
          type="button"
          title={!generationFullyReady ? 'Waiting for all scenes to finish rendering' : 'Next scene'}
          aria-label="Next scene"
          disabled={selectedSceneIndex >= state.scenes.length - 1 || !generationFullyReady}
          onClick={() => onSelectScene(Math.min(state.scenes.length - 1, selectedSceneIndex + 1))}
          className="w-7 h-7 grid place-items-center rounded-md text-[#8A9198] hover:bg-[#1B2228] hover:text-[#ECEAE4] disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <SkipForward className="w-3.5 h-3.5" />
        </button>

        <div className="font-mono text-[12px] text-[#ECEAE4] tracking-[0.06em] ml-1">
          {formatMs(sceneOffsets[selectedSceneIndex] ?? 0)}
          <span className="text-[#5A6268]"> / {formatMs(totalMs)}</span>
        </div>

        {bulkOpActive && (
          <span className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md font-mono text-[10px] tracking-[0.1em] uppercase border border-[#14C8CC]/30 text-[#14C8CC] bg-[#14C8CC]/10 truncate">
            <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC] animate-pulse" />
            {bulkOpLabel}
          </span>
        )}
      </div>

      {/* Ruler + Tracks — share one horizontal scroll container so the
          ruler ticks stay aligned with clip offsets as the user
          scrolls. The track-label gutter on the left is OUTSIDE the
          scrolling strip (flex parent below) so labels stay pinned. */}
      <div className="flex-1 min-h-0 flex">
        {/* Pinned label gutter (narrower than before so the track rail
            gets more pixels). Kept in sync with the heights below. */}
        <div className="w-[40px] shrink-0 bg-[#10151A] border-r border-white/5 flex flex-col">
          {/* Spacer above — matches ruler height so labels line up with tracks. */}
          <div className="h-4 border-b border-white/5" />
          <div className="flex-1 overflow-hidden py-2 flex flex-col gap-1.5">
            <TrackLabel>VIDEO</TrackLabel>
            <TrackLabel>VOICE</TrackLabel>
            <TrackLabel dim={!hasCaptions}>CAPTIONS</TrackLabel>
            {/* MUSIC + SFX labels hidden while the feature is paused.
                Re-enable alongside the matching TrackRail rows below.
                <TrackLabel dim={!hasMusic}>MUSIC</TrackLabel>
                <TrackLabel dim={!hasSfx}>SFX</TrackLabel> */}
          </div>
        </div>

        {/* Scrolling strip. `minWidth` = scenes × MIN_PX_PER_SCENE so
            long projects scroll instead of cramming. The ruler and
            every track live INSIDE this container at 100% width of
            that wider strip, which is how their percentage-based
            offsets stay aligned. */}
        <div className="flex-1 overflow-x-auto overflow-y-auto">
          <div style={{ minWidth: tracksMinPx }}>
            {/* Ruler */}
            <div className="relative h-4 bg-[#10151A] border-b border-white/5 font-mono text-[9px] text-[#5A6268] tracking-[0.08em]">
              {[0, 20, 40, 60, 80, 100].map((p) => (
                <span key={p} className="absolute top-0.5" style={{ left: `calc(${p}% + 4px)` }}>
                  {formatMs((totalMs * p) / 100)}
                </span>
              ))}
            </div>

            {/* Tracks (no per-track label column here — labels are pinned
                in the gutter to the left). */}
            <div className="px-2 py-2 flex flex-col gap-1.5 min-h-0">
              {/* VIDEO track — each clip uses its scene imageUrl as a
                  cover background so the user can see the actual scene
                  at a glance (like a real NLE). Locked styling + stripe
                  overlay still apply when a regen is in flight. */}
              <TrackRail>
                {state.scenes.map((scene, i) => {
                  const offsetPct = (sceneOffsets[i] / totalMs) * 100;
                  const widthPct = (sceneDurationMs(scene) / totalMs) * 100;
                  const isActive = i === selectedSceneIndex;
                  const sceneTasks = tasksForScene(i);
                  // Per-scene lock OR project-wide bulk lock — the
                  // latter freezes EVERY clip during export / voice
                  // apply-all / captions apply-all so the user can't
                  // queue an edit on top of an in-flight global rebuild.
                  const locked =
                    bulkOpActive ||
                    sceneTasks.has('regenerate_image') ||
                    sceneTasks.has('cinematic_image') ||
                    sceneTasks.has('cinematic_video');
                  const thumbUrl = scene.imageUrl || scene.imageUrls?.[0] || null;
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={locked}
                      onClick={() => onSelectScene(i)}
                      title={locked ? 'Scene is regenerating — locked' : (scene.title || `Scene ${i + 1}`)}
                      className={
                        'absolute top-0 bottom-0 rounded-md border transition-colors overflow-hidden flex items-end ' +
                        (locked
                          ? 'border-[#14C8CC] cursor-not-allowed'
                          : isActive
                            ? 'border-[#14C8CC] shadow-[0_0_0_1px_#14C8CC_inset]'
                            : 'border-[#14C8CC]/30 hover:border-[#14C8CC]/70')
                      }
                      style={{
                        left: `${offsetPct}%`,
                        width: `${widthPct}%`,
                        backgroundImage: thumbUrl ? `url(${thumbUrl})` : undefined,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        backgroundColor: thumbUrl ? '#050709' : '#14C8CC22',
                      }}
                    >
                      {/* Dark gradient so the bottom label stays legible
                          on top of the thumbnail. */}
                      <span
                        className="absolute inset-0 pointer-events-none"
                        style={{
                          background:
                            'linear-gradient(to top, rgba(0,0,0,.75) 0%, rgba(0,0,0,.15) 45%, transparent 75%)',
                        }}
                      />
                      {locked && (
                        <span
                          className="absolute inset-0 pointer-events-none rounded-md"
                          style={{
                            background:
                              'repeating-linear-gradient(135deg, rgba(20,200,204,.28) 0 8px, transparent 8px 16px)',
                          }}
                        />
                      )}
                      {/* Active-scene overlay tint keeps the selection
                          cue on top of the photo. */}
                      {isActive && !locked && (
                        <span className="absolute inset-0 pointer-events-none rounded-md bg-[#14C8CC]/18" />
                      )}
                      <span className="relative w-full px-1.5 py-0.5 font-mono text-[9.5px] tracking-wider text-white whitespace-nowrap overflow-hidden text-ellipsis flex items-center gap-1">
                        {locked && <Lock className="w-2.5 h-2.5 shrink-0" />}
                        {String(i + 1).padStart(2, '0')} · {scene.title || scene.visualPrompt?.slice(0, 30) || ''}
                      </span>
                    </button>
                  );
                })}
              </TrackRail>

              {/* VOICE track */}
              <TrackRail>
                {state.scenes.map((scene, i) => {
                  const offsetPct = (sceneOffsets[i] / totalMs) * 100;
                  const widthPct = (sceneDurationMs(scene) / totalMs) * 100;
                  const peaks = scene.waveformPeaks ?? Array.from({ length: 40 }, (_, k) =>
                    20 + Math.abs(Math.sin((k + i * 3) * 0.31) + Math.cos((k + i * 2) * 0.77) * 0.6) * 60,
                  );
                  const isActive = i === selectedSceneIndex;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => (onSelectVoice ?? onSelectScene)(i)}
                      title={`Scene ${i + 1} · click to edit voice`}
                      aria-label={`Scene ${i + 1} voice — click to regenerate`}
                      className={
                        'absolute top-[3px] bottom-[3px] flex items-center gap-[1px] rounded-[3px] border transition-colors ' +
                        (isActive
                          ? 'border-[#14C8CC] bg-[#14C8CC]/10'
                          : 'border-transparent hover:border-[#14C8CC]/40 hover:bg-[#14C8CC]/5')
                      }
                      style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
                    >
                      {peaks.slice(0, 40).map((h, k) => (
                        <span
                          key={k}
                          className={`flex-1 rounded-[1px] ${isActive ? 'bg-[#14C8CC]' : 'bg-[#14C8CC]/55'}`}
                          style={{ height: `${Math.min(100, Math.max(8, h))}%` }}
                        />
                      ))}
                    </button>
                  );
                })}
              </TrackRail>

              {/* CAPTIONS track */}
              <TrackRail>
                {hasCaptions ? (
                  state.scenes.map((scene, i) => {
                    const offsetPct = (sceneOffsets[i] / totalMs) * 100;
                    const widthPct = (sceneDurationMs(scene) / totalMs) * 100;
                    const text = scene.voiceover?.slice(0, 40) ?? '';
                    return (
                      <div
                        key={i}
                        className="absolute top-[4px] bottom-[4px] bg-white/[0.06] border border-white/10 rounded-[3px] px-1.5 flex items-center overflow-hidden"
                        style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
                      >
                        <span className="font-serif italic text-[9.5px] text-[#8A9198] whitespace-nowrap overflow-hidden text-ellipsis">
                          {text}
                        </span>
                      </div>
                    );
                  })
                ) : (
                  <div className="absolute inset-0 grid place-items-center font-mono text-[9.5px] text-[#5A6268] tracking-wider">
                    Captions off · turn on in intake to see chips here
                  </div>
                )}
              </TrackRail>

              {/* MUSIC + SFX tracks — temporarily disabled while Lyria
                  generation is unreliable. Intake form no longer lets
                  users opt in; worker forces the block off. Leaving the
                  code preserved below so we can re-enable when Lyria
                  is stable by uncommenting and removing the null
                  renders. */}
              {null}
              {null}
              {/*
              <TrackRail>
                {hasMusic ? (
                  <div
                    className="absolute top-[4px] bottom-[4px] left-0 right-0 rounded-[3px] flex items-center px-2"
                    style={{
                      background: 'linear-gradient(90deg, rgba(197,147,255,.3), rgba(197,147,255,.18))',
                      border: '1px solid rgba(197,147,255,.3)',
                    }}
                  >
                    <span className="font-mono text-[9.5px] text-white/80 tracking-wider uppercase">
                      {state.intake.music?.genre ?? 'Lyria'} · {(() => {
                        const url = (state.generation as { music_url?: string | null } | null)?.music_url;
                        if (url) return 'Ready';
                        if (state.phase === 'ready') return 'Failed';
                        if (state.phase === 'error') return 'Failed';
                        return 'Generating…';
                      })()}
                    </span>
                  </div>
                ) : (
                  <div className="absolute inset-0 grid place-items-center font-mono text-[9.5px] text-[#5A6268] tracking-wider">
                    Music off
                  </div>
                )}
              </TrackRail>

              <TrackRail>
                {hasSfx ? (
                  <div
                    className="absolute top-[4px] bottom-[4px] left-0 right-0 rounded-[3px] flex items-center px-2"
                    style={{
                      background: 'linear-gradient(90deg, rgba(120,210,180,.26), rgba(120,210,180,.14))',
                      border: '1px solid rgba(120,210,180,.3)',
                    }}
                  >
                    <span className="font-mono text-[9.5px] text-white/80 tracking-wider uppercase">
                      Ambient · {(() => {
                        const url = (state.generation as { sfx_url?: string | null } | null)?.sfx_url;
                        if (url) return 'Ready';
                        if (state.phase === 'ready') return 'Failed';
                        if (state.phase === 'error') return 'Failed';
                        return 'Generating…';
                      })()}
                    </span>
                  </div>
                ) : (
                  <div className="absolute inset-0 grid place-items-center font-mono text-[9.5px] text-[#5A6268] tracking-wider">
                    SFX off
                  </div>
                )}
              </TrackRail>
              */}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Pinned left-gutter label. Stays in place while the track rails
 *  scroll horizontally on their own axis. */
function TrackLabel({ children, dim }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <div
      className={`h-[30px] flex items-center justify-end pr-2 font-mono text-[9.5px] tracking-[0.14em] uppercase ${dim ? 'text-[#5A6268]/60' : 'text-[#5A6268]'}`}
    >
      {children}
    </div>
  );
}

/** Absolute-positioned content rail — the thing clips sit inside.
 *  Matches the pinned label gutter's 30 px row height. */
function TrackRail({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-[30px] bg-[#151B20] border border-white/5 rounded-md relative overflow-hidden">
      {children}
    </div>
  );
}
