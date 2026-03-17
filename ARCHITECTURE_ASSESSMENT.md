# MotionMax Architecture Assessment

**Date:** 2026-03-17
**Status:** Assessment Complete — No Code Changes Made

See the full assessment in the conversation/PR that produced this file.

## Summary of Findings

### What's on the Worker (Correct)
- Script generation (generate_video)
- Image generation - standard pipeline (process_images)
- Audio generation - standard pipeline (process_audio)
- Finalize (finalize_generation)
- Image regeneration (regenerate_image)
- Audio regeneration (regenerate_audio)
- Video export (export_video)

### What's Still on the Edge Function (Needs Migration)
- Cinematic video generation (phase: "video") — no worker handler exists
- Cinematic video regeneration — hardcoded to edge function in useCinematicRegeneration.ts

### What's Misrouted (Worker Intercepts but Handles Incorrectly)
- Cinematic per-scene audio (callPhase intercepts but worker expects batch format)
- Cinematic per-scene images (callPhase intercepts but worker expects batch format)

### Root Causes of Slow Performance
1. Worker processes ONE job at a time (global busy lock)
2. Excessive job granularity — each audio/image chunk is a separate queued job
3. 5s worker poll + 3s frontend poll = 8s dead time per phase transition
4. Export encodes 1 scene at a time due to 512MB RAM constraint
5. Cinematic video still on edge function with polling overhead

### Render Instance Assessment
- Current: 512MB RAM (Starter) — INSUFFICIENT
- Recommended: 2GB RAM (Standard, $25/mo) minimum, 4GB RAM (Pro, $85/mo) ideal

### 5 Problems Identified
1. Multi-user blocked by single-job worker — needs concurrency
2. Worker slow due to serial processing and chunking overhead — needs parallel + single-job phases
3. Image regen already on worker (FIXED) — cinematic image routing has format mismatch
4. Cinematic video has no worker handler — needs new handler + routing
5. No undo/redo — needs scene history tracking
