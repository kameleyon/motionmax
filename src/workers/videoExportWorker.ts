/// <reference lib="webworker" />
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface WorkerScene {
  imageBitmaps: ImageBitmap[];
  nextSceneFirstBitmap: ImageBitmap | null;
  audioSamples: Float32Array | null;
  duration: number;
}

interface ExportConfig {
  width: number;
  height: number;
  fps: number;
  brandMark: string | null;
  audioCodec: string | null;
  audioSampleRate: number;
  audioChannels: number;
  audioBitrate: number;
  videoBitrate: number;
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let aborted = false;

/* ------------------------------------------------------------------ */
/*  Message handler                                                    */
/* ------------------------------------------------------------------ */

self.onmessage = (e: MessageEvent) => {
  if (e.data.type === "abort") {
    aborted = true;
    return;
  }
  if (e.data.type === "start") {
    aborted = false;
    runExport(e.data.scenes as WorkerScene[], e.data.config as ExportConfig).catch(
      (err: Error) => {
        self.postMessage({ type: "error", message: err?.message || "Unknown worker error" });
      }
    );
  }
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function postLog(level: string, ...args: unknown[]) {
  self.postMessage({
    type: "log",
    level,
    args: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))),
  });
}

function generateAACAudioSpecificConfig(sampleRate: number, channels: number): Uint8Array {
  const objectType = 2; // AAC-LC
  const freqIndex: Record<number, number> = {
    96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5,
    24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11,
  };
  const fi = freqIndex[sampleRate] ?? 4;
  const config = new Uint8Array(2);
  config[0] = (objectType << 3) | ((fi >> 1) & 0x07);
  config[1] = ((fi & 0x01) << 7) | (channels << 3);
  return config;
}

function drawBrandWatermark(
  ctx: OffscreenCanvasRenderingContext2D,
  brandMark: string,
  w: number,
  h: number
) {
  const fontSize = Math.max(18, Math.round(w * 0.028));
  const px = Math.round(fontSize * 1.0);
  const py = Math.round(fontSize * 0.5);
  const radius = Math.round(fontSize * 0.5);
  const margin = Math.round(h * 0.035);

  ctx.font = `500 ${fontSize}px Montserrat, -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const tw = ctx.measureText(brandMark).width;
  const pillW = tw + px * 2;
  const pillH = fontSize + py * 2;
  const pillX = (w - pillW) / 2;
  const pillY = h - margin - pillH;

  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(pillX, pillY, pillW, pillH, radius);
  } else {
    ctx.rect(pillX, pillY, pillW, pillH);
  }
  ctx.fill();

  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.fillText(brandMark, w / 2, pillY + pillH / 2);
}

/* ------------------------------------------------------------------ */
/*  Main export pipeline (runs entirely off-main-thread)               */
/* ------------------------------------------------------------------ */

async function runExport(scenes: WorkerScene[], config: ExportConfig) {
  const {
    width, height, fps, brandMark,
    audioCodec, audioSampleRate, audioChannels, audioBitrate, videoBitrate,
  } = config;

  const wantsAudio = !!audioCodec && scenes.some((s) => s.audioSamples !== null);

  postLog("log", "Worker started", JSON.stringify({ scenes: scenes.length, width, height, fps, wantsAudio }));

  // --- Muxer ---
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height },
    audio: wantsAudio
      ? { codec: "aac", numberOfChannels: audioChannels, sampleRate: audioSampleRate }
      : undefined,
    fastStart: "in-memory",
  });

  // AAC iOS description fix
  const manualAudioDesc = wantsAudio
    ? generateAACAudioSpecificConfig(audioSampleRate, audioChannels)
    : null;

  let firstAudioChunk = true;
  let lastAudioDTS = -1;

  // --- Audio Encoder ---
  let audioEncoder: AudioEncoder | null = null;
  if (wantsAudio) {
    audioEncoder = new AudioEncoder({
      output: (chunk: EncodedAudioChunk, meta: EncodedAudioChunkMetadata) => {
        // Fix iOS AAC description on first chunk
        if (firstAudioChunk && manualAudioDesc) {
          if (meta.decoderConfig) {
            meta.decoderConfig.description = manualAudioDesc;
          } else {
            (meta as any).decoderConfig = { description: manualAudioDesc };
          }
          firstAudioChunk = false;
        }
        try {
          const dts = chunk.timestamp;
          if (dts !== undefined && lastAudioDTS >= 0 && dts <= lastAudioDTS) return;
          lastAudioDTS = dts ?? lastAudioDTS;
          muxer.addAudioChunk(chunk, meta);
        } catch (e) {
          postLog("warn", "muxer.addAudioChunk failed", String(e));
        }
      },
      error: (e: DOMException) => postLog("warn", "AudioEncoder error", e.message),
    });
    audioEncoder.configure({
      codec: audioCodec!,
      sampleRate: audioSampleRate,
      numberOfChannels: audioChannels,
      bitrate: audioBitrate,
    });
  }

  // --- Video Encoder ---
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { throw e; },
  });
  videoEncoder.configure({
    codec: "avc1.42E028",
    width,
    height,
    bitrate: videoBitrate,
    framerate: fps,
  });

  // --- OffscreenCanvas ---
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false })!;

  let globalFrameCount = 0;
  let globalAudioSampleCount = 0;

  // --- Per-scene processing ---
  for (let i = 0; i < scenes.length; i++) {
    if (aborted) break;

    const { imageBitmaps, nextSceneFirstBitmap, audioSamples, duration } = scenes[i];

    self.postMessage({
      type: "progress",
      status: "rendering",
      progress: Math.floor(10 + (i / scenes.length) * 70),
    });
    postLog("log", `Scene ${i + 1}/${scenes.length}, duration=${duration.toFixed(2)}s`);

    const sceneFrames = Math.ceil(duration * fps);

    // ---- Encode audio ----
    if (audioEncoder && audioSamples) {
      const totalSamples = audioSamples.length / 2; // interleaved stereo
      const chunkSize = 4096;
      for (let offset = 0; offset < totalSamples; offset += chunkSize) {
        const size = Math.min(chunkSize, totalSamples - offset);
        const chunkData = audioSamples.subarray(offset * 2, (offset + size) * 2);
        const tsUs = Math.floor((globalAudioSampleCount / audioSampleRate) * 1_000_000);
        const ad = new AudioData({
          format: "f32",
          sampleRate: audioSampleRate,
          numberOfFrames: size,
          numberOfChannels: 2,
          timestamp: tsUs,
          data: chunkData as Float32Array<ArrayBuffer>,
        });
        audioEncoder.encode(ad);
        ad.close();
        globalAudioSampleCount += size;
      }
    }

    // ---- Render video frames ----
    const imgCount = Math.max(1, imageBitmaps.length);
    const framesPerImg = Math.ceil(sceneFrames / imgCount);
    const fadeFrames = Math.min(Math.floor(fps * 0.5), Math.floor(framesPerImg * 0.2));
    const crossfadeFrames = Math.floor(fps * 0.3);

    for (let f = 0; f < sceneFrames; f++) {
      if (aborted) break;

      const imgIdx = Math.min(Math.floor(f / framesPerImg), imgCount - 1);
      const nextIdx = Math.min(imgIdx + 1, imgCount - 1);
      const frameInImg = f % framesPerImg;
      const untilSwitch = framesPerImg - frameInImg;
      const untilEnd = sceneFrames - f;
      const isLast = imgIdx === imgCount - 1;

      const fadeIntra = imgCount > 1 && imgIdx < imgCount - 1 && untilSwitch <= fadeFrames;
      const fadeInter = !!nextSceneFirstBitmap && isLast && untilEnd <= crossfadeFrames;

      const img = imageBitmaps[imgIdx];

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);

      if (img) {
        const scale = Math.min(width / img.width, height / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;

        if (fadeInter && nextSceneFirstBitmap) {
          const p = 1 - untilEnd / crossfadeFrames;
          ctx.globalAlpha = 1 - p;
          ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
          const ns = nextSceneFirstBitmap;
          const nsc = Math.min(width / ns.width, height / ns.height);
          ctx.globalAlpha = p;
          ctx.drawImage(
            ns,
            (width - ns.width * nsc) / 2,
            (height - ns.height * nsc) / 2,
            ns.width * nsc,
            ns.height * nsc
          );
          ctx.globalAlpha = 1;
        } else if (fadeIntra && imageBitmaps[nextIdx]) {
          const nxt = imageBitmaps[nextIdx];
          const p = 1 - untilSwitch / fadeFrames;
          ctx.globalAlpha = 1 - p;
          ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
          const nsc = Math.min(width / nxt.width, height / nxt.height);
          ctx.globalAlpha = p;
          ctx.drawImage(
            nxt,
            (width - nxt.width * nsc) / 2,
            (height - nxt.height * nsc) / 2,
            nxt.width * nsc,
            nxt.height * nsc
          );
          ctx.globalAlpha = 1;
        } else {
          ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
        }
      }

      if (brandMark) drawBrandWatermark(ctx, brandMark, width, height);

      // Backpressure: wait if encoder queue is too full
      while (videoEncoder.encodeQueueSize > 10) {
        await new Promise<void>((r) => setTimeout(r, 16));
      }

      const ts = Math.round((globalFrameCount / fps) * 1_000_000);
      const frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1e6 / fps) });
      videoEncoder.encode(frame, { keyFrame: globalFrameCount % (fps * 2) === 0 });
      frame.close();
      globalFrameCount++;
    }

    // Flush audio between scenes to prevent DTS monotonicity issues
    if (audioEncoder) await audioEncoder.flush();

    // Release bitmaps to free memory
    for (const bm of imageBitmaps) bm.close();
    if (nextSceneFirstBitmap) nextSceneFirstBitmap.close();

    postLog("log", `Scene ${i + 1} complete, frames=${globalFrameCount}`);

    // Show warning for long exports
    if (i === Math.floor(scenes.length / 2) && scenes.length > 10) {
      self.postMessage({
        type: "progress",
        status: "rendering",
        progress: Math.floor(10 + (i / scenes.length) * 70),
        warning: "Long video export in progress.",
      });
    }
  }

  // --- Finalize ---
  self.postMessage({ type: "progress", status: "encoding", progress: 92 });

  postLog("log", `Flushing encoders, frames=${globalFrameCount}, audioSamples=${globalAudioSampleCount}`);

  await videoEncoder.flush();
  if (audioEncoder) await audioEncoder.flush();
  videoEncoder.close();
  if (audioEncoder) audioEncoder.close();
  muxer.finalize();

  const { buffer } = muxer.target as ArrayBufferTarget;
  postLog("log", `Export complete, size=${buffer.byteLength}`);
  self.postMessage({ type: "complete", buffer }, [buffer]);
}
