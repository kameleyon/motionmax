# Deployment Security Configuration

This document outlines the required security headers and configurations for deploying MotionMax in production.

## Required HTTP Security Headers

These headers **MUST** be configured in your deployment platform (Vercel, Netlify, AWS, etc.). They cannot be set via `<meta>` tags.

### 1. Content Security Policy (CSP)

```
Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'; upgrade-insecure-requests;
```

**Purpose**:
- `frame-ancestors 'none'` - Prevents clickjacking attacks by disallowing the site from being embedded in iframes
- `object-src 'none'` - Blocks plugins (Flash, Java, etc.)
- `base-uri 'self'` - Prevents base tag injection attacks
- `upgrade-insecure-requests` - Automatically upgrades HTTP requests to HTTPS

### 2. X-Frame-Options (Legacy browsers)

```
X-Frame-Options: DENY
```

**Purpose**: Fallback for older browsers that don't support CSP frame-ancestors

### 3. X-Content-Type-Options

```
X-Content-Type-Options: nosniff
```

**Purpose**: Prevents MIME type sniffing attacks

### 4. Referrer-Policy

```
Referrer-Policy: strict-origin-when-cross-origin
```

**Purpose**: Controls referrer information sent to external sites

### 5. Permissions-Policy

```
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
```

**Purpose**: Disables unnecessary browser features

### 6. Strict-Transport-Security (HSTS)

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

**Purpose**: Forces HTTPS for all connections (only set on HTTPS responses)

### 7. `style-src 'unsafe-inline'` — known finding, retained intentionally

**Status:** retained as of Wave 6 (Cipher §6 C-6-6). Tracked for removal.

The production CSP in `vercel.json` includes:

```
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
```

This is a real CSS-exfiltration surface (attribute-selector tricks can
read attribute values from the authenticated DOM via crafted CSS
rules). It is retained for the following architectural reasons:

1. **MotionMax is a Vite SPA served as static files from `dist/` on
   Vercel — there is no SSR layer to inject a per-request nonce into
   the HTML head.** The marketing site has an Astro build, but the
   `/app` workspace where authenticated data lives is pure static.
   Adding a Vercel Edge Middleware to rewrite static HTML on every
   request just to insert a `<meta name="csp-nonce">` tag would (a)
   break Vite's build hashes and immutable asset caching, and (b)
   still leave a window where the inline `style` attributes Radix UI
   and ~89 of our own components emit must be allowed somehow.
2. **`'unsafe-hashes'` is not a viable substitute on its own.**
   `'unsafe-hashes'` only takes effect when paired with an enumerated
   SHA-hash for each unique inline-style value. The app has ~963
   `style={...}` sites with values computed at render time (animation
   transforms, dynamic widths, theme tokens) — they cannot be
   exhaustively hashed at build time.
3. **`framer-motion` injects `<style>` tags via
   `document.createElement('style')` and supports a nonce via
   `MotionConfigContext`, but without an SSR-injected nonce there is
   nothing to pass.** Generating a build-time fixed nonce is exactly
   equivalent to `'unsafe-inline'` from a defence standpoint — once
   the nonce is in the static HTML, an attacker who can inject DOM
   can read it.

**Migration path (out of scope for §6):**

- Move `/app` routes to an SSR-capable platform layer (e.g. add a
  Vercel Function that renders `app-shell.html` on demand, OR migrate
  to Next.js App Router) so a per-request nonce can be inserted into
  the HTML head AND the response CSP header.
- Pass the nonce through `MotionConfigProvider`'s `nonce` prop so
  framer-motion's runtime `<style>` tags inherit it.
- Audit the ~89 component files that use inline `style={...}` and
  refactor each to a Tailwind class or CSS variable; for animation-
  driven dynamic styles, scope them via CSS custom properties set on
  a wrapper element so the inline declaration becomes
  `style={{ '--w': widthPx }}` — a fixed shape we CAN hash.
- Once all three are done, replace `'unsafe-inline'` with
  `'nonce-<perRequest>' 'strict-dynamic'` and drop `'unsafe-hashes'`.

The XSS-→-data-exfiltration risk is mitigated in the interim by:

- `script-src` has NO `'unsafe-inline'` and NO `'unsafe-eval'` — DOM
  XSS via script execution is the actual catastrophic vector, and it
  is closed.
- Supabase JWT lives in `sessionStorage` per Wave 2 (§6 C-6-1) — an
  attacker who lands a CSS-exfiltration primitive cannot escalate to
  account takeover without also breaking script CSP.
- `report-uri /api/csp-report` is wired so any drift toward `<style>`
  injection in production is observed.

---

## Platform-Specific Configuration

### Vercel (vercel.json)

> **Note:** The live `vercel.json` in the repository root is the authoritative source.
> The snippet below reflects the current configuration as of 2026-04-19.
> The full CSP includes all trusted origins for Supabase, Stripe, Google Analytics, Sentry, etc.
> Do not use the minimal snippet below in production — it will break legitimate app functionality.

```json
{
  "framework": "vite",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "installCommand": "npm ci",
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(self), geolocation=()" },
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
        {
          "key": "Content-Security-Policy",
          "value": "<see vercel.json for the full production CSP>"
        }
      ]
    }
  ]
}
```

### Netlify (_headers file)

```
/*
  Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'; upgrade-insecure-requests;
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

### AWS CloudFront (Lambda@Edge)

```javascript
exports.handler = async (event) => {
  const response = event.Records[0].cf.response;
  const headers = response.headers;

  headers['content-security-policy'] = [{
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; upgrade-insecure-requests;"
  }];

  headers['x-frame-options'] = [{ key: 'X-Frame-Options', value: 'DENY' }];
  headers['x-content-type-options'] = [{ key: 'X-Content-Type-Options', value: 'nosniff' }];
  headers['referrer-policy'] = [{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }];
  headers['permissions-policy'] = [{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' }];
  headers['strict-transport-security'] = [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' }];

  return response;
};
```

---

## Environment Variables

Ensure the following environment variables are set in production:

### Required

- `VITE_APP_URL` - Full production URL (e.g., `https://motionmax.io`)
- `VITE_SUPABASE_URL` - Supabase project URL
- `VITE_SUPABASE_PUBLISHABLE_KEY` - Supabase anon key
- `VITE_SENTRY_DSN` - Sentry error tracking DSN (optional but recommended)

### Edge Functions

- `ALLOWED_ORIGIN` - Production domain (e.g., `https://motionmax.io`) - **MUST be set, never use wildcard**
- `ENCRYPTION_KEY` - Strong random key for API key encryption (min 32 characters)
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key (keep secret)
- `SUPABASE_ANON_KEY` - Publishable anon key

---

## Security Checklist

Before deploying to production:

- [ ] All HTTP security headers configured in deployment platform
- [ ] `ALLOWED_ORIGIN` environment variable set (no wildcard)
- [ ] `ENCRYPTION_KEY` is a strong random string (min 32 chars)
- [ ] HTTPS enabled with valid SSL certificate
- [ ] Database migrations applied (`supabase db push`)
- [ ] Rate limiting table (`rate_limits`) exists in database
- [ ] Admin logs table (`admin_logs`) exists in database
- [ ] Service role key secured (not exposed in client code)
- [ ] Error tracking (Sentry) configured
- [ ] Backup strategy in place for database

---

## Testing Security Headers

Use https://securityheaders.com/ to verify your production deployment has all required headers.

Expected grade: A or A+
