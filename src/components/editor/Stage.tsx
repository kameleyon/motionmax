import { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { EditorState, EditorScene } from '@/hooks/useEditorState';

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
}) {
  const [, tick] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // The TTS narration lives on scene.audioUrl — not baked into the
  // Kling video clip (Kling is rendered with sound=false). We attach a
  // parallel <audio> element that plays in sync with the video; the
  // narration's end event drives scene auto-advance so the composite
  // "scene duration" = audio duration, matching the timeline widths.
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // REC timecode ticks while rendering.
  useEffect(() => {
    if (state.phase !== 'rendering') return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [state.phase]);

  // Fullscreen handling.
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Keep both the <video> AND the <audio> synchronised to the
  // Timeline's play state. Video is muted so only the narration audio
  // is audible — Kling clips ship silent anyway. `.play()` is async
  // and rejects if the page hasn't seen a user gesture yet; we swallow.
  useEffect(() => {
    const v = videoRef.current;
    const a = audioRef.current;
    const playBoth = () => {
      const vp = v?.play();
      if (vp && typeof vp.catch === 'function') vp.catch(() => { /* autoplay blocked */ });
      const ap = a?.play();
      if (ap && typeof ap.catch === 'function') ap.catch(() => { /* autoplay blocked */ });
    };
    if (playing) {
      playBoth();
    } else {
      v?.pause();
      a?.pause();
    }
  }, [playing, selectedSceneIndex]);

  // Rewind to the start of each new scene as we walk through them so
  // a scene change always plays from 0, not from where the last one
  // left off (browsers cache decoded positions per <video src>).
  useEffect(() => {
    if (videoRef.current) videoRef.current.currentTime = 0;
    if (audioRef.current) audioRef.current.currentTime = 0;
  }, [selectedSceneIndex]);

  // Narration audio drives scene boundaries because it's the canonical
  // length (Kling clips are 10s regardless of how long the voiceover
  // runs). When audio ends, advance if there's another scene; on the
  // final scene's audio end, stop playback.
  const isLastScene = selectedSceneIndex >= state.scenes.length - 1;
  const handleAudioEnded = () => {
    if (isLastScene || !onAdvanceScene) {
      onPlayingChange?.(false);
      return;
    }
    // Keep `playing` true — the scene-change useEffect above will fire
    // `play()` on the next scene's audio + video automatically.
    onAdvanceScene();
  };

  // If the video itself ends but audio is still playing, loop the
  // video so the frame doesn't freeze on black before the narration
  // finishes. Only scene transitions are driven by audio end.
  const handleVideoEnded = () => {
    const v = videoRef.current;
    const a = audioRef.current;
    // If there's no audio track, fall back to the video's end event.
    if (!a || !a.src) {
      if (isLastScene || !onAdvanceScene) onPlayingChange?.(false);
      else onAdvanceScene();
      return;
    }
    // Loop the visual while narration finishes.
    if (v && !a.ended) {
      v.currentTime = 0;
      const vp = v.play();
      if (vp && typeof vp.catch === 'function') vp.catch(() => {});
    }
  };

  const aspectCss = state.aspect === '16:9' ? '16/9' : '9/16';
  const frameMaxW = state.aspect === '16:9' ? '92%' : '48%';
  const frameMaxH = state.aspect === '16:9' ? '88%' : '92%';
  const frameW    = state.aspect === '16:9' ? '82%' : 'auto';
  const frameH    = state.aspect === '16:9' ? 'auto' : '88%';

  const sceneToShow: EditorScene | undefined =
    state.scenes[selectedSceneIndex] ??
    // While rendering, show the latest scene with a visible asset.
    state.scenes.slice().reverse().find((s) => s.videoUrl || s.imageUrl) ??
    state.scenes[0];

  const toggleFullscreen = () => {
    if (!stageRef.current) return;
    if (document.fullscreenElement) { void document.exitFullscreen(); }
    else { void stageRef.current.requestFullscreen(); }
  };

  return (
    <div
      ref={stageRef}
      className="relative h-full w-full grid place-items-center overflow-hidden"
      style={{
        background:
          'radial-gradient(80% 100% at 50% 50%, rgba(20,200,204,.04), transparent 65%), #050709',
      }}
    >
      {/* Subtle grid */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,.035) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      />

      {/* Aspect chip */}
      <div className="absolute top-3 left-3 z-[4] flex gap-1 p-[3px] bg-[#10151A]/80 border border-white/5 rounded-lg backdrop-blur-sm font-mono text-[10px] tracking-[0.08em]">
        {(['16:9', '9:16'] as const).map((a) => (
          <span
            key={a}
            className={
              'px-2.5 py-1 rounded ' +
              (a === state.aspect
                ? 'bg-[#1B2228] text-[#ECEAE4]'
                : 'text-[#5A6268]')
            }
          >
            {a}
          </span>
        ))}
      </div>

      {/* Quality + fullscreen */}
      <div className="absolute top-3 right-3 z-[4] flex gap-1.5">
        <span className="font-mono text-[10px] tracking-[0.1em] text-[#8A9198] px-2 py-1 bg-[#10151A]/80 border border-white/5 rounded-md backdrop-blur-sm">
          1080p · 24fps
        </span>
        <button
          type="button"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label="Toggle fullscreen"
          className="w-7 h-7 grid place-items-center bg-[#10151A]/80 border border-white/5 rounded-md text-[#8A9198] hover:text-[#ECEAE4]"
        >
          {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
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
            Timeline transport so video + narration stay in lockstep. */}
        {state.phase === 'ready' && sceneToShow?.videoUrl ? (
          <>
            <video
              ref={videoRef}
              key={sceneToShow.videoUrl}
              src={sceneToShow.videoUrl}
              className="w-full h-full object-cover"
              muted
              playsInline
              preload="auto"
              onEnded={handleVideoEnded}
            />
            {sceneToShow.audioUrl && (
              <audio
                ref={audioRef}
                key={sceneToShow.audioUrl}
                src={sceneToShow.audioUrl}
                preload="auto"
                onPlay={() => onPlayingChange?.(true)}
                onPause={() => onPlayingChange?.(false)}
                onEnded={handleAudioEnded}
              />
            )}
          </>
        ) : sceneToShow?.imageUrl ? (
          <img
            src={sceneToShow.imageUrl}
            alt={sceneToShow.title ?? 'Scene preview'}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : null}

        {/* Rendering overlay */}
        {state.phase === 'rendering' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-[8%] bg-black/35 backdrop-blur-[2px]">
            <LoadingRing size={state.aspect === '9:16' ? 52 : 72} />
            <div className="font-serif text-[18px] sm:text-[22px] font-medium text-[#ECEAE4] text-center">
              Rendering your video…
            </div>
            <div className="w-[60%] max-w-[420px] h-1 rounded-full bg-white/10 overflow-hidden">
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

      {/* AI disclaimer */}
      {state.phase === 'ready' && (
        <div className="absolute bottom-3 left-0 right-0 text-center font-mono text-[10px] text-[#5A6268] tracking-[0.08em]">
          ⚠ AI-generated content — may not reflect real people, places, or events
        </div>
      )}
    </div>
  );
}
