# MotionMax Pricing Redesign Proposal
**Date:** April 5, 2026

---

## Current State

**Current model:** Flat-rate credits (1 short = 1 credit, 1 cinematic = 12 credits)
**Current plans:** Free (10), Starter $14.99 (30), Creator $39.99 (100), Professional $89.99 (300)
**Problem:** A 15-second clip costs the same as a 3-minute clip. Power users on cinematic drain credits fast. No protection against API cost spikes.

---

## Proposed Model: Per-Second Credits (Opus Agent Style)

### Core Formula

**1 credit = 1 second of generated output**

Audio determines duration. At ~2.25 words/second TTS rate:
- 25 words = ~11 seconds = 11 credits
- 15 scenes x 10 seconds = 150 seconds = 150 credits (short cinematic)
- 28 scenes x 10 seconds = 280 seconds = 280 credits (brief cinematic)

### Compute Multipliers by Product

Different products have different API costs per second:

| Product | Multiplier | Why | Realistic Example |
|---------|-----------|-----|-------------------|
| **Explainers** (doc2video) | 1x | Image + TTS only, no AI video | 3-min script (180s) = **180 credits** |
| **Smart Flow** (infographics) | 0.5x | Static images, no video/audio | 3-min deck (180s) = **90 credits** |
| **Cinematic** | 3x | AI video (Kling) + TTS + ASR + research | 2-min video (120s) = **360 credits** |
| **Audio to Video** (future) | 2x | AI video from uploaded audio | 2-min audio (120s) = **240 credits** |
| **AI UGC / Avatar** (future) | 4x | Lip-sync + avatar rendering, heaviest compute | 45-sec clip = **180 credits** |
| **Bar Chart Race** (future) | 1x | Templated animation, light compute | 1.5-min race (90s) = **90 credits** |

> **Cost is always dynamic.** There is no fixed duration — a user can generate a 30-second social hook or a 10-minute explainer. The formula is always: `credits = duration_in_seconds × multiplier`.

### Per-Action Credits (Non-Video)

| Action | Credits | Why |
|--------|---------|-----|
| Scene regeneration (image) | 5 | Single image gen |
| Scene regeneration (video) | 10 | Single Kling I2V call |
| Scene edit (Nano Banana) | 3 | Image edit API |
| Voice clone | 50 | ElevenLabs voice training |
| Voice preview | 1 | Short TTS sample |
| Export (render) | 0 | Already paid for generation |
| Research (AI) | 0 | Included in generation cost |
| Background music (future) | 10 | Per track generation |
| Lip-sync (future) | 2x per second | Heavy compute |

---

## Two Plans (Like Opus Agent)

### Plan 1: Creator -- $19/month (or $14/month yearly)

| Feature | Limit |
|---------|-------|
| **Monthly credits** | 3,000 (= ~50 min standard, ~17 min cinematic) |
| **Daily limit** | 500 credits/day |
| **Video quality** | 1080p |
| **Formats** | All (16:9, 9:16) |
| **Visual styles** | All 23 styles + custom |
| **Voice cloning** | 1 clone |
| **Languages** | All 11 |
| **Captions** | All 23 caption styles |
| **Brand mark** | Yes |
| **Smart Flow** | 20/month |
| **Export** | Unlimited |
| **Support** | Email (48h) |

**What 3,000 credits gets you:**
- ~20 short explainer videos (150s each = 150 credits)
- OR ~10 short cinematic videos (150s x 3x = 450 credits each)
- OR ~5 brief cinematic videos (280s x 3x = 840 credits each)
- OR mix and match

### Plan 2: Pro -- $49/month (or $37/month yearly)

| Feature | Limit |
|---------|-------|
| **Monthly credits** | 10,000 (= ~167 min standard, ~56 min cinematic) |
| **Daily limit** | 2,000 credits/day |
| **Video quality** | 1080p (4K future) |
| **Formats** | All |
| **Visual styles** | All + premium effects |
| **Voice cloning** | 5 clones |
| **Languages** | All 11 + priority new languages |
| **Captions** | All styles |
| **Brand mark** | Full brand kit |
| **Smart Flow** | Unlimited |
| **AI UGC / Avatar** (future) | Included |
| **Bar Chart Race** (future) | Included |
| **Background music** (future) | Included |
| **Export** | Unlimited |
| **Priority rendering** | Yes (queue priority) |
| **Support** | Priority (24h) |

**What 10,000 credits gets you:**
- ~66 short explainer videos
- OR ~22 short cinematic videos
- OR ~12 brief cinematic videos
- OR mix and match freely

---

## Credit Packs (Top-Up)

For users who run out mid-month:

| Pack | Credits | Price | Per Credit |
|------|---------|-------|-----------|
| Small | 500 | $4.99 | $0.010 |
| Medium | 2,000 | $14.99 | $0.0075 |
| Large | 5,000 | $29.99 | $0.006 |
| Mega | 15,000 | $79.99 | $0.0053 |

---

## Free Tier

| Feature | Limit |
|---------|-------|
| **Credits** | 300 on signup (one-time, no monthly renewal) |
| **Daily limit** | 100 credits/day |
| **Video quality** | 720p |
| **Formats** | Landscape only |
| **Visual styles** | 5 basic |
| **Voice cloning** | No |
| **Captions** | 3 basic styles |
| **Brand mark** | No (watermark on exports) |
| **Smart Flow** | 3 total (not monthly) |
| **Support** | Community only |

300 credits = enough for 2 short explainer videos or 1 short cinematic to try the platform.

---

## Comparison: Current vs Proposed

| Metric | Current | Proposed |
|--------|---------|----------|
| Credit unit | Arbitrary (1 short = 1 credit) | 1 second of output |
| Pricing transparency | Confusing (why is cinematic 12x?) | Clear (longer video = more credits) |
| API cost protection | None (flat rate regardless of length) | Built-in (cost scales with compute) |
| Scene regen cost | Free (hidden cost to platform) | 5-10 credits (user pays for what they use) |
| Plan count | 5 (Free, Starter, Creator, Pro, Enterprise) | 3 (Free, Creator, Pro) + Enterprise on request |
| Price points | $0, $15, $40, $90 | $0, $19, $49 |
| Monthly value (Creator) | 100 flat credits | 3,000 second-credits (~50 min video) |

---

## Implementation Approach

### Phase 1: Backend Credit System (No UI Change)

1. Change `CREDIT_COSTS` in `planLimits.ts` to calculate based on estimated duration:
   - `getCreditsRequired(projectType, length)` returns `estimatedSeconds * multiplier`
   - Short: 150s, Brief: 280s, Presentation: 360s
   - Multipliers: explainer 1x, cinematic 3x, smartflow 0.5x

2. Update `PLAN_LIMITS` credit amounts:
   - Free: 300 (one-time)
   - Creator: 3,000/month
   - Pro: 10,000/month

3. Update Stripe products/prices to match new plan structure

4. Add per-action credit deduction for scene regen, voice clone, etc.

### Phase 2: Frontend

1. Update pricing page with 2-plan layout
2. Show credit cost before generation: "This will use ~450 credits (150s x 3x cinematic)"
3. Update credit display to show seconds equivalent
4. Add daily limit enforcement

### Phase 3: Granular Billing (Post-Launch)

1. After generation completes, calculate ACTUAL seconds (not estimated)
2. Refund difference if actual < estimated
3. Add real-time credit meter during generation

---

## Revenue Projections

| Scenario | Monthly Revenue | Users |
|----------|----------------|-------|
| 100 Creator plans | $1,900 | 100 |
| 50 Creator + 20 Pro | $1,930 | 70 |
| 200 Creator + 50 Pro | $6,300 | 250 |
| 500 Creator + 100 Pro | $14,400 | 600 |

Plus credit pack revenue (estimated 20% of subscribers buy top-ups):
- 100 subscribers x 20% x $15 avg = $300/month additional

---

## Risk Analysis

| Risk | Mitigation |
|------|-----------|
| Existing users upset by price change | Grandfather existing plans for 6 months |
| Per-second feels expensive | Show "minutes of video" not raw credit numbers |
| Daily limit frustrates power users | Pro plan has 2,000/day (33 min cinematic) |
| Future products change cost structure | Multiplier system absorbs new products easily |
| Competitors undercut on price | Value is in quality (Kling cinematic, ASR captions, research) not price |

---

## Opus Agent Comparison

| Feature | Opus Agent | MotionMax (Proposed) |
|---------|-----------|---------------------|
| Price | $19/month (sale), $29 normal | $19 Creator, $49 Pro |
| Monthly credits | 300 | 3,000 Creator / 10,000 Pro |
| Daily limit | 200 | 500 Creator / 2,000 Pro |
| Credit = | 1 second video | 1 second standard (multiplied for heavy compute) |
| AI video (scene-by-scene) | Yes | Yes (Kling I2V) |
| Voice cloning | No | Yes (ElevenLabs) |
| Infographics | No | Yes (Smart Flow) |
| Captions/ASR | Basic | 23 styles with word-level ASR sync |
| Research phase | No | Yes (Gemini 3.1 Pro) |
| 11 languages | No | Yes |

MotionMax offers significantly more features at the same price point. The per-second model protects margins while the multiplier system accommodates heavier products like cinematic and future AI UGC.

---

*This proposal is based on analysis of Opus Agent pricing ($19/300 credits, 1 credit = 1 second), MotionMax current API costs ($0.32-$1.74 per generation from generation_costs table), and projected product roadmap (AI UGC, Bar Chart Race, lip-sync, background music).*
