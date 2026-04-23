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
}) {
  const { tasksForScene } = useActiveJobs(state.project?.id ?? null);
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

  const hasMusic = !!state.intake.music?.on;
  const hasSfx = !!state.intake.music?.sfx;
  const hasCaptions = state.intake.captionStyle && state.intake.captionStyle !== 'none';

  return (
    <div className="h-full flex flex-col text-[#ECEAE4]">
      {/* Transport */}
      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-white/5 bg-[#10151A]">
        <button
          type="button"
          title="Previous scene"
          aria-label="Previous scene"
          disabled={selectedSceneIndex <= 0}
          onClick={() => onSelectScene(Math.max(0, selectedSceneIndex - 1))}
          className="w-7 h-7 grid place-items-center rounded-md text-[#8A9198] hover:bg-[#1B2228] hover:text-[#ECEAE4] disabled:opacity-30"
        >
          <SkipBack className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onPlayToggle}
          disabled={state.phase !== 'ready'}
          title={playing ? 'Pause' : 'Play'}
          aria-label={playing ? 'Pause' : 'Play'}
          className="w-9 h-9 grid place-items-center rounded-full bg-[#ECEAE4] text-[#0A0D0F] hover:brightness-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {playing ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
        </button>
        <button
          type="button"
          title="Next scene"
          aria-label="Next scene"
          disabled={selectedSceneIndex >= state.scenes.length - 1}
          onClick={() => onSelectScene(Math.min(state.scenes.length - 1, selectedSceneIndex + 1))}
          className="w-7 h-7 grid place-items-center rounded-md text-[#8A9198] hover:bg-[#1B2228] hover:text-[#ECEAE4] disabled:opacity-30"
        >
          <SkipForward className="w-3.5 h-3.5" />
        </button>

        <div className="font-mono text-[12px] text-[#ECEAE4] tracking-[0.06em] ml-1">
          {formatMs(sceneOffsets[selectedSceneIndex] ?? 0)}
          <span className="text-[#5A6268]"> / {formatMs(totalMs)}</span>
        </div>
      </div>

      {/* Ruler */}
      <div className="relative px-[58px] h-4 bg-[#10151A] border-b border-white/5 font-mono text-[9px] text-[#5A6268] tracking-[0.08em]">
        {[0, 20, 40, 60, 80, 100].map((p) => (
          <span key={p} className="absolute top-0.5" style={{ left: `calc(${p}% + 4px)` }}>
            {formatMs((totalMs * p) / 100)}
          </span>
        ))}
      </div>

      {/* Tracks */}
      <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-1.5 min-h-0">
        {/* VIDEO track — clip is LOCKED (disabled + stripe overlay)
            while its scene has an in-flight image/video regen. Stops
            the user from layering a second edit on top of a
            pending worker write-back. */}
        <Track label="VIDEO">
          {state.scenes.map((scene, i) => {
            const offsetPct = (sceneOffsets[i] / totalMs) * 100;
            const widthPct = (sceneDurationMs(scene) / totalMs) * 100;
            const isActive = i === selectedSceneIndex;
            const sceneTasks = tasksForScene(i);
            const locked =
              sceneTasks.has('regenerate_image') ||
              sceneTasks.has('cinematic_image') ||
              sceneTasks.has('cinematic_video');
            return (
              <button
                key={i}
                type="button"
                disabled={locked}
                onClick={() => onSelectScene(i)}
                title={locked ? 'Scene is regenerating — locked' : undefined}
                className={
                  'absolute top-0 bottom-0 rounded-md border transition-colors overflow-hidden flex items-center px-2 ' +
                  (locked
                    ? 'border-[#14C8CC] bg-[#14C8CC]/10 cursor-not-allowed'
                    : isActive
                      ? 'border-[#14C8CC] bg-gradient-to-b from-[#14C8CC]/55 to-[#14C8CC]/30 shadow-[0_0_0_1px_#14C8CC_inset]'
                      : 'border-[#14C8CC]/30 bg-gradient-to-b from-[#14C8CC]/28 to-[#14C8CC]/14 hover:border-[#14C8CC]/50')
                }
                style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
              >
                {locked && (
                  <span
                    className="absolute inset-0 pointer-events-none rounded-md"
                    style={{
                      background:
                        'repeating-linear-gradient(135deg, rgba(20,200,204,.18) 0 8px, transparent 8px 16px)',
                    }}
                  />
                )}
                <span className="font-mono text-[9.5px] tracking-wider text-white whitespace-nowrap overflow-hidden text-ellipsis flex items-center gap-1 relative">
                  {locked && <Lock className="w-2.5 h-2.5" />}
                  {String(i + 1).padStart(2, '0')} · {scene.title || scene.visualPrompt?.slice(0, 30) || ''}
                </span>
              </button>
            );
          })}
        </Track>

        {/* VOICE track — per-scene buttons. Clicking a voice clip
            selects that scene and drops the user into the Inspector's
            Voice tab so they can regenerate. Real waveform peaks render
            when scene._meta.waveformPeaks is populated by finalize;
            otherwise a stable sine-proxy stands in so the track isn't
            empty. Each clip has a scene-index seed so the sine pattern
            differs visually between scenes. */}
        <Track label="VOICE">
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
        </Track>

        {/* CAPTIONS track */}
        <Track label="CAPTIONS" dim={!hasCaptions}>
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
        </Track>

        {/* MUSIC track — single chip spanning whole duration if on */}
        <Track label="MUSIC" dim={!hasMusic}>
          {hasMusic ? (
            <div
              className="absolute top-[4px] bottom-[4px] left-0 right-0 rounded-[3px] flex items-center px-2"
              style={{
                background: 'linear-gradient(90deg, rgba(197,147,255,.3), rgba(197,147,255,.18))',
                border: '1px solid rgba(197,147,255,.3)',
              }}
            >
              <span className="font-mono text-[9.5px] text-white/80 tracking-wider uppercase">
                {state.intake.music?.genre ?? 'Lyria'} · {state.generation?.music_url ? 'Ready' : 'Generating…'}
              </span>
            </div>
          ) : (
            <div className="absolute inset-0 grid place-items-center font-mono text-[9.5px] text-[#5A6268] tracking-wider">
              Music off
            </div>
          )}
        </Track>

        {/* SFX track */}
        <Track label="SFX" dim={!hasSfx}>
          {hasSfx ? (
            state.scenes.map((scene, i) => {
              const offsetPct = (sceneOffsets[i] / totalMs) * 100 + 4;
              const widthPct = Math.min(18, (sceneDurationMs(scene) / totalMs) * 40);
              return (
                <div
                  key={i}
                  className="absolute top-[6px] bottom-[6px] bg-white/10 border border-white/[0.18] rounded-[3px] flex items-center px-1.5"
                  style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
                >
                  <span className="font-mono text-[9px] text-[#8A9198] tracking-wider">
                    sfx
                  </span>
                </div>
              );
            })
          ) : (
            <div className="absolute inset-0 grid place-items-center font-mono text-[9.5px] text-[#5A6268] tracking-wider">
              SFX off
            </div>
          )}
        </Track>
      </div>
    </div>
  );
}

function Track({
  label,
  dim,
  children,
}: {
  label: string;
  dim?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 min-h-[30px]">
      <div
        className={`w-[48px] shrink-0 text-right font-mono text-[9.5px] tracking-[0.14em] uppercase ${dim ? 'text-[#5A6268]/60' : 'text-[#5A6268]'}`}
      >
        {label}
      </div>
      <div className="flex-1 h-[30px] bg-[#151B20] border border-white/5 rounded-md relative overflow-hidden">
        {children}
      </div>
    </div>
  );
}
