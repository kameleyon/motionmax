// PostCSS config for the marketing (Astro) site.
//
// Replaces the @astrojs/tailwind integration that was removed during the
// Astro v6 upgrade. The integration's only job here was forwarding the
// Tailwind v3 PostCSS plugin to Vite — Astro 6 will pick this config up
// directly via Vite's default PostCSS resolution.
module.exports = {
  plugins: {
    tailwindcss: { config: "./tailwind.config.cjs" },
    autoprefixer: {},
  },
};
