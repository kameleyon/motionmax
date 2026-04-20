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
