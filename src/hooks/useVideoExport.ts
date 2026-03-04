/**
 * Video export hook – thin orchestrator.
 * Delegates rendering to worker or main thread paths, download/share to helpers.
 * Platform config, audio setup, and watermark rendering extracted to export/types.ts.
 */
import { useState, useCallback, useRef } from "react";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { Scene } from "./generation/types";
import { appendVideoExportLog } from "@/lib/videoExportDebug";
import {
  type ExportState,
  type ExportCallbacks,
  getPlatformConfig,
  findSupportedAudioConfig,
  generateAACAudioSpecificConfig,
  drawBrandWatermark,
  yieldToUI,
  longYield,
  gcYield,
  waitForEncoderDrain,
} from "./export/types";
import { downloadVideo, shareVideo } from "./export/downloadHelpers";

export type { ExportStatus } from "./export/types";

const LOG_PREFIX = "[VideoExport]";

export function useVideoExport() {
  const [state, setState] = useState<ExportState>({ status: "idle", progress: 0 });
  const abortRef = useRef(false);
  const exportRunIdRef = useRef(0);
  const workerRef = useRef<Worker | null>(null);

  const log = useCallback((...args: any[]) => {
    appendVideoExportLog("log", [LOG_PREFIX, ...args]);
    console.log(LOG_PREFIX, ...args);
  }, []);

  const warn = useCallback((...args: any[]) => {
    appendVideoExportLog("warn", [LOG_PREFIX, ...args]);
    console.warn(LOG_PREFIX, ...args);
  }, []);

  const err = useCallback((...args: any[]) => {
    appendVideoExportLog("error", [LOG_PREFIX, ...args]);
    console.error(LOG_PREFIX, ...args);
  }, []);

  const reset = useCallback(() => {
    abortRef.current = true;
    if (workerRef.current) {
      workerRef.current.postMessage({ type: "abort" });
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setState({ status: "idle", progress: 0 });
  }, []);

  const exportVideo = useCallback(
    async (
      scenes: Scene[],
      format: "landscape" | "portrait" | "square",
      brandMark?: string
    ) => {
      abortRef.current = false;
      const runId = ++exportRunIdRef.current;

      log("Run", runId, "Starting export", { scenes: scenes.length, format, brandMark: brandMark || "(none)" });

      const AudioEncoderCtor = (globalThis as any).AudioEncoder;
      const VideoEncoderCtor = (globalThis as any).VideoEncoder;

      if (!VideoEncoderCtor) {
        throw new Error("Your browser does not support Video Export. Please use Chrome, Edge, or Safari 16.4+");
      }

      setState({ status: "loading", progress: 0 });

      try {
        const platform = getPlatformConfig(format);
        const { dim, fps, isMobile, isIOS, isAndroid } = platform;

        // --- Audio config ---
        const wantsAudio = scenes.some(s => !!s.audioUrl);
        let audioTrackConfig: any = null;
        if (wantsAudio && AudioEncoderCtor) {
          audioTrackConfig = await findSupportedAudioConfig(AudioEncoderCtor, warn);
        }

        // === WORKER PATH ===
        const hasVideoScenes = scenes.some(s => !!s.videoUrl);
        const canUseWorker = !hasVideoScenes && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';

        if (canUseWorker) {
          log("Run", runId, "Using Web Worker path");
          setState({ status: "loading", progress: 5 });

          const targetSR = audioTrackConfig?.sampleRate ?? 48000;
          const blobCache = new Map<string, Blob>();
          for (const s of scenes) {
            const urls = s.imageUrls?.length ? s.imageUrls : [s.imageUrl || ""];
            for (const url of urls) {
              if (url && !blobCache.has(url)) {
                try { const resp = await fetch(url, { mode: "cors" }); if (resp.ok) blobCache.set(url, await resp.blob()); } catch { /* skip */ }
              }
            }
          }

          const workerScenes: Array<{ imageBitmaps: ImageBitmap[]; nextSceneFirstBitmap: ImageBitmap | null; audioSamples: Float32Array | null; duration: number }> = [];
          const xfer: Transferable[] = [];

          for (let si = 0; si < scenes.length; si++) {
            if (abortRef.current) break;
            const s = scenes[si];
            setState({ status: "loading", progress: Math.floor(5 + (si / scenes.length) * 20) });

            const urls = s.imageUrls?.length ? s.imageUrls : [s.imageUrl || ""];
            const bitmaps: ImageBitmap[] = [];
            for (const url of urls) {
              const blob = url ? blobCache.get(url) : null;
              if (blob) { try { const bm = await createImageBitmap(blob); bitmaps.push(bm); xfer.push(bm); } catch { /* skip */ } }
            }

            let nextBm: ImageBitmap | null = null;
            if (si < scenes.length - 1) {
              const nu = scenes[si + 1].imageUrls?.length ? scenes[si + 1].imageUrls! : [scenes[si + 1].imageUrl || ""];
              const nb = nu[0] ? blobCache.get(nu[0]) : null;
              if (nb) { try { nextBm = await createImageBitmap(nb); xfer.push(nextBm); } catch { /* skip */ } }
            }

            let audioSamples: Float32Array | null = null;
            let aDur = 0;
            if (s.audioUrl && audioTrackConfig) {
              try {
                const resp = await fetch(s.audioUrl);
                if (resp.ok) {
                  const ab = await resp.arrayBuffer();
                  const dCtx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(1, 1, targetSR);
                  const decoded = await dCtx.decodeAudioData(ab);
                  aDur = decoded.duration;
                  const rLen = Math.ceil(decoded.duration * targetSR);
                  const oCtx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(2, rLen, targetSR);
                  const src = oCtx.createBufferSource(); src.buffer = decoded; src.connect(oCtx.destination); src.start(0);
                  const rendered = await oCtx.startRendering();
                  audioSamples = new Float32Array(rendered.length * 2);
                  const L = rendered.getChannelData(0);
                  const R = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : L;
                  for (let j = 0; j < rendered.length; j++) { audioSamples[j * 2] = L[j]; audioSamples[j * 2 + 1] = R[j]; }
                  xfer.push(audioSamples.buffer);
                }
              } catch (e) { warn("Run", runId, `Audio decode failed scene ${si + 1}:`, e); }
            }

            workerScenes.push({ imageBitmaps: bitmaps, nextSceneFirstBitmap: nextBm, audioSamples, duration: aDur > 0 ? aDur : (s.duration || 3) });
          }

          blobCache.clear();
          setState({ status: "rendering", progress: 25 });

          const worker = new Worker(new URL('../workers/videoExportWorker.ts', import.meta.url), { type: 'module' });
          workerRef.current = worker;

          const url = await new Promise<string>((resolve, reject) => {
            worker.onmessage = (ev: MessageEvent) => {
              const m = ev.data;
              if (m.type === 'progress') setState({ status: m.status, progress: m.progress, warning: m.warning });
              else if (m.type === 'complete') {
                const blob = new Blob([m.buffer], { type: 'video/mp4' });
                const vUrl = URL.createObjectURL(blob);
                log("Run", runId, "Worker export complete", { size: m.buffer.byteLength });
                setState({ status: 'complete', progress: 100, videoUrl: vUrl });
                workerRef.current = null; worker.terminate(); resolve(vUrl);
              } else if (m.type === 'error') {
                err("Worker export failed:", m.message);
                setState({ status: 'error', progress: 0, error: m.message });
                workerRef.current = null; worker.terminate(); reject(new Error(m.message));
              } else if (m.type === 'log') appendVideoExportLog(m.level, ["[Worker]", ...m.args]);
            };
            worker.onerror = (ev) => {
              err("Worker crashed:", ev.message);
              setState({ status: 'error', progress: 0, error: 'Export worker crashed' });
              workerRef.current = null; worker.terminate(); reject(new Error('Worker crashed'));
            };
            worker.postMessage({
              type: 'start', scenes: workerScenes,
              config: { width: dim.w, height: dim.h, fps, brandMark: brandMark?.trim() || null, audioCodec: audioTrackConfig?.codec || null, audioSampleRate: targetSR, audioChannels: audioTrackConfig?.numberOfChannels ?? 2, audioBitrate: audioTrackConfig?.bitrate ?? 128_000, videoBitrate: platform.videoBitrate },
            }, xfer);
          });
          return url;
        }

        // === MAIN THREAD PATH ===
        log("Run", runId, "Using main thread path");

        const muxer = new Muxer({
          target: new ArrayBufferTarget(),
          video: { codec: "avc", width: dim.w, height: dim.h },
          audio: audioTrackConfig ? { codec: "aac", numberOfChannels: audioTrackConfig.numberOfChannels, sampleRate: audioTrackConfig.sampleRate } : undefined,
          fastStart: "in-memory",
        });

        let manualAudioDesc: Uint8Array | null = null;
        if (audioTrackConfig) {
          manualAudioDesc = generateAACAudioSpecificConfig(audioTrackConfig.sampleRate, audioTrackConfig.numberOfChannels);
          log("Run", runId, "Generated manual AAC AudioSpecificConfig", { bytes: manualAudioDesc.length });
        }

        let firstAudioChunk = true;
        let audioChunkCount = 0;
        let lastAudioDTS = -1;

        let audioEncoder: any = null;
        if (audioTrackConfig && AudioEncoderCtor) {
          audioEncoder = new AudioEncoderCtor({
            output: (chunk: any, meta: any) => {
              audioChunkCount++;
              if (firstAudioChunk && manualAudioDesc) {
                log("Run", runId, "First audio chunk - applying manual description fix");
                if (meta.decoderConfig) meta.decoderConfig.description = manualAudioDesc;
                else meta.decoderConfig = { description: manualAudioDesc };
                firstAudioChunk = false;
              }
              try {
                const chunkDTS = chunk.timestamp;
                if (chunkDTS !== undefined && chunkDTS !== null && lastAudioDTS >= 0 && chunkDTS <= lastAudioDTS) return;
                lastAudioDTS = chunkDTS ?? lastAudioDTS;
                muxer.addAudioChunk(chunk, meta);
              } catch (e) { warn("Run", runId, "muxer.addAudioChunk failed", e); }
              if (audioChunkCount % 500 === 0) log("Run", runId, "Audio chunks progress", { audioChunkCount });
            },
            error: (e: any) => warn("Audio encoding error", e),
          });
          audioEncoder.configure(audioTrackConfig);
          log("Run", runId, "AudioEncoder configured", audioTrackConfig);
        }

        const videoEncoder = new VideoEncoderCtor({
          output: (chunk: any, meta: any) => muxer.addVideoChunk(chunk, meta),
          error: (e: any) => { throw e; },
        });
        videoEncoder.configure({ codec: "avc1.42E028", width: dim.w, height: dim.h, bitrate: platform.videoBitrate, framerate: fps });

        const canvas = document.createElement("canvas");
        canvas.width = dim.w; canvas.height = dim.h;
        const ctx = canvas.getContext("2d", { alpha: false })!;
        const decodeCtx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(1, 1, audioTrackConfig ? audioTrackConfig.sampleRate : 48000);

        let globalFrameCount = 0;
        let globalAudioSampleCount = 0;

        for (let i = 0; i < scenes.length; i++) {
          if (abortRef.current) break;
          const scene = scenes[i];
          const nextScene = scenes[i + 1];

          log("Run", runId, `Processing Scene ${i + 1}/${scenes.length}`);
          setState({ status: "rendering", progress: Math.floor((i / scenes.length) * 80) });

          // Load images
          const imageUrls = scene.imageUrls?.length ? scene.imageUrls : [scene.imageUrl || ""];
          const loadedImages: HTMLImageElement[] = [];
          for (const url of imageUrls) {
            if (!url) continue;
            try {
              const img = new Image(); img.crossOrigin = "anonymous";
              await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = () => { img.crossOrigin = null; img.src = url; img.onload = resolve; img.onerror = reject; };
                img.src = url;
              });
              loadedImages.push(img);
            } catch (e) { warn(`Failed to load image for scene ${i + 1}`, e); }
          }

          // Pre-load next scene first image
          let nextSceneFirstImage: HTMLImageElement | null = null;
          if (nextScene) {
            const nextImageUrls = nextScene.imageUrls?.length ? nextScene.imageUrls : [nextScene.imageUrl || ""];
            const nextFirstUrl = nextImageUrls[0];
            if (nextFirstUrl) {
              try {
                const img = new Image(); img.crossOrigin = "anonymous";
                await new Promise((resolve, reject) => {
                  img.onload = resolve;
                  img.onerror = () => { img.crossOrigin = null; img.src = nextFirstUrl; img.onload = resolve; img.onerror = reject; };
                  img.src = nextFirstUrl;
                });
                nextSceneFirstImage = img;
              } catch (e) { warn(`Failed to pre-load next scene image`, e); }
            }
          }

          // Decode audio
          let sceneAudioBuffer: AudioBuffer | null = null;
          if (scene.audioUrl && audioTrackConfig) {
            try {
              const resp = await fetch(scene.audioUrl);
              if (resp.ok) {
                const arrayBuf = await resp.arrayBuffer();
                sceneAudioBuffer = await decodeCtx.decodeAudioData(arrayBuf);
                log("Run", runId, `Scene ${i + 1} audio decoded`, { duration: sceneAudioBuffer.duration });
              }
            } catch (e) { warn(`Audio load failed for scene ${i + 1}`, e); }
          }

          const audioDur = sceneAudioBuffer ? sceneAudioBuffer.duration : 0;
          const sceneDuration = audioDur > 0 ? audioDur : (scene.duration || 3);
          const sceneFrames = Math.ceil(sceneDuration * fps);

          // Mix & encode audio
          if (audioEncoder && audioTrackConfig) {
            const sampleRate = audioTrackConfig.sampleRate;
            const renderLen = Math.ceil(sceneDuration * sampleRate);
            const offlineCtx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(2, renderLen, sampleRate);
            if (sceneAudioBuffer) { const source = offlineCtx.createBufferSource(); source.buffer = sceneAudioBuffer; source.connect(offlineCtx.destination); source.start(0); }
            const renderedBuf = await offlineCtx.startRendering();
            const rawData = new Float32Array(renderedBuf.length * 2);
            const left = renderedBuf.getChannelData(0);
            const right = renderedBuf.numberOfChannels > 1 ? renderedBuf.getChannelData(1) : left;
            for (let s = 0; s < renderedBuf.length; s++) { rawData[s * 2] = left[s]; rawData[s * 2 + 1] = right[s]; }
            const chunkFrames = 4096;
            let audioChunkIndex = 0;
            for (let offset = 0; offset < renderedBuf.length; offset += chunkFrames) {
              const size = Math.min(chunkFrames, renderedBuf.length - offset);
              const chunkData = rawData.subarray(offset * 2, (offset + size) * 2);
              const timestampUs = Math.floor((globalAudioSampleCount / sampleRate) * 1_000_000);
              const audioData = new AudioData({ format: "f32", sampleRate, numberOfFrames: size, numberOfChannels: 2, timestamp: timestampUs, data: chunkData });
              audioEncoder.encode(audioData); audioData.close();
              globalAudioSampleCount += size; audioChunkIndex++;
              if (audioChunkIndex % 20 === 0) await yieldToUI();
            }
          }

          // Render video frames
          if (scene.videoUrl) {
            const video = document.createElement("video");
            video.crossOrigin = "anonymous"; video.muted = true; video.playsInline = true; video.preload = "auto";

            const loadVideoWithRetry = async (url: string, maxRetries = 2) => {
              const timeoutMs = isMobile ? 30000 : 120000;
              for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                  await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(() => { video.removeAttribute("src"); video.load(); reject(new Error(`Video load timeout`)); }, timeoutMs);
                    video.onloadeddata = () => { clearTimeout(timeout); resolve(); };
                    video.onerror = () => { clearTimeout(timeout); reject(new Error("Failed to load video")); };
                    video.src = attempt > 0 ? `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}` : url;
                  });
                  return;
                } catch (loadErr) {
                  log("Run", runId, `Scene ${i + 1}: Video load attempt ${attempt + 1} failed`);
                  if (attempt >= maxRetries) throw loadErr;
                  await new Promise(r => setTimeout(r, 2000));
                }
              }
            };
            await loadVideoWithRetry(scene.videoUrl!, isMobile ? 4 : 2);
            const sourceDuration = video.duration || 5;

            if (!isMobile) {
              // Desktop: frame-by-frame seeking
              log("Run", runId, `Scene ${i + 1}: Slow-Motion Stretch (desktop)`);
              video.currentTime = 0;
              await new Promise<void>(r => { video.onseeked = () => r(); });
              for (let f = 0; f < sceneFrames; f++) {
                if (abortRef.current) break;
                const progress = Math.min((f / fps) / sceneDuration, 1);
                let playbackTime = Math.max(0, Math.min(progress * sourceDuration, sourceDuration - 0.05));
                video.currentTime = playbackTime;
                await new Promise<void>(r => { video.onseeked = () => r(); });
                ctx.fillStyle = "#000"; ctx.fillRect(0, 0, dim.w, dim.h);
                const vScale = Math.min(dim.w / video.videoWidth, dim.h / video.videoHeight);
                const vw = video.videoWidth * vScale; const vh = video.videoHeight * vScale;
                ctx.drawImage(video, (dim.w - vw) / 2, (dim.h - vh) / 2, vw, vh);
                if (brandMark?.trim()) drawBrandWatermark(ctx, brandMark.trim(), dim.w, dim.h);
                await waitForEncoderDrain(videoEncoder, 10);
                const timestamp = Math.round((globalFrameCount / fps) * 1_000_000);
                const frame = new VideoFrame(canvas, { timestamp, duration: Math.round(1e6 / fps) });
                videoEncoder.encode(frame, { keyFrame: globalFrameCount % (fps * 2) === 0 }); frame.close();
                globalFrameCount++;
                if (globalFrameCount % 5 === 0) await yieldToUI();
                if (globalFrameCount % 30 === 0) await longYield();
              }
            } else {
              // Mobile: real-time playback capture
              const rate = Math.max(0.1, Math.min(sourceDuration / sceneDuration, 1));
              log("Run", runId, `Scene ${i + 1}: Real-time playback (mobile)`, { rate });
              video.currentTime = 0; video.playbackRate = rate;
              await new Promise<void>((resolve) => { if (video.readyState >= 3) { resolve(); return; } video.oncanplay = () => resolve(); });

              try {
                await video.play();
                const frameInterval = 1000 / fps;
                let lastDrawTime = performance.now();
                for (let f = 0; f < sceneFrames; f++) {
                  if (abortRef.current) break;
                  const targetTime = lastDrawTime + frameInterval;
                  const now = performance.now();
                  if (now < targetTime) await new Promise<void>(r => setTimeout(r, targetTime - now));
                  lastDrawTime = performance.now();
                  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, dim.w, dim.h);
                  const vScale = Math.min(dim.w / video.videoWidth, dim.h / video.videoHeight);
                  const vw = video.videoWidth * vScale; const vh = video.videoHeight * vScale;
                  ctx.drawImage(video, (dim.w - vw) / 2, (dim.h - vh) / 2, vw, vh);
                  if (brandMark?.trim()) drawBrandWatermark(ctx, brandMark.trim(), dim.w, dim.h);
                  await waitForEncoderDrain(videoEncoder, 10);
                  const timestamp = Math.round((globalFrameCount / fps) * 1_000_000);
                  const frame = new VideoFrame(canvas, { timestamp, duration: Math.round(1e6 / fps) });
                  videoEncoder.encode(frame, { keyFrame: globalFrameCount % (fps * 2) === 0 }); frame.close();
                  globalFrameCount++;
                }
                video.pause();
              } catch (e) {
                warn("Run", runId, `Scene ${i + 1}: video.play() failed, falling back to seeking`, e);
                video.currentTime = 0;
                await new Promise<void>(r => { video.onseeked = () => r(); });
                for (let f = 0; f < sceneFrames; f++) {
                  if (abortRef.current) break;
                  const progress = Math.min((f / fps) / sceneDuration, 1);
                  let playbackTime = Math.max(0, Math.min(progress * sourceDuration, sourceDuration - 0.05));
                  video.currentTime = playbackTime;
                  await new Promise<void>(r => { video.onseeked = () => r(); });
                  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, dim.w, dim.h);
                  const vScale = Math.min(dim.w / video.videoWidth, dim.h / video.videoHeight);
                  ctx.drawImage(video, (dim.w - vScale * video.videoWidth) / 2, (dim.h - vScale * video.videoHeight) / 2, video.videoWidth * vScale, video.videoHeight * vScale);
                  if (brandMark?.trim()) drawBrandWatermark(ctx, brandMark.trim(), dim.w, dim.h);
                  await waitForEncoderDrain(videoEncoder, 10);
                  const timestamp = Math.round((globalFrameCount / fps) * 1_000_000);
                  const frame = new VideoFrame(canvas, { timestamp, duration: Math.round(1e6 / fps) });
                  videoEncoder.encode(frame, { keyFrame: globalFrameCount % (fps * 2) === 0 }); frame.close();
                  globalFrameCount++;
                  if (globalFrameCount % 5 === 0) await yieldToUI();
                }
                video.removeAttribute("src"); video.load();
                log("Run", runId, `Scene ${i + 1} complete (seeking fallback)`);
                await gcYield();
                continue;
              }
            }

            video.pause(); video.onloadeddata = null; video.onerror = null; video.oncanplay = null; video.onseeked = null;
            video.removeAttribute("src"); video.load();
            if (isMobile) await new Promise(r => setTimeout(r, 500));
          } else {
            // Static images with fade transitions
            const imagesPerScene = Math.max(1, loadedImages.length);
            const framesPerImage = Math.ceil(sceneFrames / imagesPerScene);
            const fadeFrames = Math.min(Math.floor(fps * 0.5), Math.floor(framesPerImage * 0.2));
            const sceneCrossfadeFrames = Math.floor(fps * 0.3);

            const cachedBitmaps: Map<number, ImageBitmap> = new Map();
            for (let imgIdx = 0; imgIdx < loadedImages.length; imgIdx++) {
              const img = loadedImages[imgIdx]; if (!img) continue;
              ctx.fillStyle = "#000"; ctx.fillRect(0, 0, dim.w, dim.h);
              const scale = Math.min(dim.w / img.width, dim.h / img.height);
              ctx.drawImage(img, (dim.w - img.width * scale) / 2, (dim.h - img.height * scale) / 2, img.width * scale, img.height * scale);
              if (brandMark?.trim()) drawBrandWatermark(ctx, brandMark.trim(), dim.w, dim.h);
              cachedBitmaps.set(imgIdx, await createImageBitmap(canvas));
            }
            log("Run", runId, `Scene ${i + 1}: Pre-cached ${cachedBitmaps.size} static bitmaps`);

            for (let f = 0; f < sceneFrames; f++) {
              const imgIndex = Math.min(Math.floor(f / framesPerImage), imagesPerScene - 1);
              const nextImgIndex = Math.min(imgIndex + 1, imagesPerScene - 1);
              const frameInImage = f % framesPerImage;
              const img = loadedImages[imgIndex];
              const nextImg = loadedImages[nextImgIndex];
              const cachedBitmap = cachedBitmaps.get(imgIndex);
              const framesUntilSwitch = framesPerImage - frameInImage;
              const framesUntilSceneEnd = sceneFrames - f;
              const isOnLastImage = imgIndex === imagesPerScene - 1;
              const shouldFadeIntraScene = imagesPerScene > 1 && imgIndex < imagesPerScene - 1 && framesUntilSwitch <= fadeFrames;
              const shouldFadeInterScene = nextSceneFirstImage && isOnLastImage && framesUntilSceneEnd <= sceneCrossfadeFrames;
              const isTransitionFrame = shouldFadeIntraScene || shouldFadeInterScene;

              if (!isTransitionFrame && cachedBitmap) {
                ctx.drawImage(cachedBitmap, 0, 0);
              } else if (img) {
                ctx.fillStyle = "#000"; ctx.fillRect(0, 0, dim.w, dim.h);
                const scale = Math.min(dim.w / img.width, dim.h / img.height);
                const dw = img.width * scale; const dh = img.height * scale;
                if (shouldFadeInterScene && nextSceneFirstImage) {
                  const fadeProgress = 1 - (framesUntilSceneEnd / sceneCrossfadeFrames);
                  ctx.globalAlpha = 1 - fadeProgress;
                  ctx.drawImage(img, (dim.w - dw) / 2, (dim.h - dh) / 2, dw, dh);
                  const ns = Math.min(dim.w / nextSceneFirstImage.width, dim.h / nextSceneFirstImage.height);
                  ctx.globalAlpha = fadeProgress;
                  ctx.drawImage(nextSceneFirstImage, (dim.w - nextSceneFirstImage.width * ns) / 2, (dim.h - nextSceneFirstImage.height * ns) / 2, nextSceneFirstImage.width * ns, nextSceneFirstImage.height * ns);
                  ctx.globalAlpha = 1;
                } else if (shouldFadeIntraScene && nextImg) {
                  const fadeProgress = 1 - (framesUntilSwitch / fadeFrames);
                  ctx.globalAlpha = 1 - fadeProgress;
                  ctx.drawImage(img, (dim.w - dw) / 2, (dim.h - dh) / 2, dw, dh);
                  const ns = Math.min(dim.w / nextImg.width, dim.h / nextImg.height);
                  ctx.globalAlpha = fadeProgress;
                  ctx.drawImage(nextImg, (dim.w - nextImg.width * ns) / 2, (dim.h - nextImg.height * ns) / 2, nextImg.width * ns, nextImg.height * ns);
                  ctx.globalAlpha = 1;
                } else {
                  ctx.drawImage(img, (dim.w - dw) / 2, (dim.h - dh) / 2, dw, dh);
                }
                if (brandMark?.trim()) drawBrandWatermark(ctx, brandMark.trim(), dim.w, dim.h);
              }

              await waitForEncoderDrain(videoEncoder, 10);
              const timestamp = Math.round((globalFrameCount / fps) * 1_000_000);
              const frame = new VideoFrame(canvas, { timestamp, duration: Math.round(1e6 / fps) });
              videoEncoder.encode(frame, { keyFrame: globalFrameCount % (fps * 2) === 0 }); frame.close();
              globalFrameCount++;
              if (globalFrameCount % 10 === 0) await yieldToUI();
              if (globalFrameCount % 60 === 0) await longYield();
            }

            for (const bitmap of cachedBitmaps.values()) bitmap.close();
            cachedBitmaps.clear();
          }

          if (audioEncoder) await audioEncoder.flush();
          loadedImages.length = 0;
          await gcYield();
          log("Run", runId, `Scene ${i + 1} complete`);
          if (i === Math.floor(scenes.length / 2) && scenes.length > 10) {
            setState(prev => ({ ...prev, warning: "Long video export in progress. If browser becomes slow, save your work first." }));
          }
        }

        // Finalize
        setState({ status: "encoding", progress: 95 });
        log("Run", runId, "Flushing encoders", { audioChunkCount, globalFrameCount });
        await videoEncoder.flush();
        if (audioEncoder) await audioEncoder.flush();
        videoEncoder.close();
        if (audioEncoder) audioEncoder.close();
        muxer.finalize();

        const { buffer } = muxer.target as ArrayBufferTarget;
        const blob = new Blob([buffer], { type: "video/mp4" });
        const url = URL.createObjectURL(blob);
        log("Run", runId, "Export Complete", { size: buffer.byteLength, audioChunkCount, videoFrames: globalFrameCount });
        setState({ status: "complete", progress: 100, videoUrl: url });
        return url;
      } catch (e: any) {
        const msg = e.message || "Unknown export error";
        err("Export Failed", e);
        setState({ status: "error", progress: 0, error: msg });
        throw e;
      }
    },
    [log, warn, err]
  );

  const handleDownload = useCallback(async (url: string, filename = "video.mp4") => {
    log("downloadVideo called", { filename });
    await downloadVideo(url, filename);
  }, [log]);

  const handleShare = useCallback(async (url: string, filename = "video.mp4") => {
    log("shareVideo called", { filename });
    return shareVideo(url, filename);
  }, [log]);

  return { state, exportVideo, downloadVideo: handleDownload, shareVideo: handleShare, reset };
}
