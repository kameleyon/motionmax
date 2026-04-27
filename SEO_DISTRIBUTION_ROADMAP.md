# MotionMax — SEO & Distribution Roadmap Checklist

**Companion to:** `SEO_DISTRIBUTION_PLAN.md` (strategy + rationale)
**Mode:** 8-week intensive sprint, then sustained-mode forever
**Last updated:** 2026-04-26
**How to use:** Tick boxes as you go. Each phase has a clear "definition of done." Don't move on until current phase is done. Distribution is repetitive — many tasks look similar; do not skip duplicates.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked (annotate why)

---

## Phase 0 — Pre-flight (Day 1, ~1 hour)

### 0.1 Inventory + decisions
- [ ] Confirm primary brand handle: **MotionMax AI** (per `SEO_DISTRIBUTION_PLAN.md` §11.1 — disambiguate from non-AI MotionMax brands)
- [ ] Decide: founder-led account vs brand-only? Recommend **both** — Jo posts as `@kameleyon` AND brand posts as `@motionmaxio`
- [ ] Choose review-prompt timing: after first export, after 5th project, or after 30-day retention milestone
- [ ] Decide on AppSumo path: yes/no/later (impacts pricing strategy)

### 0.2 Asset audit (do this before any submission)
- [ ] Verify `public/og-image.png` is the correct hero (currently bare logo — REPLACE this in §1)
- [ ] Verify `public/favicon.png` is sharp at 16×16, 32×32, 192×192
- [ ] Verify `public/apple-touch-icon.png` is 180×180
- [ ] Verify `public/manifest.json` has correct categories: productivity, multimedia, entertainment
- [ ] Test OG preview with https://www.opengraph.xyz/ — confirm it renders correctly on Twitter, LinkedIn, Slack, Discord previews

### 0.3 Tools to set up (free tier is enough)
- [ ] Ahrefs Webmaster Tools (free) — see your own backlinks, broken links
- [ ] SEMrush free account — keyword tracking
- [ ] Notion or spreadsheet for tracking submissions, outreach, results

### Phase 0 Definition of Done
Brand naming locked. OG image flagged for replacement. Tracking spreadsheet created.

---

## Phase 1 — Week 1: Foundation

The "click-and-fill-forms" week. None of this is engineering; almost all can be done in one or two long sessions.

### 1.1 OG image redesign (highest-priority single asset)
- [ ] Open Figma / Canva
- [ ] Create 1200×630 hero showing the editor UI with a real video preview frame visible
- [ ] Add headline: **"AI Video Generator — Turn Text Into Cinematic Videos"**
- [ ] Add sub-headline: **"Free to start · 25+ caption styles · 11 languages"**
- [ ] Add logo + `motionmax.io` URL in bottom corner
- [ ] Use brand colors: bg `#0F1112`, accent `#2D9A8C`, gold gradient `#FF6A00 → #F59E0B → #E4C875`
- [ ] Export as `og-image.png`, replace `public/og-image.png` and `marketing/public/og-image.png`
- [ ] Bump cache-buster query: `?v=20260427` everywhere it's referenced (8 spots in `index.html`, 1 in `BaseLayout.astro`)
- [ ] Test on https://www.opengraph.xyz/ — confirm new image renders
- [ ] Also create matching square 1080×1080 for Instagram, 1500×500 for Twitter banner, 2560×1440 for YouTube banner

### 1.2 Search Console submission
- [ ] Go to https://search.google.com/search-console
- [ ] Add property → Domain: `motionmax.io` (already verified via DNS for OAuth; should auto-recognize)
- [ ] Submit sitemap: `https://motionmax.io/sitemap.xml`
- [ ] Click "Request Indexing" on homepage
- [ ] Click "Request Indexing" on `/pricing`, `/terms`, `/privacy`, `/acceptable-use`
- [ ] Set up email alerts for coverage issues
- [ ] Bookmark Performance tab; check weekly

### 1.3 Bing Webmaster Tools
- [ ] Go to https://www.bing.com/webmasters
- [ ] Sign in (use Microsoft account; can also import from Google Search Console)
- [ ] Add `motionmax.io`
- [ ] Verify (DNS, file upload, or import from GSC)
- [ ] Submit sitemap
- [ ] Bookmark dashboard

### 1.4 Google Business Profile
- [ ] Go to https://business.google.com/
- [ ] Create profile for MotionMax AI
- [ ] Category: Software Company (also add: Multimedia Production)
- [ ] Service area: Worldwide (or USA + Canada if scoping)
- [ ] Website: motionmax.io
- [ ] Phone: optional
- [ ] Hours: 24/7 (online service)
- [ ] Add 10+ photos: logo, OG image, app screenshots, founder pic if comfortable
- [ ] Verify (postcard or phone — postcard takes 5–14 days)
- [ ] Once verified: add description (750 chars), add posts (think mini-blog), add Q&A

### 1.5 Social handle reservation
- [ ] Twitter/X: @motionmaxio (already used in meta — verify ownership) + try @motionmaxai
- [ ] LinkedIn: create company page **MotionMax AI**
- [ ] YouTube: create channel `@motionmax` or `@motionmaxai`
- [ ] TikTok: @motionmaxai or @motionmax_ai
- [ ] Instagram: @motionmax.ai or @motionmaxai
- [ ] Threads: same handle as Instagram (auto-linked)
- [ ] Reddit: u/motionmaxai (for occasional brand replies; founder uses personal account for organic)
- [ ] Pinterest: motionmaxai (visual platform; AI video stills perform there)

### 1.6 Branded social content seeded
- [ ] Twitter bio: "AI video generator — turn text into cinematic videos. Free to start. ✨ motionmax.io"
- [ ] Twitter pinned tweet: 30-second demo video + product link
- [ ] LinkedIn About: full description
- [ ] YouTube banner: matches OG visual style
- [ ] YouTube About: company description + link
- [ ] TikTok bio: 80 chars, link in bio to motionmax.io

### 1.7 Foundation directory submissions (do all in one afternoon)
- [ ] Futurepedia (https://www.futurepedia.io/submit-tool)
- [ ] TheresAnAIForThat (https://theresanaiforthat.com/submit/)
- [ ] AI Tool Hunt (https://www.aitoolhunt.com/submit-tool)
- [ ] ToolsForHumans (https://www.toolsforhumans.ai/submit)
- [ ] Insidr.ai (https://www.insidr.ai/submit)
- [ ] AItoolsclub
- [ ] Toolify.ai
- [ ] AIxploria
- [ ] AllThingsAI
- [ ] Topai.tools
- [ ] AIDirectory.org
- [ ] AIcyclopedia
- [ ] AItoolsdir
- [ ] Fazier
- [ ] AIAssistantsHub
- [ ] AlphabetAI

### Phase 1 Definition of Done
OG image replaced. Search Console + Bing live and crawling. Google Business Profile pending verification. All social handles claimed and seeded. 15+ AI directories submitted (allow 1–2 weeks for listings to appear).

---

## Phase 2 — Week 2: Authority Layer

Move from AI-tool directories to higher-DA SaaS / general directories.

### 2.1 Major SaaS directories
- [ ] G2 (https://www.g2.com/) — claim/create profile, complete all fields, add screenshots
- [ ] Capterra (https://www.capterra.com/) — claim/create profile (Capterra owns GetApp + Software Advice — one form often gets all three)
- [ ] GetApp — verify listing appeared from Capterra submission
- [ ] Software Advice — verify listing appeared from Capterra submission
- [ ] AlternativeTo (https://alternativeto.net/) — submit MotionMax as alternative to **Pictory, Synthesia, Runway, Lumen5, Pika, InVideo, Kapwing**
- [ ] Slant (https://www.slant.co/) — list in "best AI video generators" topic
- [ ] StackShare (https://stackshare.io/) — add MotionMax + list our tech stack
- [ ] Trustpilot — claim profile, request first 5 reviews from existing users
- [ ] BetaList (https://betalist.com/) — even if past beta, listing welcome
- [ ] SaaSHub (https://www.saashub.com/)
- [ ] Top Apps (https://topapps.ai/)

### 2.2 Comparison pages on our own site
- [ ] Add `marketing/src/pages/alternatives/index.astro` — list of "MotionMax vs [X]" landing pages
- [ ] Create comparison data fixture for these competitors: pictory, synthesia, runway, lumen5, pika, invideo, kapwing, descript
- [ ] Wire `/alternatives/[slug].astro` template (programmatic SEO scaffolding for §6)

### 2.3 Niche AI video tool directories
- [ ] Search "AI video generator directory" on Google — submit to top 10 results that aren't already in §1.7
- [ ] Submit to https://www.aitoolsdirectory.com
- [ ] Submit to https://aitoolskit.com
- [ ] Submit to https://www.aitoolnet.com
- [ ] Submit to https://www.aitooldex.com
- [ ] Submit to TopApps.ai
- [ ] Submit to Promptly.com tools section
- [ ] Submit to GodOfPrompt.ai
- [ ] Submit to AI-Powered.tools
- [ ] Submit to https://discoverai.tools

### 2.4 Reddit organic engagement (begin)
- [ ] Set up Reddit account (use personal for trust, brand for occasional brand replies)
- [ ] Subscribe to: r/artificial, r/ChatGPT, r/AIVideo, r/SaaS, r/Entrepreneur, r/sidehustle, r/ContentCreators, r/NewTubers, r/tiktokers
- [ ] Comment helpfully on 10 threads this week WITHOUT mentioning MotionMax — build account karma + visibility
- [ ] Post one "Show Reddit" style introduction in r/SideProject

### Phase 2 Definition of Done
G2/Capterra/AlternativeTo/Trustpilot live. 10+ niche directories submitted. Reddit account warmed.

---

## Phase 3 — Week 3: Content Infrastructure

Build the blog so we can ship 10 launch posts.

### 3.1 Blog setup on the marketing site
- [ ] Create Astro Content Collection at `marketing/src/content/blog/`
- [ ] Define schema in `marketing/src/content.config.ts` with: title, description, pubDate, updatedDate, author, cover, tags, draft
- [ ] Create `marketing/src/pages/blog/index.astro` — list page with filtering by tag
- [ ] Create `marketing/src/pages/blog/[slug].astro` — single post template with TOC, related posts, share buttons
- [ ] Create `marketing/src/pages/blog/tags/[tag].astro` — tag landing pages
- [ ] Create `marketing/src/pages/blog/rss.xml.ts` — RSS feed
- [ ] Add `/blog` to `marketing/public/sitemap.xml` (and update `lastmod` weekly when posting)
- [ ] Add internal links from product pages to blog (e.g., "Want to learn more? Read our guide.")
- [ ] Style matches brand (use existing `BaseLayout.astro`)

### 3.2 SEO essentials per post
- [ ] Per-post unique title + meta description
- [ ] Per-post `og:image` (template: brand bg + post title text + cover photo)
- [ ] JSON-LD `Article` schema with author, datePublished, dateModified, headline, image, publisher
- [ ] Internal links to product, pricing, signup
- [ ] H1 → H2 → H3 hierarchy (not skipping levels)
- [ ] Alt text on every image
- [ ] Lazy-load images below fold

### 3.3 First 3 launch posts (write + publish this week)
- [ ] **Post 1: "How to Make a Cinematic AI Video From Text in Under 5 Minutes"** — 1500 words, screenshots from app, target keyword "how to make AI video from text"
- [ ] **Post 2: "MotionMax Review 2026: Honest Take After 100 Videos"** — founder-written, screenshots, target keyword "motionmax review"
- [ ] **Post 3: "7 Best AI Video Generators in 2026 (Honest Comparison)"** — listicle, target keyword "best AI video generator 2026"

### 3.4 Sitemap update
- [ ] Add blog index URL
- [ ] Add each new post URL
- [ ] Bump `lastmod`
- [ ] Re-submit to Search Console + Bing

### Phase 3 Definition of Done
Blog infrastructure shipped. 3 posts live and indexed. Internal linking from product to blog established.

---

## Phase 4 — Week 4: Comparison Content + Outreach Begin

### 4.1 Five comparison posts
- [ ] **Post 4: "Pictory vs MotionMax: Which AI Video Tool Is Right For You in 2026?"**
- [ ] **Post 5: "Synthesia vs MotionMax: Comparison Guide"**
- [ ] **Post 6: "Lumen5 Alternative: Why Creators Are Switching to MotionMax"**
- [ ] **Post 7: "Runway Alternative for Explainer Videos"**
- [ ] **Post 8: "InVideo vs MotionMax: Honest Comparison"**

Each post: 1500 words, real comparison table, real screenshots, includes `Article` JSON-LD + `Product` review JSON-LD where applicable.

### 4.2 Cold outreach to AI newsletters
- [ ] Send to Ben's Bites via "submit a tool" form
- [ ] Send to The Rundown AI tools section
- [ ] Cold email Superhuman AI editor
- [ ] Cold email TLDR AI editor
- [ ] Cold email AI Breakfast editor
- [ ] Cold email The Neuron editor
- [ ] Cold email Mindstream editor
- [ ] Cold email AI Tool Report editor

Use template from `SEO_DISTRIBUTION_PLAN.md` §9.1. Track replies in spreadsheet.

### 4.3 YouTube creator outreach
- [ ] Compile pitch package: 60-second Loom demo + free unlimited access offer + 1-paragraph elevator pitch
- [ ] Email Matt Wolfe (sponsorship inquiry email on his website)
- [ ] Email AI Andy
- [ ] Email Theoretically Media
- [ ] Email MattVidPro AI (most aligned — AI video specifically)
- [ ] Email The AI Advantage
- [ ] Email Skill Leap AI
- [ ] Email All About AI

### 4.4 Reddit (continue building presence)
- [ ] Post in r/SaaS: "I built an AI video generator that uses any LLM you want via OpenRouter — feedback wanted"
- [ ] Comment helpfully on 10 more threads
- [ ] Reply to anyone asking about AI video tools genuinely

### Phase 4 Definition of Done
5 comparison posts live. 8 newsletters pitched. 7 YouTubers pitched. Reddit account building credibility.

---

## Phase 5 — Week 5: ProductHunt Launch Preparation

The single biggest discrete distribution event of the sprint.

### 5.1 Pre-launch (do all of this BEFORE launch day)
- [ ] Build launch supporter list — 20+ committed people who'll comment + upvote on launch day (existing users, friends, X followers, IndieHackers connections)
- [ ] Find a hunter (someone with PH following >500). Reach out via PH DM. Offer free unlimited account.
- [ ] Prepare gallery images: 6 images, 1280×720 each, showing different features
- [ ] Prepare 30-second demo video (mp4, <30MB)
- [ ] Write tagline (60 chars max): **"AI video generator — turn text into cinematic videos"**
- [ ] Write description (260 chars first day visible): clear value prop, 3 features, free tier mention
- [ ] Write maker comment (the first comment you post on your own launch — be human, share founder story)
- [ ] Schedule launch for Tuesday, Wednesday, or Thursday (Mondays are crowded; weekends are quiet)
- [ ] Schedule for 12:01 AM Pacific = full 24 hours of voting

### 5.2 Launch day execution
- [ ] 12:01 AM Pacific: hunter posts the launch
- [ ] 12:05 AM: Jo posts maker comment
- [ ] 6 AM: post launch on Twitter, LinkedIn, all socials
- [ ] All day: respond to EVERY comment within 30 min
- [ ] Reach out to launch supporters at 8 AM, noon, 4 PM with reminder
- [ ] Post launch in IndieHackers, Reddit r/SideProject, HackerNews "Show HN" (separate but same day)
- [ ] Email existing user list with launch announcement

### 5.3 Post-launch
- [ ] Day 2: thank-you post on socials with final ranking
- [ ] Day 3: send thank-you note to hunter + top 5 commenters
- [ ] Add ProductHunt badge to homepage and footer
- [ ] Add "Featured on ProductHunt" social proof

### Phase 5 Definition of Done
ProductHunt launch executed. Top-5 daily ranking ideal; top-10 acceptable. Backlink from PH (DA 92) acquired regardless of ranking.

---

## Phase 6 — Week 6: Programmatic SEO Scale-Up

### 6.1 Programmatic alternatives pages
- [ ] Build Astro template `marketing/src/pages/alternatives/[slug].astro`
- [ ] Create data file `marketing/src/data/competitors.ts` with 30 competitors (each with: name, url, logo, strengths, weaknesses, pricing summary, our differentiator)
- [ ] Template renders: hero, "What is X?" section, comparison table (features, pricing), "Why MotionMax" section, screenshot gallery, switch-CTA
- [ ] Include schema: `WebPage` + `Product` JSON-LD with comparison data
- [ ] Generate 30 pages: Pictory, Synthesia, Runway, Lumen5, Pika, Sora, Veo, InVideo, Kapwing, Descript, Wisecut, Steve.ai, ElaiAI, HeyGen, D-ID, FlexClip, Animoto, Magisto, Vyond, PowToon, GoAnimate, Doodly, RawShorts, ToonBoom, Animaker, Visme, Renderforest, FlexClip, Biteable, Promo

### 6.2 Use-case pages
- [ ] Build template `marketing/src/pages/use-cases/[slug].astro`
- [ ] Create 10 use cases: youtube-shorts, tiktok, instagram-reels, explainer-videos, marketing-videos, product-demos, training-videos, social-media-content, ads, internal-comms

### 6.3 Sitemap update
- [ ] Add all 40 new pages to sitemap
- [ ] Re-submit to Search Console
- [ ] Submit homepage for re-crawl (signals important update)

### Phase 6 Definition of Done
40+ programmatic SEO pages live. Sitemap updated. Re-submitted for indexing.

---

## Phase 7 — Week 7: Reviews + Tutorials

### 7.1 Reviews push
- [ ] Set up Trustpilot review-prompt email (sent 7 days after first export)
- [ ] Set up G2 review-prompt email (sent 30 days after signup if active)
- [ ] Manually request reviews from 20 existing power users
- [ ] Goal: 10+ reviews on Trustpilot, 5+ on G2, 3+ on Capterra by end of week

### 7.2 Final 2 launch blog posts
- [ ] **Post 9: "25 Caption Styles That Convert: A Visual Guide"** — image-heavy, super shareable
- [ ] **Post 10: "From Blog Post to Video in 10 Minutes With AI"** — tutorial, content marketers love this

### 7.3 YouTube tutorial uploads
- [ ] Tutorial 1: "MotionMax Walkthrough — Your First Video in 5 Minutes" (10 min)
- [ ] Tutorial 2: "How to Get the Best Caption Styles" (5 min)
- [ ] Tutorial 3: "Voice Cloning Tutorial" (5 min)
- [ ] Tutorial 4: "Multi-language Video Generation" (5 min)
- [ ] Tutorial 5: "From Script to Final Video — Full Process" (15 min)

Each video: SEO title, description with timestamps, end card promoting blog post + free signup, link in description to motionmax.io.

### 7.4 Founder content on X / LinkedIn
- [ ] Jo writes 5 build-in-public threads on X
- [ ] Jo writes 2 LinkedIn carousels about lessons learned

### Phase 7 Definition of Done
10 launch blog posts live. 5 YouTube tutorials live. 18+ reviews collected across G2/Capterra/Trustpilot.

---

## Phase 8 — Week 8: Hacker News + Wrap

### 8.1 Hacker News "Show HN"
- [ ] Title: **"Show HN: MotionMax — text-to-cinematic-video using whatever AI model you want"**
- [ ] Body: technical, honest, no marketing-speak. Mention OpenRouter integration as differentiator.
- [ ] Post Tuesday-Thursday 9 AM EST
- [ ] Engage every comment within 30 min for first 3 hours
- [ ] Be respectful even with negative feedback — HN is unforgiving of defensiveness

### 8.2 IndieHackers product post
- [ ] Create IndieHackers product profile
- [ ] Write founder-journey post: "How I built MotionMax in [N] months and what I learned"

### 8.3 Sustained-mode setup
- [ ] Schedule recurring weekly tasks (use existing autopost infrastructure for own brand!):
  - [ ] 1 blog post per week
  - [ ] 1 directory submission per week (always more directories)
  - [ ] 3 LinkedIn/X posts per week (auto-scheduled if possible)
  - [ ] Daily TikTok/IG/YT Shorts (via autopost feature, dogfooding)
  - [ ] 1 YouTube long-form per month
  - [ ] 8 cold emails per Friday batch
- [ ] Set up monthly check-ins for Search Console + Ahrefs metrics
- [ ] Set up review-prompt automation in app (if not done in Phase 7)

### 8.4 Sprint retrospective
- [ ] Update `SEO_DISTRIBUTION_PLAN.md` §13 success criteria with current state
- [ ] Document what worked / didn't work
- [ ] Plan next 90-day cycle: which channels to double down on, which to drop

### Phase 8 Definition of Done
Hacker News post executed. IndieHackers profile live. Sustained-mode operations defined and scheduled. Sprint retrospective done.

---

## Phase 9 — Sustained Mode (Forever)

This is not a phase that ends. Track recurring tasks separately. Goal is accumulation, not completion.

### 9.1 Weekly recurring tasks
- [ ] Monday: write next blog post (4 hrs)
- [ ] Tuesday: scheduled LinkedIn post + X thread (1 hr)
- [ ] Wednesday: 1 directory submission (30 min) + 1 outreach email batch (30 min)
- [ ] Thursday: respond to mentions, comment on Reddit, engage in discussions (30 min)
- [ ] Friday: 8 cold emails to newsletters/creators (1 hr) + week metrics review (30 min)

### 9.2 Monthly recurring tasks
- [ ] First Monday: review Search Console performance, identify ranking opportunities
- [ ] Second Monday: review Ahrefs backlinks, follow up on lost backlinks
- [ ] Third Monday: 1 YouTube long-form video
- [ ] Fourth Monday: pitch to 1 podcast, secure podcast appearance every 2 months

### 9.3 Quarterly recurring tasks
- [ ] Quarter end: full SEO audit (technical + content + backlink)
- [ ] Quarter end: refresh top 5 ranking blog posts (Google rewards updates)
- [ ] Quarter end: review pricing page meta + comparison pages for accuracy
- [ ] Quarter end: re-submit sitemap if structure changed

### Phase 9 Definition of Done
Never. This is the work. The flywheel must keep turning or rankings decay.

---

## Master Timeline at a Glance

| Week | Focus | Key Deliverables |
|---|---|---|
| **1** | Foundation | OG image, Search Console, Bing, GBP, social handles, 15 directories |
| **2** | Authority | G2/Capterra/AlternativeTo, niche directories, Reddit warmup |
| **3** | Blog launch | Astro blog infra, 3 first posts |
| **4** | Comparisons | 5 vs-competitor posts, 8 newsletter pitches, 7 YouTube pitches |
| **5** | ProductHunt | Launch preparation + execution |
| **6** | Programmatic SEO | 40+ template-generated landing pages |
| **7** | Reviews + Tutorials | Reviews push, 2 final blog posts, 5 YouTube tutorials |
| **8** | HN + Sustained mode | Show HN, IndieHackers, sustained-mode operations |
| **9+** | Forever | Compound interest |

---

## Resumption instructions

If you walk into this cold:
1. Read `SEO_DISTRIBUTION_PLAN.md` first (rationale), then this checklist (status)
2. `git log --oneline | head -50` to see recent commits
3. Check Search Console "Performance" tab for current branded search impressions and clicks
4. Check Ahrefs Webmaster Tools for current backlink count
5. Find the first un-ticked phase and start there
6. Do NOT touch on-page meta — it's already excellent (per `SEO_DISTRIBUTION_PLAN.md` §1.1)
7. Do NOT skip directory submissions — they look repetitive but they ARE the work
8. Distribution is a job, not a project. There is no "done" past Phase 8.

---

**End of checklist.** Tick boxes as you go. Some tasks (e.g., directory submissions) feel like grunt work — that's because they ARE the work. SEO is consistent grinding, not clever hacks. The compounding kicks in around week 8–12; ranking improvements appear before then but don't show in traffic until the flywheel catches.
