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

// ── Rotating verbose status banks (ported verbatim from the legacy
// VideoPlayer.tsx GENERATION_MESSAGES so users get the same fun
// personality during the awaiting/rendering window). Each phase has
// a pool; useRotatingMessage() cycles through them every 4s so the
// copy never sits static long enough to feel frozen.
const GENERATION_MESSAGES: Record<'analysis' | 'scripting' | 'visuals' | 'rendering', string[]> = {
  analysis: [
    'Reading between the lines of your idea…',
    'Decoding your creative vision…',
    'Mapping out the blueprint for something epic…',
    'Analyzing the DNA of your concept…',
    'Understanding your story at a deeper level…',
  ],
  scripting: [
    'The AI screenwriter is in the zone…',
    'Crafting dialogue that hits different…',
    'Writing scenes that would make Spielberg proud…',
    'Building your narrative arc scene by scene…',
    'Cooking up a script with all the right ingredients…',
    'Weaving your story into a visual tapestry…',
  ],
  visuals: [
    'Painting your scenes with digital brushstrokes…',
    'Bringing your imagination to life, one frame at a time…',
    'The AI artist is having a creative breakthrough…',
    'Rendering visuals that pop off the screen…',
    'Creating eye candy for every scene…',
    'Turning words into stunning imagery…',
    'Each image is a small work of art…',
  ],
  rendering: [
    'Stitching it all together into pure gold…',
    'Your video is in the final stretch…',
    'Almost ready for its world premiere…',
    'Adding the final sparkle to your creation…',
    'The finish line is in sight…',
  ],
};

function phaseForProgress(pct: number): 'analysis' | 'scripting' | 'visuals' | 'rendering' {
  if (pct < 5)  return 'analysis';
  if (pct < 30) return 'scripting';
  if (pct < 85) return 'visuals';
  return 'rendering';
}

/** Rotate through a string[] at `intervalMs` cadence so the verbose
 *  status line feels alive. Seeded with a random start index so
 *  repeat visits show different copy on the first tick. */
function useRotatingMessage(messages: string[], intervalMs = 4000): string {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * messages.length));
  useEffect(() => {
    const t = setInterval(() => setIndex((i) => (i + 1) % messages.length), intervalMs);
    return () => clearInterval(t);
  }, [messages, intervalMs]);
  return messages[index] ?? messages[0] ?? '';
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
  pipelineProgress,
  pipelineDone,
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
  /** Live progress from useGenerationPipeline — this is the legacy
   *  workspace's authoritative progress source (internal setState,
   *  not DB polling), so it moves smoothly through script → images →
   *  audio → finalize. When present, it overrides state.progress
   *  (which comes from generations.progress via React Query poll
   *  and can lag by 3+ seconds). */
  pipelineProgress?: number;
  /** True when useGenerationPipeline reports step === 'complete'.
   *  The pipeline's own completion signal fires BEFORE the DB-backed
   *  React Query refetch sees status='complete' — so trust this to
   *  hide the rendering overlay without waiting for the DB round-trip.
   *  Matches how legacy workspaces dismissed their progress screens. */
  pipelineDone?: boolean;
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
  // Background music (Lyria) plays continuously across scenes, ducked
  // to ~0.15 while narration is active so voiceover sits on top cleanly.
  // Source = `state.generation.music_url` (DB column populated by
  // handleFinalize when intake.music.on). One element for the whole
  // playback session — we DON'T reset music on scene change; music
  // loops across the full video like a bed. Respects per-scene
  // `_meta.muteMusic` via volume gating.
  const musicRef = useRef<HTMLAudioElement>(null);
  const musicUrl = (state.generation as { music_url?: string | null } | null)?.music_url ?? null;
  const sceneMuteMusic = Boolean(
    (state.scenes[selectedSceneIndex]?.meta as { muteMusic?: boolean } | undefined)?.muteMusic,
  );

  // SFX / ambient bed (also Lyria-generated, lower gain) plays in
  // parallel with music. Same persistent-element pattern — never
  // resets on scene change. Source = `state.generation.sfx_url`.
  const sfxRef = useRef<HTMLAudioElement>(null);
  const sfxUrl = (state.generation as { sfx_url?: string | null } | null)?.sfx_url ?? null;
  const sceneMuteSfx = Boolean(
    (state.scenes[selectedSceneIndex]?.meta as { muteSfx?: boolean } | undefined)?.muteSfx,
  );
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

    // Chunk size mirrors the worker's caption builder so the editor
    // preview matches what the export will look like:
    //   • Single-word styles (orangeBox, yellowSlanted, redSlantedBox,
    //     motionBlur, thickStroke, comicBurst, heavyDropShadow, glitch,
    //     bouncyPill, cleanPop, toxicBounce, proShortForm) → 1 word
    //   • Subtitle styles (cinematicFade, retroTerminal, typewriter)
    //     → 5 words
    //   • Everything else → karaoke 3-word groups
    // See worker/src/services/captionBuilder.ts SINGLE_WORD_STYLES /
    // SUBTITLE_STYLES.
    const SINGLE_WORD = new Set([
      'orangeBox', 'yellowSlanted', 'redSlantedBox', 'motionBlur',
      'thickStroke', 'comicBurst', 'heavyDropShadow', 'glitch',
      'bouncyPill', 'cleanPop', 'toxicBounce', 'proShortForm',
    ]);
    const SUBTITLE = new Set(['cinematicFade', 'retroTerminal', 'typewriter']);
    const styleId = state.intake.captionStyle ?? '';
    const chunkSize = SINGLE_WORD.has(styleId) ? 1 : SUBTITLE.has(styleId) ? 5 : 3;
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
        const srcChanged = audio.src !== scene.audioUrl;
        if (srcChanged) {
          audio.src = scene.audioUrl;
          audio.load();
        }
        // Master-audio mode: all scenes share the same audioUrl. When
        // the user navigates to a different scene, DO NOT reset
        // currentTime to 0 — seek to that scene's slice so the track
        // continues playing continuously instead of restarting every
        // time the user clicks a thumbnail. Falls back to the legacy
        // per-scene reset when scenes have distinct audioUrls.
        const sceneMeta = scene.meta as { masterAudioSliceStartMs?: number } | undefined;
        const sliceStartMs = sceneMeta?.masterAudioSliceStartMs;
        const allScenesShareAudio = state.scenes.length > 1 &&
          state.scenes.every((s) => s.audioUrl === scene.audioUrl);
        if (allScenesShareAudio && typeof sliceStartMs === 'number') {
          audio.currentTime = sliceStartMs / 1000;
        } else if (srcChanged) {
          audio.currentTime = 0;
        }
      } else {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
    }
  }, [selectedSceneIndex, state.scenes]);

  // ── Background music priming. The music element persists across
  // scene changes (unlike video/audio which reset on each scene) so
  // the Lyria track plays continuously like a real film score. We
  // only touch `src` when the underlying music_url changes — never
  // on scene navigation. Volume is ducked to 0.15 while narration
  // plays and muted entirely when the current scene has muteMusic.
  useEffect(() => {
    const music = musicRef.current;
    if (!music) return;

    if (musicUrl) {
      if (music.src !== musicUrl) {
        music.src = musicUrl;
        music.load();
      }
      music.loop = true;
    } else {
      music.pause();
      music.removeAttribute('src');
      music.load();
    }
  }, [musicUrl]);

  // Volume gating — reruns on scene change so a per-scene muteMusic
  // toggle takes effect immediately without pausing/resuming the
  // music element (keeps playback smooth).
  useEffect(() => {
    const music = musicRef.current;
    if (!music) return;
    // 0 if muted for this scene; 0.15 ducked under narration; 0.35
    // between scenes (no audio). The "between scenes" case is covered
    // by the voiceover `onended` handler below raising the volume.
    music.volume = sceneMuteMusic ? 0 : 0.15;
  }, [sceneMuteMusic]);

  // SFX / ambient bed priming — same pattern as music, lower volume
  // (0.10) since it's pure atmosphere and sits under both music + voice.
  useEffect(() => {
    const sfx = sfxRef.current;
    if (!sfx) return;
    if (sfxUrl) {
      if (sfx.src !== sfxUrl) {
        sfx.src = sfxUrl;
        sfx.load();
      }
      sfx.loop = true;
    } else {
      sfx.pause();
      sfx.removeAttribute('src');
      sfx.load();
    }
  }, [sfxUrl]);

  useEffect(() => {
    const sfx = sfxRef.current;
    if (!sfx) return;
    sfx.volume = sceneMuteSfx ? 0 : 0.10;
  }, [sceneMuteSfx]);

  // ── Play/pause + end-of-scene handling. Ported from PublicShare's
  // share-page player. Handles THREE scene shapes:
  //   • Cinematic: video + audio  → drive scene end off audio
  //   • SmartFlow / Explainer static: image + audio → drive off audio
  //     (no video ref — used to short-circuit and never play anything)
  //   • Image-only: no audio, no video → just sit on the image, no
  //     auto-advance possible
  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    const music = musicRef.current;
    const sfx = sfxRef.current;
    const scene = state.scenes[selectedSceneIndex];

    if (!playing) {
      video?.pause();
      audio?.pause();
      music?.pause();
      sfx?.pause();
      return;
    }

    if (!scene) return;

    const hasVideo = !!(video && scene.videoUrl);
    const hasAudio = !!(audio && scene.audioUrl);
    const hasMusic = !!(music && musicUrl);
    const hasSfx = !!(sfx && sfxUrl);

    // If neither media is present there's nothing to play — flip the
    // transport state back so the button doesn't stay in "pause" mode.
    if (!hasVideo && !hasAudio) {
      onPlayingChange?.(false);
      return;
    }

    const handleEnded = () => {
      if (selectedSceneIndex < state.scenes.length - 1) {
        onAdvanceScene?.();
      } else {
        onPlayingChange?.(false);
        // Full video complete — fade music out over 1.5s instead of
        // stopping abruptly. Gracefully returns to UI silence.
        if (hasMusic) {
          const start = music!.volume;
          const t0 = performance.now();
          const fade = () => {
            const t = (performance.now() - t0) / 1500;
            if (t >= 1) { music!.volume = 0; music!.pause(); return; }
            music!.volume = start * (1 - t);
            requestAnimationFrame(fade);
          };
          requestAnimationFrame(fade);
        }
      }
    };

    // When the video itself ends but audio is still playing, loop the
    // visual so the frame doesn't freeze black while narration finishes.
    const handleVideoEndedInner = () => {
      if (hasAudio && !audio!.ended) {
        video!.currentTime = 0;
        const vp = video!.play();
        if (vp && typeof vp.catch === 'function') vp.catch(() => {});
        return;
      }
      handleEnded();
    };

    // Prefer audio as the "end of scene" signal when narration exists.
    // For audio-only scenes (SmartFlow / image-based) audio drives the
    // whole thing. For video-only scenes the video's end fires it.
    if (hasAudio) audio!.addEventListener('ended', handleEnded);
    if (hasVideo) video!.addEventListener('ended', handleVideoEndedInner);
    else if (!hasAudio && video) video.addEventListener('ended', handleEnded);

    (async () => {
      try {
        if (hasVideo) {
          const p = video!.play();
          if (p) await p;
        }
        if (hasAudio) {
          const ap = audio!.play();
          if (ap) await ap;
        }
        // Music plays in parallel at ducked volume. It's continuous —
        // we never pause it between scenes, only when the user pauses
        // the whole transport. Autoplay policies: if voice+video
        // started successfully via user gesture, music will too.
        if (hasMusic && music!.paused) {
          music!.volume = sceneMuteMusic ? 0 : 0.15;
          const mp = music!.play();
          if (mp && typeof mp.catch === 'function') mp.catch(() => {});
        }
        // SFX ambient bed — even quieter than music, same continuous
        // playback semantics.
        if (hasSfx && sfx!.paused) {
          sfx!.volume = sceneMuteSfx ? 0 : 0.10;
          const sp = sfx!.play();
          if (sp && typeof sp.catch === 'function') sp.catch(() => {});
        }
      } catch {
        // Autoplay blocked — user needs a gesture. Reset external state.
        onPlayingChange?.(false);
      }
    })();

    return () => {
      if (hasAudio) audio!.removeEventListener('ended', handleEnded);
      if (hasVideo) video!.removeEventListener('ended', handleVideoEndedInner);
      else if (!hasAudio && video) video.removeEventListener('ended', handleEnded);
      video?.pause();
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

      {/* Background music + SFX beds — both persist for the entire
          editor session (not reset on scene change). Rendered OUTSIDE
          the scene-aware preview block so scene navigation never
          pauses or reseeks them. Volume is controlled imperatively
          via the ducking + per-scene mute effects above. */}
      <audio ref={musicRef} preload="auto" loop />
      <audio ref={sfxRef} preload="auto" loop />

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
          <>
            <img
              src={sceneToShow.imageUrl}
              alt={sceneToShow.title ?? 'Scene preview'}
              className={
                'w-full h-full ' +
                (isFullscreen ? 'object-contain' : 'object-cover')
              }
              loading="lazy"
            />
            {/* Audio element ALWAYS rendered when a scene has narration —
                SmartFlow / image-based Explainer scenes have no video
                but still have audioUrl. Without this element the Play
                button did nothing (the playback effect has no audio
                ref to attach to). */}
            <audio ref={audioRef} preload="auto" />
          </>
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

        {/* Rendering / awaiting-generation overlay. Shown when:
              • state.phase === 'rendering' (generation row exists,
                worker is progressing), OR
              • project exists but no generation row yet (kickoff in
                flight — treat as phase 'starting' at 2%).
            The user lands in the real editor shell and watches the
            project build itself in place; as scenes / audio / music
            land, the ScenesColumn + Timeline light up live. */}
        {!pipelineDone &&
          (state.phase === 'rendering' || (state.phase === 'idle' && !!state.project)) && (
          <ProcessingOverlay
            // Pipeline progress wins when available — it's the same
            // signal the legacy workspaces used, and it ticks forward
            // in real time rather than waiting on a DB poll.
            progress={
              pipelineProgress && pipelineProgress > 0
                ? pipelineProgress
                : state.phase === 'idle'
                  ? 2
                  : state.progress
            }
            projectType={state.project?.project_type ?? 'doc2video'}
            aspect={state.aspect}
          />
        )}

        {/* Error overlay */}
        {state.phase === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-[8%] bg-black/55">
            <div className="font-serif text-[20px] font-medium text-[#E4C875]">
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

/** Processing overlay for both the kickoff window (no generation row
 *  yet) AND the active-rendering phase. Ring + "Creating your
 *  content…" heading + teal progress bar + percent + rotating verbose
 *  status underneath. Phase-aware: pulls from one of four message
 *  banks based on progress, so copy naturally follows script →
 *  imagery → voice → final stretch without us wiring each phase
 *  explicitly. */
function ProcessingOverlay({
  progress,
  projectType,
  aspect,
}: {
  progress: number;
  projectType: string | null;
  aspect: '16:9' | '9:16';
}) {
  const phase = phaseForProgress(progress);
  const rotating = useRotatingMessage(GENERATION_MESSAGES[phase]);
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-[8%] bg-black/35 backdrop-blur-[2px]">
      <LoadingRing size={aspect === '9:16' ? 52 : 72} />
      <div className="font-serif text-[18px] sm:text-[22px] font-medium text-[#ECEAE4] text-center">
        Creating your content…
      </div>
      <div className="w-[60%] max-w-[420px] h-[3px] rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-[#14C8CC] to-[#0FA6AE] rounded-full transition-[width] duration-500"
          style={{ width: `${Math.max(2, Math.min(99, progress))}%` }}
        />
      </div>
      <div className="font-mono text-[12px] tracking-[0.12em] text-[#14C8CC]">
        {Math.max(2, Math.min(99, progress))}%
      </div>
      <div className="font-serif italic text-[13px] text-[#8A9198] text-center max-w-[80%] min-h-[20px]">
        {rotating}
      </div>
      <div className="font-mono text-[10px] tracking-[0.12em] text-[#5A6268] text-center mt-1 max-w-[90%]">
        {projectType === 'cinematic'
          ? 'Script ~30s · images ~3min · audio ~2min · video ~5min'
          : projectType === 'smartflow'
            ? 'Script ~20s · image ~30s · audio ~30s'
            : 'Script ~30s · images ~2min · audio ~2min'}
      </div>
    </div>
  );
}
