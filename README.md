# MotionMax — AI Video Generator

MotionMax is a full-stack AI video creation platform that transforms text, articles, and ideas into professional cinematic videos, explainer content, visual stories, and infographics — all powered by AI.

## What MotionMax Does

- **Cinematic Videos** — AI-generated video scenes with image-to-video transitions (Kling V2.5/V2.6), voiceover narration, and seamless scene morphing
- **Explainer Videos** — Turn documents, articles, or any text into narrated slideshow videos with multiple visual styles
- **Visual Stories** — AI scriptwriting + image generation + voiceover for storytelling content
- **Smart Flow Infographics** — Transform data into narrated visual infographics
- **25+ Caption Styles** — Burn-in captions with styles from Classic to Karaoke word-by-word highlighting
- **Voice Cloning** — Clone voices for consistent narration across projects
- **Multi-Language** — English, French, Spanish, Portuguese, German, Italian, Russian, Chinese, Japanese, Korean, Haitian Creole

## Key Features

- **AI Research Phase** — Claude Sonnet 4.6 researches topics before scriptwriting for factual accuracy (verified character appearances, cultural context, historical details)
- **AI Script Generation** — Claude Sonnet 4.6 via OpenRouter writes cinematic scripts with character bibles, camera directions, and narrative arcs
- **AI Image Generation** — Hypereal (Gemini Flash) creates scene images with style consistency
- **AI Video Generation** — Kling V2.5/V2.6 Pro I2V creates 10-second video clips with end-image transitions between scenes
- **AI Voice Generation** — Qwen3 TTS, Fish Audio, LemonFox, ElevenLabs, Google Gemini TTS with style instructions per scene
- **Scene Editing** — Edit individual scenes (image edit via Nano Banana Edit, audio regeneration, video regeneration) with automatic affected-video regeneration
- **Video Export** — Server-side ffmpeg rendering with audio-video sync, caption burn-in, compression, and TUS resumable upload

## Tech Stack

### Frontend
- **React 18** + TypeScript + Vite
- **Tailwind CSS** + shadcn/ui components
- **Framer Motion** for animations
- **Supabase Realtime** for live progress tracking

### Backend
- **Node.js worker** on Render.com — handles all heavy processing
- **Supabase** — PostgreSQL database, Auth, Storage, Edge Functions
- **FFmpeg** — video encoding, concatenation, caption burn-in
- **OpenRouter** — LLM API (Claude Sonnet 4.6)

### AI Services
- **Hypereal** — Image generation (Gemini Flash), video generation (Kling V2.5/V2.6), image editing (Nano Banana Edit)
- **Replicate** — Qwen3 TTS, Chatterbox TTS
- **Fish Audio** — TTS (English, French, Spanish)
- **LemonFox** — TTS (English)
- **ElevenLabs** — TTS + Voice Cloning + Speech-to-Speech
- **Google Gemini** — TTS (Haitian Creole)

## Architecture

```
Frontend (Vite/React) → Supabase (Auth + DB + Storage + Realtime)
                                    ↓
                         Worker (Render.com Node.js)
                         ├── Script Generation (OpenRouter/Claude)
                         ├── Research Phase (OpenRouter/Claude)
                         ├── Audio Generation (Qwen3/Fish/LemonFox/ElevenLabs/Gemini)
                         ├── Image Generation (Hypereal)
                         ├── Video Generation (Hypereal/Kling)
                         ├── Image Editing (Hypereal/Nano Banana Edit)
                         └── Video Export (FFmpeg + Caption burn-in)
```

## Project Structure

```
src/                          # Frontend React app
  components/workspace/       # Workspace UIs (Cinematic, Storytelling, SmartFlow, Doc2Video)
  hooks/                      # React hooks (generation pipeline, video export, subscriptions)
  pages/                      # Page components (Landing, Dashboard, Auth, etc.)

worker/                       # Backend Node.js worker
  src/handlers/               # Job handlers (script, audio, image, video, export)
  src/services/               # AI service integrations (OpenRouter, Hypereal, TTS providers)

supabase/                     # Supabase configuration
  functions/                  # Edge functions (share-meta, generate-video, etc.)
  migrations/                 # Database migrations
```

## Subscription Plans

- **Free** — 10 credits/month, short videos, landscape/square
- **Starter** — 30 credits/month, short/brief videos, all formats, infographics
- **Creator** — 100 credits/month, all lengths, custom styles, brand mark, voice cloning
- **Professional** — 300 credits/month, cinematic videos, priority rendering

## Links

- **Website**: [motionmax.io](https://motionmax.io)
- **App**: [motionmax.io/app](https://motionmax.io/app)
