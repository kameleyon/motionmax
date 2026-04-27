# MotionMax — SEO & Distribution Plan

**Document owner:** Jo (kameleyon)
**Last updated:** 2026-04-26
**Status:** Approved direction, awaiting execution
**Audience:** Future Jo, future AI assistants, any contractor handling marketing/SEO. Read top to bottom; no other context required.
**Companion docs:** `SEO_DISTRIBUTION_ROADMAP.md` (tickable execution checklist), `AUTOPOST_PLAN.md`, `NATIVE_MOBILE_PLAN.md`

This document is the single source of truth for getting MotionMax discoverable: searchable on Google, ranked for relevant keywords, present in AI-tool directories, mentioned in AI/creator newsletters and YouTube reviews, and showing as a real branded entity (not "UNKNOWN") wherever the product or its API calls are surfaced. Domain age is 4 months as of writing — past Google's "sandbox" but with effectively zero authority. The path from here to brand-discoverable is execution work, not on-page meta tweaking.

---

## 1. The actual diagnosis (preserve this; do not relitigate)

### 1.1 What's NOT the problem
Already shipped, do not redo:
- Title, description, keywords meta tags on `index.html` (app) and `BaseLayout.astro` (marketing)
- Open Graph tags (og:type, og:title, og:description, og:image, og:image:width/height, og:site_name, og:locale)
- Twitter Card tags (summary_large_image, @motionmaxio handle)
- `schema.org/SoftwareApplication` JSON-LD with full feature list, offers, screenshot
- `schema.org/Organization` JSON-LD with sameAs links
- `schema.org/BreadcrumbList` JSON-LD on legal pages
- `robots.txt` with proper allow/disallow per bot
- `sitemap.xml` with priorities + image sitemap markup
- `manifest.json` for PWA
- Canonical URL + hreflang
- `llms.txt` for AI crawlers
- Favicon + apple-touch-icon

The on-page technical SEO is **above industry average**. It is not the bottleneck.

### 1.2 What IS the problem (in order of impact)

| # | Problem | Impact | Why |
|---|---|---|---|
| 1 | **Zero backlink authority** | Catastrophic | Google's algorithm treats unlinked sites as untrusted. A 4-month-old domain with zero quality inbound links cannot rank for "motionmax" against established brands of the same name, regardless of meta perfection. |
| 2 | **OG image is a bare logo, not a product shot** | Severe | Every share on Twitter/LinkedIn/Slack/Discord uses this as the visual. Bare logo = "I have no idea what this does" = no clicks = no traffic. The single highest-leverage asset to fix. |
| 3 | **Property never submitted to Search Console** | Severe | Sitemap exists but Google has not been *told* to crawl it. Domain verification was done for OAuth branding, not for indexing. Indexing submission is a separate step. |
| 4 | **No directory presence** | Severe | AI-tool buyers search via directories: ProductHunt, Futurepedia, TheresAnAIForThat, AlternativeTo, G2. None list MotionMax. Each missing listing is missing traffic AND missing backlink authority. |
| 5 | **No content marketing** | Severe-Compounding | Long-tail SEO traffic ("how to make AI video from text", "Pictory alternatives", etc.) is 10–100× the brand-name search volume. With no blog posts targeting these queries, every visitor is paid or word-of-mouth. |
| 6 | **No social proof loop** | Major | Reviews on G2/Capterra/Trustpilot don't just provide social proof — they're high-DA backlinks AND search results that show up on brand searches. |
| 7 | **No PR / influencer outreach** | Major | Ben's Bites (350k subs), The Rundown AI (700k subs), Matt Wolfe (1M YouTube subs), AI Andy, Theoretically Media — these are the AI-tools-discovery layer. Zero exposure. |
| 8 | **OpenRouter "UNKNOWN" badge** | Cosmetic but signals amateurism | Worker calls to OpenRouter didn't set `HTTP-Referer` and `X-Title` headers. Fixed in this session. Pushes on next deploy. |
| 9 | **Brand name collision** | Structural | "MotionMax" exists as fitness equipment, automotive parts, video gear distributor. To win on a generic search, you need to either dominate "motionmax ai" / "motionmax io" specifically OR build enough authority to outrank decade-old brands on the bare term. The first is achievable in 90 days; the second is a 12+ month project. |

### 1.3 The execution thesis
**Distribution is a job, not a one-time fix.** This document and its roadmap describe an 8-week intensive sprint to go from invisible to discoverable, followed by sustained 3–5 hours/week of compounding work. There is no "set and forget." Either Jo allocates the time, hires it, or accepts MotionMax stays invisible regardless of product quality.

---

## 2. Goals and success metrics

### 2.1 8-week intensive sprint goals
- [ ] First-page Google ranking for **"motionmax ai"** and **"motionmax video"** (achievable; low competition)
- [ ] Top 3 ranking for **"motionmax.io"** (gimme; literally our domain, just need indexing)
- [ ] First-page ranking for at least 3 long-tail content queries (e.g., "Pictory alternative", "AI explainer video tool", "text to cinematic video")
- [ ] 50+ Domain Authority backlinks (DA 30+) — directories, reviews, mentions
- [ ] 10+ AI-tool directory listings (ProductHunt, Futurepedia, etc.)
- [ ] 1 ProductHunt launch with top-5 daily ranking
- [ ] 1+ niche AI newsletter mention
- [ ] 5+ YouTube creators reviewing or mentioning the tool
- [ ] OG image redesigned to a product hero shot
- [ ] OpenRouter showing "MotionMax" not "UNKNOWN"
- [ ] Search Console + Bing Webmaster reporting clean indexing
- [ ] Google Business Profile live
- [ ] Branded knowledge panel appearing on "motionmax" branded queries

### 2.2 Sustained-mode goals (post-sprint)
- [ ] 1 blog post per week on long-tail keywords
- [ ] 1 directory submission per week (always more directories)
- [ ] 3 social posts per week (LinkedIn, X, TikTok)
- [ ] 1 YouTube demo or tutorial per month
- [ ] Backlinks growing 10–20 per month organically
- [ ] Organic search traffic doubling quarter over quarter

### 2.3 What success does NOT look like
- Outranking "MotionMax" automotive parts brand on a bare term in year 1 — unrealistic and not the goal
- Going viral on TikTok and never having to do SEO again — viral is unreliable; SEO is a flywheel
- Ranking for "AI video generator" on page 1 in year 1 — Synthesia, Pictory, Runway have decade-long head starts. Long-tail is the wedge.

---

## 3. The four-pillar strategy

### 3.1 Pillar A: Foundation (Week 1, one-time)
Stop the bleeding. Submit, register, and claim everything that's free and instant. This is mostly clicking, not engineering.

- Search Console submission + sitemap ping
- Bing Webmaster Tools submission
- Google Business Profile creation
- OG image redesign (the single biggest visual asset)
- Twitter/X handle claim + bio + pinned post
- LinkedIn company page
- YouTube channel placeholder + banner
- Product directories (ProductHunt account, Futurepedia submit, TheresAnAIForThat submit)

### 3.2 Pillar B: Authority (Weeks 2–6, ongoing)
Build the backlink graph. Every backlink is a vote in Google's algorithm AND a discoverability node for humans.

- Directory submissions (deep list in `SEO_DISTRIBUTION_ROADMAP.md` §3)
- Review platform listings (G2, Capterra, Trustpilot, GetApp)
- Comparison/alternative listings (AlternativeTo, Slant, StackShare)
- Niche AI tool directories (15+ targets)
- ProductHunt launch (the single biggest discrete event)
- AppSumo conversation (potential firehose)

### 3.3 Pillar C: Content (Weeks 2–8, ongoing forever)
Long-tail SEO is the only sustainable discovery channel that doesn't require constant payment. Every blog post is a perpetual traffic asset.

- Blog infrastructure on the marketing site
- 10 launch articles targeting specific keywords
- Programmatic SEO at scale (template-driven pages for "[X] alternative", "[X] vs [Y]", "AI [thing] generator")
- Tutorial and use-case content
- Video tutorials uploaded to YouTube with blog post embeds (compound SEO + YouTube SEO)

### 3.4 Pillar D: Influence (Weeks 4–8, ongoing)
You don't out-rank Synthesia. You ride trusted voices that already have audiences.

- AI newsletter outreach (Ben's Bites, The Rundown AI, Superhuman AI, TLDR AI, AI Breakfast)
- YouTube creator outreach (Matt Wolfe, AI Andy, Theoretically Media, MattVidPro)
- Reddit organic engagement (r/artificial, r/ChatGPT, r/AIVideo, r/Entrepreneur, r/SaaS)
- HackerNews "Show HN" launch
- IndieHackers product post
- TikTok founder content (Jo posting from his own account, made with MotionMax — proof + meta)

---

## 4. The OG image fix (highest-leverage single asset)

**Current state:** A 1200×630 image that is just the MotionMax logo on white background. Verified by reading `public/og-image.png` directly. This is the asset displayed every time anyone shares any URL on the domain.

**What it should be:** A 1200×630 hero shot showing:
- Product UI (the editor with a real video preview visible)
- Headline: "AI Video Generator — Turn Text Into Cinematic Videos"
- Sub-headline: "Free to start · 25+ caption styles · 11 languages"
- Logo + URL in a corner
- Brand colors (#0F1112 bg, #2D9A8C accent, gold gradient for premium feel matching the new dashboard banner)

**Why this matters more than any other single asset:** Each share = one impression. Bare logo gets ~0.5% click-through. Designed hero shot gets ~5–8% CTR. **10–16× multiplier on every single share for life.** Over 12 months and tens of thousands of shares (autopost will multiply this), the math is brutal.

**Production:** 1 hour of design work in Figma or Canva. Does not need to be perfect — it just needs to clearly say what the product is. Variants: a square 1080×1080 for Instagram, a landscape 1500×500 for Twitter banner, a 2560×1440 for YouTube banner. All from the same template.

---

## 5. Search Console + Bing Webmaster: the 30-minute fix Jo can do today

These two registrations move the needle more than any code change.

### 5.1 Google Search Console
1. Go to https://search.google.com/search-console
2. Add property → Domain: `motionmax.io` (Jo already verified this for OAuth — should be auto-recognized)
3. Submit sitemap: `https://motionmax.io/sitemap.xml`
4. Click "Request Indexing" on the homepage URL
5. Set up email alerts for coverage issues
6. Within 24–72 hours: indexing report shows discovered pages

### 5.2 Bing Webmaster Tools
1. Go to https://www.bing.com/webmasters
2. Sign in with Microsoft account (or Google import — Bing accepts Google Search Console import)
3. Add `motionmax.io`
4. Submit sitemap
5. Bing tracks for DuckDuckGo, Yahoo, Ecosia — covers ~10% of search market

### 5.3 What to watch for after submission
- Search Console "Indexed pages" count climbing over 7 days
- Search Console "Performance" tab showing first impressions for branded terms
- Any "Coverage errors" — typically caused by canonical conflicts or robots disallow misconfigurations
- "Mobile Usability" warnings — fix any flagged
- "Core Web Vitals" — should already be green from existing perf work

---

## 6. Backlink targets (do not skip; this IS the work)

Sequenced from highest-impact / lowest-effort to longest-lead. Each is in the roadmap as a checkbox. Domain Authority (DA) scores from Moz/Ahrefs as approximate guides.

### 6.1 Universal AI tool directories (week 1–2)
| Directory | DA | Effort | Notes |
|---|---|---|---|
| ProductHunt | 92 | 1 day prep + launch day | Use Tuesday-Thursday launch. Top 5 of the day = thousands of visitors. |
| Futurepedia | 65 | 1 hour | Submit form, ~7 day review |
| TheresAnAIForThat | 60 | 1 hour | Submit form, instant listing |
| AI Tool Hunt | 50 | 30 min | |
| ToolsForHumans | 45 | 30 min | |
| Insidr.ai | 40 | 30 min | |
| AItoolsclub | 40 | 30 min | |
| Toolify.ai | 50 | 30 min | |
| AIxploria | 45 | 30 min | |
| AllThingsAI | 40 | 30 min | |
| Topai.tools | 40 | 30 min | |
| AIDirectory.org | 35 | 30 min | |
| AIcyclopedia | 35 | 30 min | |
| AItoolsdir | 30 | 30 min | |
| Fazier | 35 | 30 min | |

**Estimated total time: 1–2 days of submission work. Estimated total backlinks gained: 12–15 from DA 30+ sites.**

### 6.2 SaaS / general software directories (week 2–3)
| Directory | DA | Effort | Notes |
|---|---|---|---|
| G2 | 92 | 2 hours | Free listing; reviews unlock more visibility |
| Capterra | 92 | 2 hours | Free; pay-per-lead optional |
| GetApp | 90 | 2 hours | Capterra-owned; one form gets you both |
| Software Advice | 90 | 1 hour | Same network |
| AlternativeTo | 90 | 1 hour | Critical — list as alternative to Pictory, Synthesia, Runway, Lumen5, Pika |
| Slant | 80 | 1 hour | Comparison site |
| StackShare | 75 | 30 min | More B2B-focused |
| Trustpilot | 92 | 1 hour | Then get 5–10 review submissions |
| SaaSHub | 50 | 30 min | |
| BetaList | 70 | 1 hour | Best for early-stage; we're past beta but still works |
| Ycombinator's Show HN | 90 | 2 hours | One-shot; needs strong launch post |
| IndieHackers | 75 | 1 hour | Founder-friendly community |

### 6.3 Niche video / creator tool directories (week 3–4)
| Directory | DA | Effort | Notes |
|---|---|---|---|
| VideoMakerFX list | 50 | 30 min | |
| Creators.directory | 40 | 30 min | |
| Tools for Creators | 45 | 30 min | |
| Rephonic | 40 | 30 min | |
| TopApps.ai | 50 | 30 min | |
| AI Video Tools list (various) | varies | 1 hour | Search "AI video generator list" — submit to top 10 results |

### 6.4 The big-leverage single events
- **ProductHunt launch** — needs prep (hunter, gallery images, demo video, 3 launch-day comments queued from supporters). Plan separately.
- **Show HN** — needs honest, technical, no-marketing-speak post. "Show HN: I built a text-to-cinematic-video tool that runs on your own AI providers via OpenRouter."
- **AppSumo** — lifetime deal listing. Massive traffic + irreversible. Only do if pricing strategy can absorb a $59 LTD.

---

## 7. Content strategy (the SEO compound interest)

### 7.1 Why content matters more than any other channel long-term
- Each blog post = a permanent traffic asset that ranks for years
- Long-tail keyword volume (3+ word queries) > 70% of all search
- Content posts = content for newsletter, social, YouTube embed — multi-purpose
- Internal linking from posts to product pages distributes authority site-wide

### 7.2 Keyword tiers (target each)

**Tier 1: Brand-defense (must-rank for these)**
- "motionmax" → blog post: "What is MotionMax? Complete Guide to AI Video Generation"
- "motionmax ai" → product page (existing)
- "motionmax io" → product page (existing)
- "motionmax review" → blog post: "MotionMax Review 2026: Honest Take After 100 Videos" (founder-written)
- "motionmax pricing" → pricing page (existing) + blog "MotionMax Pricing Explained"
- "motionmax vs [competitor]" → comparison posts (10 of these)

**Tier 2: Mid-tail commercial intent**
- "AI video generator from text" → ranking listicle
- "AI cinematic video tool" → product page + blog post
- "Pictory alternative" → comparison post (high commercial intent)
- "Synthesia alternative" → comparison post
- "Lumen5 alternative" → comparison post
- "Runway alternative for explainers" → comparison post
- "best AI video generator 2026" → roundup post (we list ourselves first, honestly)
- "AI explainer video maker" → product page
- "text to video AI free" → blog post + free tier landing
- "AI Reels generator" → product page

**Tier 3: Long-tail informational**
- "how to make AI video from a script"
- "how to create cinematic video without filming"
- "what is the best AI for caption styling"
- "how to clone your voice for video narration"
- "AI video for YouTube Shorts tutorial"
- "AI video for TikTok tutorial"
- "cheapest AI video generator with voice cloning"
- "AI video generator with multilingual support"

### 7.3 The 10 launch posts (write these in 8-week sprint)
Sized for ~1500 words each. AI-assisted draft, human polish, screenshots from the actual app.

1. **"How to Make a Cinematic AI Video From Text in Under 5 Minutes"** — tutorial, target "how to make AI video from text"
2. **"Pictory vs MotionMax: Which AI Video Tool Is Right For You in 2026?"** — comparison, target "Pictory alternative"
3. **"Synthesia vs MotionMax: Comparison Guide"** — same shape
4. **"7 Best AI Video Generators in 2026 (Honest Comparison)"** — roundup, list MotionMax in honest position
5. **"Voice Cloning for Video Narration: Complete Guide"** — feature-driven, target voice cloning queries
6. **"AI Video Generation for YouTube Shorts: Step-by-Step"** — tutorial + drives autopost feature usage
7. **"How to Create Multilingual Video Content With AI"** — feature-driven
8. **"25 Caption Styles That Convert: A Visual Guide"** — listicle, image-heavy, very shareable
9. **"AI Explainer Videos: When to Use Them and How to Make Them"** — funnel-top informational
10. **"From Blog Post to Video in 10 Minutes With AI"** — tutorial, content marketers love this

### 7.4 Programmatic SEO (week 6+)
After 10 articles are live and indexed, scale with template pages. Each page = one programmatically-generated landing for a long-tail query.

- **`/alternatives/[competitor]`** — auto-generate 30 pages: Pictory, Synthesia, Runway, Lumen5, Pika, Sora (when public), Veo, InVideo, Kapwing, etc. Each page reuses the same template with a single competitor variable: feature comparison table, pricing comparison, switcher CTA.
- **`/use-cases/[case]`** — 20 pages: explainer videos, social media content, YouTube Shorts, TikTok, marketing videos, product demos, etc.
- **`/integrations/[tool]`** — when API ships: Zapier, Make, Notion, Webflow, etc.

Programmatic SEO ships 50–100 pages with one template change. Each page is a long-tail landing. **Highest ROI activity once content infrastructure exists.**

### 7.5 Blog infrastructure
The marketing site (`marketing/`, Astro) needs a `/blog` route + `[slug].astro` template + an MDX content collection. Astro Content Collections is the standard pattern: posts as `.md` or `.mdx` in `src/content/blog/`, frontmatter with title/description/date/author/cover, single template renders all. Easy to add. ~1 day of work.

---

## 8. Social proof channels

### 8.1 Reviews
- **Trustpilot**: claim profile, request reviews from existing users via email
- **G2**: claim profile, request reviews from existing users (G2 reviews directly affect "best video generator" Google snippets)
- **Capterra**: same
- **Product Hunt** (post-launch): comments and upvotes count as reviews

Tactic: After every successful project export, surface a non-blocking "Loved MotionMax? 30-second review on G2" prompt with a direct link. 1–2% conversion rate is enough to get to 25 reviews in 3 months.

### 8.2 Social presence
- **Twitter/X (@motionmaxio)** — bio, pinned post, 3 posts/week
- **LinkedIn company page** — official presence, posts ~1×/week, content from blog
- **YouTube (@motionmax)** — channel banner, 5 demo videos in first month, 1/month sustained
- **TikTok (@motionmax)** — daily posting via autopost (the meta loop: dogfood the autopost feature on the brand's own TikTok)
- **Instagram (@motionmax)** — same as TikTok via autopost

### 8.3 Founder-led content (highest-trust channel)
Jo posting from `@kameleyon` or `@josinsidevoice` accounts:
- Build-in-public threads on X
- Process videos on TikTok
- LinkedIn carousel posts about lessons learned
- Founder's perspective gets 10× the engagement of brand account posts in the AI tools space

---

## 9. PR + influencer outreach

### 9.1 Niche AI newsletters (highest ROI)
Each one sponsorship slot is $200–2000; **organic mentions are free if the product is interesting enough.**

| Newsletter | Subscribers | Outreach approach |
|---|---|---|
| Ben's Bites | 350k | Pitch via "submit a tool" form; needs strong demo video |
| The Rundown AI | 700k+ | Pitch via tools section |
| Superhuman AI | 800k+ | High bar; needs unique angle |
| TLDR AI | 250k | Cold email with one-line pitch |
| AI Breakfast | 100k | Cold email |
| The Neuron | 250k | Cold email |
| Mindstream | 150k | Cold email |
| AI Tool Report | 100k | Cold email |

**Cold email template** (use, modify, send 8 of these in a single afternoon):
> Subject: A new AI video tool that uses OpenRouter for any model
>
> Hi [Editor],
> 
> Built MotionMax — text-to-cinematic-video that runs on whatever LLM/voice/image model you prefer (OpenRouter, ElevenLabs, etc.). 25+ caption styles, 11 languages, voice cloning. Live and free to try at motionmax.io.
>
> Happy to demo over Loom or send free credits for review. Either way, thought it might fit a "tools" slot.
>
> Jo

### 9.2 YouTube creators (AI tools review niche)
Send free unlimited access + a 60-second pitch video.

| Creator | Subscribers | Channel angle |
|---|---|---|
| Matt Wolfe | 1.0M | AI news + tools, weekly roundups |
| AI Andy | 200k | Practical use cases |
| Theoretically Media | 150k | Deep-dive product walkthroughs |
| MattVidPro AI | 350k | AI video specifically — most aligned |
| The AI Advantage | 250k | Tools + tutorials |
| Skill Leap AI | 150k | Tutorial-focused |
| All About AI | 200k | Reviews and use cases |

### 9.3 Reddit organic (avoid blatant promotion; provide value)
Subreddits where genuine engagement → discovery:
- r/artificial (1.4M)
- r/ChatGPT (8M+) — only on relevant threads, never pure promo
- r/AIVideo (50k) — very on-topic
- r/SaaS (200k) — share founder journey
- r/Entrepreneur (3.5M)
- r/sidehustle (2M)
- r/ContentCreators (50k)
- r/NewTubers (250k)

Rule: 9:1 give-to-ask ratio. Comment helpfully on 9 threads for every 1 thread that mentions MotionMax (and only when relevant).

### 9.4 Hacker News
- "Show HN: MotionMax — text-to-cinematic-video using whatever AI model you want"
- Post Tuesday-Thursday 9am EST
- Engage with EVERY comment in first 2 hours
- A successful Show HN = 10–50k visitors in 24 hours and DA 90 backlink

---

## 10. Mobile / native discoverability

When iOS and Android apps ship per `NATIVE_MOBILE_PLAN.md`:

### 10.1 App Store Optimization (ASO)
- Title with keyword: "MotionMax: AI Video Maker"
- Subtitle: "Text to cinematic video"
- Keywords field (iOS): "ai, video, generator, ai video, text to video, reels, shorts, ai voice, voice clone, captions, explainer"
- Description: scan-friendly, benefit-driven, social-proofed
- Screenshots: 6 custom-designed, NOT raw screenshots
- Preview video: 30-second demo
- Reviews: prompt at peak satisfaction moments (after first export)

### 10.2 Universal Links + branded search
- App Store and Play Store listings backlink to motionmax.io
- App Store/Play Store domains carry insane authority — these become the highest-DA backlinks in the entire profile
- "motionmax" branded search will surface app listings on iOS/Android device searches

---

## 11. Risks and mitigations

### 11.1 Brand-name collision permanently caps "motionmax" bare-term ranking
**Reality:** A 15-year-old fitness brand with 10k+ backlinks will hold position 1 for "motionmax" for years even with perfect execution.
**Mitigation:** Brand around **"MotionMax AI"** specifically. All ad copy, all profile names (`@motionmaxio`, `@motionmaxai` if available), all directory submissions use "MotionMax AI" as the listed name. Within 6 months, "motionmax ai" returns us as result #1 even if "motionmax" never does.

### 11.2 Spam directories hurt more than they help
**Reality:** Some directories are link farms that Google penalizes for. Submitting indiscriminately can backfire.
**Mitigation:** The §6 list above is curated to legitimate directories. Do not submit to anything with DA <30 unless it's a hyper-niche AI tools directory and you've personally checked it doesn't look like a link farm.

### 11.3 ProductHunt launch flop
**Reality:** Launch with no built-up audience can flop (bottom-half of daily ranking) and you only get one ProductHunt launch — you can't redo it.
**Mitigation:** Don't launch in week 1. Build a launch list (10+ committed supporters: existing users, X followers, friends) BEFORE launch day. Have a hunter (someone with PH following >500). Have gallery images and demo video pre-loaded. Announce launch day across all socials morning-of.

### 11.4 SEO results take 6–12 weeks even with perfect execution
**Reality:** Submitted post on Monday won't rank by Wednesday. Patience is required.
**Mitigation:** Do not measure success in weeks. Measure in 90-day windows. The directories submitted in week 1 will pay off in week 8 onward.

### 11.5 Cold outreach feels gross
**Reality:** Founders dislike sending these emails.
**Mitigation:** It's not optional. Send 8 emails per Friday, batch-style, using the template in §9.1. Replies happen, ignore the rest. Do not chase.

---

## 12. Window-closes-today resumption

If this conversation ends and Jo (or a contractor) picks it up in three months:

1. Read this document plus `SEO_DISTRIBUTION_ROADMAP.md` top to bottom
2. Run `git log --oneline | head -50` to see what's been committed since
3. Check Search Console for current indexed page count
4. Check Ahrefs / Moz / SE Ranking (free tier) for current backlink count and DA
5. Check the roadmap for tickbox state — start at the first un-ticked item
6. Verify §1.2 root causes are still the bottleneck (zero-authority, missing OG hero, no directories) before changing strategy
7. Do NOT redo on-page SEO meta — it's done. The work is distribution.

### 12.1 Files this depends on
- `marketing/src/pages/index.astro`, `marketing/src/layouts/BaseLayout.astro` — meta source of truth, do not break
- `public/sitemap.xml`, `public/robots.txt` — keep updated when blog ships
- `public/og-image.png` — **REPLACE this asset** as priority #1 of week 1
- `worker/src/services/openrouter.ts` — already fixed in this session for OpenRouter identification

### 12.2 Conversation context that matters
- Jo registered the domain in January 2026; it's 4 months old, past sandbox
- Jo's Search Console domain verification was for OAuth branding, not indexing — separate step still required
- The three brand-relevant social handles to claim: `@motionmaxio` (already in meta), `@motionmaxai` (if available), `@motionmax` (likely taken on most platforms)
- The SEO meta is already excellent; don't waste time there. Distribution is the work.

---

## 13. Success criteria

The SEO/distribution work is "done enough to compound on its own" when all are true:
1. `motionmax.io`, `motionmax ai`, `motionmax io` all rank position 1–3 on Google
2. 50+ DA-30+ backlinks in profile (verified via Ahrefs free tool)
3. Listed on 15+ AI tool directories
4. Listed on G2, Capterra, AlternativeTo, Trustpilot
5. ProductHunt launch executed, top-5 daily ranking achieved
6. 10+ blog posts live, indexed, ranking for at least 5 long-tail queries
7. 1+ niche AI newsletter mention
8. 3+ YouTube creator reviews
9. OG image is a designed product hero, not bare logo
10. Twitter, LinkedIn, YouTube, TikTok all have official branded presence with weekly content
11. OpenRouter no longer shows UNKNOWN
12. Google Business Profile live with knowledge panel appearing on brand queries

After these are true, ongoing maintenance (sustained-mode goals from §2.2) keeps the flywheel turning.

---

**End of plan.** If you're an AI assistant resuming this work, your first action is `Read` on this file plus `SEO_DISTRIBUTION_ROADMAP.md`. Then check the roadmap for the first un-ticked phase and start there. **Do not** add more meta tags. **Do not** edit `BaseLayout.astro` or `index.html` for SEO purposes — they're already solid. The work is everything outside the codebase.
