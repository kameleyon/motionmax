/**
 * Pre-made templates for workspace modes.
 * Each template provides sample content that users can load to test immediately.
 */

export interface WorkspaceTemplate {
  id: string;
  label: string;
  description: string;
  content: string;
}

export const DOC2VIDEO_TEMPLATES: WorkspaceTemplate[] = [
  {
    id: "product-demo",
    label: "Product Demo",
    description: "Showcase a product's features and benefits",
    content: `Introducing TaskFlow Pro — the all-in-one project management tool built for modern teams.

Key Features:
1. Smart Task Assignment: AI automatically suggests the right team member for each task based on workload and expertise.
2. Real-Time Collaboration: Edit documents, share files, and comment in real-time without switching apps.
3. Visual Dashboards: Track project progress with customizable Kanban boards, Gantt charts, and burndown charts.
4. Integrations: Connect with Slack, GitHub, Figma, and 200+ other tools your team already uses.

Pricing starts at $12/month per user with a 14-day free trial. No credit card required.

Join 50,000+ teams who've already made the switch to TaskFlow Pro.`,
  },
  {
    id: "educational-explainer",
    label: "Educational Explainer",
    description: "Break down a complex topic into simple visuals",
    content: `How Does Photosynthesis Work?

Photosynthesis is the process by which plants convert sunlight, water, and carbon dioxide into glucose and oxygen.

Step 1 — Light Absorption: Chlorophyll in plant leaves absorbs sunlight, primarily red and blue wavelengths.

Step 2 — Water Splitting: The absorbed light energy splits water molecules (H₂O) into hydrogen and oxygen.

Step 3 — Carbon Fixation: The plant uses hydrogen and carbon dioxide (CO₂) from the air to produce glucose (C₆H₁₂O₆).

Step 4 — Oxygen Release: Oxygen is released as a byproduct through tiny pores called stomata.

In summary, plants essentially convert light energy into chemical energy stored in sugar molecules, while releasing the oxygen we breathe.`,
  },
  {
    id: "social-media-teaser",
    label: "Social Media Teaser",
    description: "Short, engaging content for social platforms",
    content: `🚀 3 Productivity Hacks That Changed Everything

Hack #1: The 2-Minute Rule
If a task takes less than 2 minutes, do it immediately. Stop adding tiny tasks to your to-do list — just knock them out.

Hack #2: Time Blocking
Schedule every hour of your day, including breaks. When everything has a slot, nothing falls through the cracks.

Hack #3: The "One Thing" Method
Each morning, ask: "What's the ONE thing that would make everything else easier?" Do that first.

Try these for one week and watch your productivity transform. Follow for more tips!`,
  },
];

export const STORYTELLING_TEMPLATES: WorkspaceTemplate[] = [
  {
    id: "startup-journey",
    label: "Startup Journey",
    description: "Entrepreneurial story of building a company",
    content: `A young software developer quits their stable corporate job to pursue an idea: a platform that connects local farmers directly with restaurants. The first year is brutal — no funding, no users, and mounting credit card debt. But one pivotal meeting with a Michelin-star chef changes everything. The chef becomes the first customer and advocate. Word spreads through the restaurant community. By year three, the platform serves 2,000 restaurants across 15 cities. The story explores the emotional highs and lows, the moment of near-bankruptcy, and the lesson that success often comes from solving one person's problem exceptionally well.`,
  },
  {
    id: "documentary-style",
    label: "Documentary",
    description: "Informative narrative about a topic",
    content: `The story of how a small island nation in the Pacific became the world's first fully renewable energy country. Starting from 2015, when 95% of their electricity came from diesel generators shipped across the ocean, community leaders made a bold decision. Solar panels were installed on every rooftop. Tidal energy generators were placed along the coast. Battery storage systems were built underground. By 2025, the island achieved 100% renewable energy — saving $4M annually in fuel costs and creating 500 new jobs. Now other island nations are following their blueprint.`,
  },
  {
    id: "brand-story",
    label: "Brand Story",
    description: "Origin story for a brand or product",
    content: `It started in a garage in Portland, Oregon, 2019. Two best friends who shared a love for specialty coffee and sustainable living decided the world didn't need another coffee brand — it needed a better one. They sourced beans directly from three family farms in Colombia, paying 3x the fair trade price. Every bag was packaged in fully compostable materials. Their first 100 bags sold out in 48 hours through word of mouth alone. Three years later, BeanBridge Coffee ships to 40 countries, plants a tree for every bag sold, and has helped their farming partners build a school and medical clinic.`,
  },
];

export const SMARTFLOW_TEMPLATES: WorkspaceTemplate[] = [
  {
    id: "market-data",
    label: "Market Analysis",
    description: "Turn market data into visual insights",
    content: `Q4 2025 E-Commerce Market Report

Global e-commerce revenue: $6.3 trillion (up 8.4% YoY)
Mobile commerce share: 72.9% of all online sales
Top growing categories:
- Health & Wellness: +23%
- Pet Supplies: +19%
- Home Office: +15%
- Sustainable Products: +31%

Regional breakdown:
- Asia-Pacific: $3.1T (49.2% share)
- North America: $1.2T (19% share)
- Europe: $1.0T (15.9% share)
- Rest of World: $1.0T (15.9% share)

Average cart abandonment rate: 69.8%
Top reasons: shipping costs (48%), account creation required (24%), slow delivery (22%)`,
  },
  {
    id: "survey-results",
    label: "Survey Results",
    description: "Visualize survey or research findings",
    content: `2025 Developer Survey Results (5,000 respondents)

Most used programming languages:
1. JavaScript/TypeScript — 71%
2. Python — 62%
3. Java — 35%
4. Go — 28%
5. Rust — 19%

Remote work preferences:
- Fully remote: 45%
- Hybrid (2-3 days office): 38%
- Fully in-office: 17%

Average salary by experience:
- 0-2 years: $72,000
- 3-5 years: $105,000
- 6-10 years: $142,000
- 10+ years: $178,000

Top frustrations: meetings (67%), unclear requirements (54%), technical debt (49%)`,
  },
];

export const CINEMATIC_TEMPLATES: WorkspaceTemplate[] = [
  {
    id: "product-launch",
    label: "Product Launch",
    description: "Cinematic reveal of a new product",
    content: `Create a cinematic product launch video for a premium wireless noise-canceling headphone called "AuraSound Pro." The video should feel like an Apple-style product reveal — sleek, minimal, and aspirational. Start with a slow-motion shot of the headphones emerging from darkness, light reflecting off the brushed aluminum finish. Transition to lifestyle shots: a woman focused in a busy café, a man jogging through a misty forest, a student studying in a library. End with the product floating against a clean background with specs appearing one by one: 40-hour battery, spatial audio, adaptive noise cancellation. Tagline: "Hear What Matters."`,
  },
  {
    id: "travel-cinematic",
    label: "Travel Cinematic",
    description: "Stunning visual journey through a destination",
    content: `A cinematic travel video exploring the hidden gems of Kyoto, Japan during autumn. Open with an aerial shot of golden maple trees surrounding ancient temples. Follow a solo traveler through the famous bamboo grove of Arashiyama at dawn, the light filtering through towering stalks. Capture the serene beauty of Kinkaku-ji (Golden Pavilion) reflected perfectly in its mirror-like pond. Show traditional tea ceremony preparations with close-ups of steaming matcha. End at Fushimi Inari with the iconic red torii gates stretching into the mountain, the traveler walking alone as the sun sets behind them.`,
  },
];

/** Lookup templates by mode */
export function getTemplatesForMode(mode: string): WorkspaceTemplate[] {
  switch (mode) {
    case "doc2video": return DOC2VIDEO_TEMPLATES;
    case "storytelling": return STORYTELLING_TEMPLATES;
    case "smartflow": return SMARTFLOW_TEMPLATES;
    case "cinematic": return CINEMATIC_TEMPLATES;
    default: return [];
  }
}
