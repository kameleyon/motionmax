import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      // Named z-index tokens. The new template previously had wildly
      // diverging arbitrary values (z-[2], z-[4], z-[200], z-[9998],
      // z-[9999], z-[10000]) which produced unpredictable stacking —
      // most notably the Stage chrome punching through the mobile
      // Inspector drawer. These tokens give every layer a single
      // canonical place in the stack so the bug class can't recur.
      // Use via Tailwind utilities:  z-stage / z-overlay / z-drawer /
      // z-modal / z-fullscreen.
      zIndex: {
        stage:      "5",
        overlay:    "10",
        drawer:     "50",
        modal:      "60",
        fullscreen: "100",
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        brand: {
          dark: "hsl(var(--brand-dark))",
          aqua: "hsl(var(--brand-aqua))",
          "aqua-dark": "hsl(var(--brand-aqua-dark))",
          "aqua-light": "hsl(var(--brand-aqua-light))",
          gold: "hsl(var(--brand-gold))",
          "gold-dark": "hsl(var(--brand-gold-dark))",
          "gold-light": "hsl(var(--brand-gold-light))",
        },
        gold: {
          DEFAULT: "hsl(var(--gold))",
          foreground: "hsl(var(--gold-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        "text-secondary": "hsl(var(--text-secondary, var(--muted-foreground)))",
        "text-tertiary": "hsl(var(--text-tertiary, var(--muted-foreground)))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "calc(var(--radius) + 4px)",
        "2xl": "calc(var(--radius) + 8px)",
      },

      // ────────────────────────────────────────────────────────────
      // Wave A PART G (2026-05-10): formalised brand spacing /
      // shadow / motion tokens. These mirror the values already in
      // the components (where we'd been using arbitrary `p-4`,
      // `p-8`, `gap-12`, `[box-shadow:...]` etc.); naming them gives
      // future agents a single canonical scale to pull from instead
      // of inventing new ones. See docs/design-system.md.
      // ────────────────────────────────────────────────────────────
      spacing: {
        // 8-pt base grid — explicit aliases for the ones we actually
        // reach for. Tailwind's defaults already cover these via
        // numeric scale (1=4px, 2=8px, …); the named aliases here
        // make intent clearer in JSX (`p-brand-md` vs `p-4`).
        "brand-xs": "0.25rem",   // 4px
        "brand-sm": "0.5rem",    // 8px
        "brand-md": "0.75rem",   // 12px
        "brand-lg": "1rem",      // 16px
        "brand-xl": "1.5rem",    // 24px
        "brand-2xl": "2rem",     // 32px
        "brand-3xl": "3rem",     // 48px
        "brand-4xl": "4rem",     // 64px
      },

      boxShadow: {
        // Brand-tinted shadows. Standard neutral shadows feel dead on
        // dark surfaces; aqua/gold tints carry the brand glow through
        // hover/active states. Use sparingly — only on hero CTAs,
        // selected cards, focused inputs.
        "brand-sm": "0 1px 2px 0 rgba(20, 200, 204, 0.10)",
        "brand-md": "0 4px 12px -2px rgba(20, 200, 204, 0.20)",
        "brand-lg": "0 8px 24px -4px rgba(20, 200, 204, 0.28)",
        "gold-sm":  "0 1px 2px 0 rgba(228, 200, 117, 0.12)",
        "gold-md":  "0 4px 12px -2px rgba(228, 200, 117, 0.22)",
        "gold-lg":  "0 8px 24px -4px rgba(228, 200, 117, 0.30)",
      },

      transitionDuration: {
        // Named motion scale. Component code should reach for these
        // instead of inventing one-off `duration-[120ms]` values.
        // Anchored at 150 / 250 / 400 — fast enough that hovers feel
        // responsive, slow enough that page-level transitions read
        // as deliberate motion (not abrupt cuts).
        fast: "150ms",
        base: "250ms",
        slow: "400ms",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "scale(0.95)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "slide-in-right": {
          "0%": { transform: "translateX(100%)" },
          "100%": { transform: "translateX(0)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.3s ease-out",
        "scale-in": "scale-in 0.2s ease-out",
        "slide-in-right": "slide-in-right 0.3s ease-out",
        shimmer: "shimmer 2s infinite",
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
