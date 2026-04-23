import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { EditorState, EditorScene } from '@/hooks/useEditorState';
import { useActiveJobs } from './useActiveJobs';

/** The center stage. Three render modes driven by phase:
 *    rendering — progress ring + rotating status message, on top of
 *                the most-recently-completed scene as a teaser.
 *    ready     — HTML5 video player for the selected scene (or scene 0
 *                if none selected).
 *    editing   — same as ready with edit affordances (Phase 5 full).
 *  Aspect ratio always follows `state.aspect`. */

const PROGRESS_MESSAGES: Array<[number, string]> = [
  [0,  'Warming up the pipeline…'],
  [10, 'Drafting shot list from your script…'],
  [25, 'Generating scenes…'],
  [41, 'Voicing narration…'],
  [66, 'Rendering video with Kling V3.0 Pro…'],
  [86, 'Aligning lip-sync keyframes…'],
  [93, 'Final color grade…'],
  [99, 'Encoding…'],
];

function messageForProgress(pct: number): string {
  let msg = PROGRESS_MESSAGES[0][1];
  for (const [threshold, text] of PROGRESS_MESSAGES) {
    if (pct >= threshold) msg = text;
  }
  return msg;
}

function formatElapsed(startedAt: string | null): string {
  if (!startedAt) return '00:00:00';
  const ms = Date.now() - new Date(startedAt).getTime();
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600).toString().padStart(2, '0');
  const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function LoadingRing({ size = 72 }: { size?: number }) {
  return (
    <svg viewBox="0 0 50 50" width={size} height={size} aria-hidden="true">
      <circle cx="25" cy="25" r="20" fill="none" stroke="rgba(20,200,204,.12)" strokeWidth="3" />
      <circle
        cx="25" cy="25" r="20" fill="none"
        stroke="url(#sg)" strokeWidth="3" strokeLinecap="round" strokeDasharray="50 200"
        transform="rotate(-90 25 25)"
      >
        <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1.2s" repeatCount="indefinite" />
      </circle>
      <defs>
        <linearGradient id="sg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#14C8CC" />
          <stop offset="100%" stopColor="#0FA6AE" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export default function Stage({
  state,
  selectedSceneIndex,
  onAdvanceScene,
  playing,
  onPlayingChange,
  fullscreen = false,
  onFullscreenChange,
}: {
  state: EditorState;
  selectedSceneIndex: number;
  /** Called when the user taps/clicks the frame — used on mobile to
   *  walk through scenes without a visible scene list. */
  onAdvanceScene?: () => void;
  /** Timeline-driven play state. When this flips, Stage synchronises
   *  its <video> element via play()/pause(). */
  playing?: boolean;
  /** Report intrinsic video events (ended, user-pause, user-play) back
   *  to the parent so the Timeline button stays in sync. */
  onPlayingChange?: (p: boolean) => void;
  /** Fullscreen is owned by EditorFrame (so it can hide topbar /
   *  scenes / inspector / timeline) — Stage just reflects + toggles
   *  the flag. When true, Stage hides its own chrome (aspect chip,
   *  quality chip, REC, AI disclaimer) and lets the frame fill the
   *  viewport. */
  fullscreen?: boolean;
  onFullscreenChange?: (v: boolean) => void;
}) {
  const [, tick] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Caption preview — derived from narration + audio.currentTime.
  // Chunks the voiceover into N word-windows and shows the one that
  // corresponds to the current audio time. This is CLIENT-SIDE only
  // (not burned into the video); gives users a live preview of what
  // the export will look like without waiting on a re-render.
  const [captionText, setCaptionText] = useState<string>('');
  const { tasksForScene } = useActiveJobs(state.project?.id ?? null);
  const activeTasks = tasksForScene(selectedSceneIndex);
  const imageActive = activeTasks.has('regenerate_image') || activeTasks.has('cinematic_image');
  const videoActive = activeTasks.has('cinematic_video');
  const sceneActive = imageActive || videoActive;
  const regenLabel = imageActive && videoActive
    ? 'Rendering new image + video…'
    : imageActive
      ? 'Generating new image…'
      : videoActive
        ? 'Rendering new video…'
        : '';
  // The TTS narration lives on scene.audioUrl — not baked into the
  // Kling video clip (Kling is rendered with sound=false). We attach a
  // parallel <audio> element that plays in sync with the video; the
  // narration's end event drives scene auto-advance so the composite
  // "scene duration" = audio duration, matching the timeline widths.
  const audioRef = useRef<HTMLAudioElement>(null);
  // Fullscreen state is OWNED by EditorFrame so the frame can hide its
  // own chrome (topbar, sidebar, scenes, inspector, timeline) when the
  // stage goes fullscreen. Stage just reflects + toggles it via the
  // `fullscreen` / `onFullscreenChange` props. The native Fullscreen
  // API path is no longer used — too inconsistent across iOS Safari /
  // PWA installs — we always do the CSS-driven app-level fullscreen.
  const isFullscreen = fullscreen;
  const setFullscreen = (v: boolean) => onFullscreenChange?.(v);
  const toggleFullscreen = () => setFullscreen(!isFullscreen);

  // REC timecode ticks while rendering.
  useEffect(() => {
    if (state.phase !== 'rendering') return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [state.phase]);

  // ESC exits app-level fullscreen.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullscreen]);

  // Caption sync — splits the current scene's voiceover into fixed
  // word-windows and picks the one matching audio.currentTime. Fires
  // on every timeupdate, so the overlay swaps phrases in sync with
  // narration. No caption if the style is 'none' or narration empty.
  useEffect(() => {
    const audio = audioRef.current;
    const scene = state.scenes[selectedSceneIndex];
    const captionsOn = state.intake.captionStyle && state.intake.captionStyle !== 'none';
    if (!audio || !scene?.voiceover || !captionsOn) {
      setCaptionText('');
      return;
    }
    const words = scene.voiceover.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) { setCaptionText(''); return; }

    // 3-word chunks — matches typical caption-style pacing and keeps
    // the overlay readable on mobile. If audioDuration is known we
    // distribute windows across it; else we fall back to ~0.45s/word.
    const chunkSize = 3;
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += chunkSize) {
      chunks.push(words.slice(i, i + chunkSize).join(' '));
    }

    const onTime = () => {
      const dur = audio.duration || (scene.audioDurationMs ?? 0) / 1000 || words.length * 0.45;
      if (!Number.isFinite(dur) || dur <= 0) { setCaptionText(''); return; }
      const ratio = Math.min(1, Math.max(0, audio.currentTime / dur));
      const idx = Math.min(chunks.length - 1, Math.floor(ratio * chunks.length));
      setCaptionText(chunks[idx] ?? '');
    };
    const onPause = () => { /* keep text visible on pause */ };
    const onReset = () => setCaptionText('');

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('seeked', onTime);
    audio.addEventListener('ended', onReset);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('seeked', onTime);
      audio.removeEventListener('ended', onReset);
      audio.removeEventListener('pause', onPause);
    };
  }, [selectedSceneIndex, state.scenes, state.intake.captionStyle]);

  // ── Scene-change priming. Runs whenever the selected scene changes,
  // regardless of playing state. This is what gives the preview a
  // visible first frame before the user ever clicks Play — if we only
  // assigned `video.src` inside the play branch, the <video> element
  // would render empty-and-black on mount until playback started.
  useEffect(() => {
    const scene = state.scenes[selectedSceneIndex];
    if (!scene) return;
    const video = videoRef.current;
    const audio = audioRef.current;

    if (video && scene.videoUrl) {
      video.muted = true;
      video.playsInline = true;
      if (video.src !== scene.videoUrl) {
        video.src = scene.videoUrl;
        video.load();
      }
      video.currentTime = 0;
    }

    if (audio) {
      if (scene.audioUrl) {
        if (audio.src !== scene.audioUrl) {
          audio.src = scene.audioUrl;
          audio.load();
        }
        audio.currentTime = 0;
      } else {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
    }
  }, [selectedSceneIndex, state.scenes]);

  // ── Play/pause + end-of-scene handling. Ported from PublicShare's
  // share-page player (which plays every scene end-to-end non-stop).
  // Scene priming happens in the effect above — this one only flips
  // play/pause and wires up the end listeners that drive scene advance.
  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video) return;

    if (!playing) {
      video.pause();
      audio?.pause();
      return;
    }

    const scene = state.scenes[selectedSceneIndex];
    if (!scene) return;

    const handleEnded = () => {
      if (selectedSceneIndex < state.scenes.length - 1) {
        onAdvanceScene?.();
      } else {
        onPlayingChange?.(false);
      }
    };

    // When the video itself ends but audio is still playing, loop the
    // visual so the frame doesn't freeze black while narration finishes.
    const handleVideoEndedInner = () => {
      if (audio && scene.audioUrl && !audio.ended) {
        video.currentTime = 0;
        const vp = video.play();
        if (vp && typeof vp.catch === 'function') vp.catch(() => {});
        return;
      }
      handleEnded();
    };

    // Prefer audio as the "end of scene" signal when narration exists
    // (it's the canonical scene length). Fall back to video end.
    const useAudioAsBoundary = !!(audio && scene.audioUrl);
    if (useAudioAsBoundary) audio.addEventListener('ended', handleEnded);
    video.addEventListener('ended', handleVideoEndedInner);

    (async () => {
      try {
        const p = video.play();
        if (p) await p;
        if (audio && scene.audioUrl) {
          const ap = audio.play();
          if (ap) await ap;
        }
      } catch {
        // Autoplay blocked — user needs a gesture. Reset external state.
        onPlayingChange?.(false);
      }
    })();

    return () => {
      if (useAudioAsBoundary) audio.removeEventListener('ended', handleEnded);
      video.removeEventListener('ended', handleVideoEndedInner);
      video.pause();
      audio?.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, selectedSceneIndex, state.scenes]);

  const aspectCss = state.aspect === '16:9' ? '16/9' : '9/16';
  // 9:16 used to cap at 48% width — sized for desktop where the
  // scenes column ate half the stage. On mobile the column is hidden,
  // so that cap left the preview tiny. Let height be the binding
  // constraint: `auto` width + maxHeight lets the browser compute
  // width from the aspect ratio and available vertical space, which
  // is what actually produces a true 9:16 looking frame on phones.
  // Fullscreen blows the cap out: 100% w + 100% h with object-contain
  // on the inner image/video means the preview owns the entire viewport.
  // Shrink portrait frame's maxHeight a touch so the AI disclaimer at
  // the bottom always has clear vertical space beneath it — was
  // overlapping on short mobile viewports.
  const frameMaxW = isFullscreen ? '100%' : (state.aspect === '16:9' ? '92%' : '94%');
  const frameMaxH = isFullscreen ? '100%' : (state.aspect === '16:9' ? '86%' : '84%');
  const frameW    = isFullscreen ? '100%' : (state.aspect === '16:9' ? '82%' : 'auto');
  const frameH    = isFullscreen ? '100%' : (state.aspect === '16:9' ? 'auto' : '84%');

  const sceneToShow: EditorScene | undefined =
    state.scenes[selectedSceneIndex] ??
    // While rendering, show the latest scene with a visible asset.
    state.scenes.slice().reverse().find((s) => s.videoUrl || s.imageUrl) ??
    state.scenes[0];

  return (
    <div
      ref={stageRef}
      className="relative grid place-items-center overflow-hidden h-full w-full"
      style={{
        background:
          'radial-gradient(80% 100% at 50% 50%, rgba(20,200,204,.04), transparent 65%), ' +
          (isFullscreen ? '#000' : '#050709'),
      }}
    >
      {/* Subtle grid (hidden in fullscreen for cinema feel). */}
      {!isFullscreen && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: 'radial-gradient(rgba(255,255,255,.035) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
        />
      )}

      {/* Aspect chip — hidden in fullscreen so the frame owns the screen. */}
      {!isFullscreen && (
        <div className="absolute top-3 left-3 z-[4] p-[3px] bg-[#10151A]/80 border border-white/5 rounded-lg backdrop-blur-sm font-mono text-[10px] tracking-[0.08em]">
          <span className="px-2.5 py-1 rounded bg-[#1B2228] text-[#ECEAE4]">
            {state.aspect}
          </span>
        </div>
      )}

      {/* Quality + fullscreen — quality pill hidden in fullscreen,
          but the Exit button stays so the user can leave. */}
      <div className="absolute top-3 right-3 z-[9999] flex gap-1.5">
        {!isFullscreen && (
          <span className="font-mono text-[10px] tracking-[0.1em] text-[#8A9198] px-2 py-1 bg-[#10151A]/80 border border-white/5 rounded-md backdrop-blur-sm">
            1080p · 24fps
          </span>
        )}
        <button
          type="button"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label="Toggle fullscreen"
          className={
            isFullscreen
              ? 'inline-flex items-center gap-1.5 px-2.5 h-8 bg-[#10151A]/80 border border-white/15 rounded-md text-[#ECEAE4] hover:bg-[#1B2228] backdrop-blur-sm font-mono text-[10.5px] tracking-[0.12em] uppercase'
              : 'w-7 h-7 grid place-items-center bg-[#10151A]/80 border border-white/5 rounded-md text-[#8A9198] hover:text-[#ECEAE4]'
          }
        >
          {isFullscreen ? (
            <>
              <Minimize2 className="w-3.5 h-3.5" />
              Exit
            </>
          ) : (
            <Maximize2 className="w-3.5 h-3.5" />
          )}
        </button>
      </div>

      {/* Frame. Clicking the frame advances to the next scene — this
          is the primary navigation gesture on mobile (where we hide
          the scenes column entirely). */}
      <div
        className="relative rounded-md overflow-hidden"
        style={{
          width: frameW,
          height: frameH,
          aspectRatio: aspectCss,
          maxWidth: frameMaxW,
          maxHeight: frameMaxH,
          background: sceneToShow?.imageUrl ? '#050709' : '#0a0d10',
          boxShadow: '0 40px 120px -40px rgba(0,0,0,.8), 0 0 0 1px rgba(255,255,255,.06)',
          transition: 'aspect-ratio .3s ease, width .3s ease, height .3s ease',
          cursor: state.phase === 'ready' && onAdvanceScene ? 'pointer' : 'default',
        }}
        onClick={(e) => {
          // Let the native <video> controls handle their own clicks.
          if ((e.target as HTMLElement).tagName === 'VIDEO') return;
          if (state.phase === 'ready' && onAdvanceScene) onAdvanceScene();
        }}
      >
        {/* Preview: video if ready, else latest image. Video is MUTED
            and has no native controls — we drive playback from the
            Timeline transport so video + narration stay in lockstep.
            src is set imperatively in the scene-change effect so these
            elements persist (same MediaElement keeps its autoplay
            authorisation across scenes). */}
        {state.phase === 'ready' && sceneToShow?.videoUrl ? (
          <>
            {/* Video + audio elements persist for the session. The
                unified playback effect above attaches per-scene
                listeners imperatively, so there's no onEnded / onPause
                JSX binding here — it would race with the effect's
                own addEventListener cleanup. */}
            {/* `poster` gives the preview a visible first frame before
                Play is pressed — otherwise the <video> element would
                render empty-and-black (the src is assigned
                imperatively in the scene-priming effect above). */}
            <video
              ref={videoRef}
              className={
                'w-full h-full ' +
                (isFullscreen ? 'object-contain' : 'object-cover')
              }
              muted
              playsInline
              preload="auto"
              poster={sceneToShow?.imageUrl || undefined}
            />
            <audio
              ref={audioRef}
              preload="auto"
            />
          </>
        ) : sceneToShow?.imageUrl ? (
          <img
            src={sceneToShow.imageUrl}
            alt={sceneToShow.title ?? 'Scene preview'}
            className={
              'w-full h-full ' +
              (isFullscreen ? 'object-contain' : 'object-cover')
            }
            loading="lazy"
          />
        ) : null}

        {/* Caption overlay — client-side live preview of the export's
            burn-in. Positioned at 1/4 from the bottom (≈y=75%) to
            match the export pipeline's portrait-safe placement. Only
            renders when a caption style is active and we have live
            text from the sync effect. Style chips give a rough
            approximation of the eventual burn-in look; actual export
            is authoritative for rendering/timing. */}
        {state.phase === 'ready' && captionText && (
          <div
            className="absolute left-0 right-0 pointer-events-none flex justify-center"
            style={{ bottom: '25%' }}
          >
            <div className="max-w-[80%] px-3 py-1.5 rounded-md bg-black/70 border border-white/5 backdrop-blur-[1px]">
              <span className="font-sans font-bold text-[13px] sm:text-[15px] text-[#ECEAE4] tracking-tight leading-tight">
                {captionText}
              </span>
            </div>
          </div>
        )}

        {/* Per-scene regen overlay — shown on top of the frame while
            the current scene's image or video is being re-rendered.
            Animated loading ring + pulsing grid so the user clearly
            sees "work is happening", even though the underlying thumb
            is unchanged until the worker finishes. */}
        {state.phase === 'ready' && sceneActive && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-[8%] bg-black/55 backdrop-blur-[2px] animate-in fade-in duration-200">
            {/* Secondary shimmer overlay */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  'linear-gradient(110deg, transparent 0%, rgba(20,200,204,.10) 30%, rgba(20,200,204,.20) 50%, rgba(20,200,204,.10) 70%, transparent 100%)',
                backgroundSize: '200% 100%',
                animation: 'shimmer 2.2s ease-in-out infinite',
              }}
            />
            <LoadingRing size={state.aspect === '9:16' ? 44 : 60} />
            <div className="font-serif text-[15px] sm:text-[18px] font-medium text-[#ECEAE4] text-center">
              {regenLabel}
            </div>
            <div className="font-mono text-[10.5px] text-[#8A9198] tracking-[0.14em] uppercase">
              Scene {selectedSceneIndex + 1} of {state.scenes.length}
            </div>
            {/* Inline keyframes so we don't need a tailwind config
                change. Scoped via a <style> tag inside the overlay. */}
            <style>{`
              @keyframes shimmer {
                0%   { background-position: 200% 0; }
                100% { background-position: -200% 0; }
              }
            `}</style>
          </div>
        )}

        {/* Rendering overlay */}
        {state.phase === 'rendering' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-[8%] bg-black/35 backdrop-blur-[2px]">
            <LoadingRing size={state.aspect === '9:16' ? 52 : 72} />
            <div className="font-serif text-[18px] sm:text-[22px] font-medium text-[#ECEAE4] text-center">
              Rendering your video…
            </div>
            <div className="w-[60%] max-w-[420px] h-[3px] rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[#14C8CC] to-[#0FA6AE] rounded-full transition-[width] duration-500"
                style={{ width: `${state.progress}%` }}
              />
            </div>
            <div className="font-mono text-[12px] tracking-[0.12em] text-[#14C8CC]">
              {state.progress}%
            </div>
            <div className="font-serif italic text-[13px] text-[#8A9198] text-center max-w-[80%]">
              {messageForProgress(state.progress)}
            </div>
          </div>
        )}

        {/* Error overlay */}
        {state.phase === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-[8%] bg-black/55">
            <div className="font-serif text-[20px] font-medium text-[#E66666]">
              Generation failed
            </div>
            <div className="font-mono text-[11px] text-[#8A9198] tracking-wider uppercase">
              View logs or regenerate from the dashboard
            </div>
          </div>
        )}

        {/* REC timecode during render */}
        {state.phase === 'rendering' && (
          <div className="absolute top-3 left-3 font-mono text-[10px] text-white/50 tracking-[0.12em]">
            REC · {formatElapsed(state.generation?.started_at ?? null)}
          </div>
        )}
      </div>

      {/* AI disclaimer — hidden in fullscreen. On mobile it previously
          sat absolute-bottom on top of the (tall 9:16) frame, covering
          the video. Shrinking the frame's maxHeight leaves room here
          AND giving the disclaimer static positioning inside a flex
          column on mobile keeps it below the frame, not on top. */}
      {state.phase === 'ready' && !isFullscreen && (
        <div className="absolute bottom-1.5 left-0 right-0 text-center font-mono text-[9px] sm:text-[10px] text-[#5A6268] tracking-[0.06em] px-3">
          <span className="hidden sm:inline">⚠ AI-generated content — may not reflect real people, places, or events</span>
          <span className="sm:hidden">⚠ AI-generated · may not reflect reality</span>
        </div>
      )}
    </div>
  );
}
