# Security Deployment — motionmax

This is the operational side of `DEPLOYMENT_SECURITY.md` (which documents
the *what* of our header policy). This file documents the *how* — the
manual steps that have to be run from a human's browser / dashboard
that no CI workflow can do for us.

## HSTS preload-list submission

### Why

Browsers ship with a built-in list of HTTPS-only domains
([hstspreload.org](https://hstspreload.org/)). Once motionmax.io is on
the list, every Chrome / Firefox / Safari / Edge user gets HTTPS
locked in for our domain even on their **first visit** (before they
ever receive our `Strict-Transport-Security` header). This closes the
TOFU (trust-on-first-use) hole that HSTS-on-response alone leaves
open.

The downside: removal is slow (weeks at best, browsers re-ship the
list on their release cadence) and during that window we can't serve
**any** content over HTTP on motionmax.io *or any subdomain* —
including future subdomains we haven't created yet. So we don't
submit until we're sure.

### Prerequisites checklist

Before clicking the submit button on hstspreload.org, all of the
following must be true. Walk through them in order; do not skip.

- [ ] **HSTS header is served on every response** with all three flags.
      Current value (see `vercel.json` `headers[]`):
      ```
      Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
      ```
      Verify:
      ```bash
      curl -sI https://motionmax.io | grep -i strict-transport
      curl -sI https://staging.motionmax.io | grep -i strict-transport
      curl -sI https://www.motionmax.io | grep -i strict-transport
      ```
      All three should return the same header, including `preload`.

- [ ] **HTTPS redirect from `http://`** is unconditional (no path-based
      exemptions). Vercel handles this for the apex automatically;
      verify for each subdomain:
      ```bash
      curl -sI http://motionmax.io       | head -5    # expect 308 → https
      curl -sI http://www.motionmax.io   | head -5
      curl -sI http://staging.motionmax.io | head -5
      ```

- [ ] **`includeSubDomains` is honest**. Every subdomain we serve
      content from MUST already serve HTTPS-only, or we'll break it
      the moment the list propagates. Audit the live list:
      ```bash
      # DNS records authoritative for motionmax.io
      dig motionmax.io ANY +short
      # Cloudflare zone listing — see iac/cloudflare/dns.tf
      ```
      Known subdomains and their HTTPS status:

      | Subdomain                | HTTPS? | Owner / notes                      |
      | ------------------------ | ------ | ---------------------------------- |
      | `motionmax.io`           | ✅      | Vercel — apex                       |
      | `www.motionmax.io`       | ✅      | Vercel — apex redirect             |
      | `staging.motionmax.io`   | ✅      | Vercel preview alias               |
      | `app.motionmax.io`       | n/a    | Not provisioned                    |
      | `api.motionmax.io`       | n/a    | Not provisioned                    |
      | `*.supabase.co` proxies  | ✅      | We use the Supabase-hosted apex,   |
      |                          |        | not a custom subdomain (so this   |
      |                          |        | isn't on the motionmax.io zone).   |

      If a future subdomain (e.g. `status.motionmax.io`) is added to
      `iac/cloudflare/dns.tf`, it must serve HTTPS-only **before**
      submission and stay HTTPS-only for the lifetime of the preload
      entry.

- [ ] **`max-age` is at least 1 year (31 536 000)**.
      We use `63 072 000` (2 years), which exceeds the requirement.

- [ ] **No mixed-content issues**. The CSP in `vercel.json` already
      enforces `upgrade-insecure-requests`, but visually confirm:
      open https://motionmax.io in Chrome DevTools → Console — no
      "mixed content" warnings on landing page, signup, dashboard,
      voice-lab, billing.

- [ ] **Roll-back plan reviewed**. Once submitted and accepted, the
      preload entry can take 6-12 weeks to *appear* and similar to be
      *removed*. The removal procedure is: send `max-age=0` for a few
      months, then submit a removal request to hstspreload.org. So:
      before submitting, the team must accept that motionmax.io will
      be HTTPS-only on every modern browser for the foreseeable future.

### Submission procedure

Once all the boxes above are ticked:

1. Open https://hstspreload.org/ in a browser.
2. Enter `motionmax.io` in the form.
3. Tick the two acknowledgement checkboxes (subdomain + max-age).
4. Click "Submit". The form runs live HTTPS checks against the domain;
   if any check fails, the prerequisites checklist above is wrong —
   fix the underlying issue before re-submitting.
5. Confirmation email is sent to the registrant within ~1 hour.
6. Actual inclusion happens on Chrome's next stable release after the
   submission is approved — typically 6-12 weeks. Firefox, Safari,
   Edge pull from the Chrome list with similar lag.

### Verification after inclusion

After ~8 weeks, verify on a fresh browser profile (or in Chromium
incognito with no profile cookies):

```
chrome://net-internals/#hsts
→ Query domain: motionmax.io
→ Should report `static_sts_domain: motionmax.io` and
  `static_sts_include_subdomains: true`.
```

### When NOT to submit (yet)

Do not submit if any of the following are still true:

- We haven't decided the canonical apex (`motionmax.io` vs
  `www.motionmax.io`). The preload entry is for **one** apex; the
  other should redirect to it.
- We still serve any HTTP content on a `*.motionmax.io` subdomain —
  for example, an unencrypted status-page subdomain provided by a
  third-party uptime tool (BetterStack currently serves HTTPS, but
  audit before submission).
- We expect to ship a mobile app that bundles motionmax.io in a
  WebView and intentionally talks to a local HTTP dev server during
  development. (Not currently the case, but worth flagging.)

### Status

| Item                              | Owner         | Status            |
| --------------------------------- | ------------- | ----------------- |
| HSTS header live on `motionmax.io`| (vercel.json) | ✅ shipped        |
| Subdomain audit                   | Pipeline      | ✅ above, current |
| Browser preload submission        | Jo            | ⏳ pending click  |
| Post-inclusion verification       | Jo            | ⏳ blocked        |

The actual submission requires Jo to click "Submit" at
https://hstspreload.org/?domain=motionmax.io — this is intentional,
no CI workflow should auto-submit.

## Related files

- `vercel.json` — the HSTS / CSP / X-Frame headers
- `DEPLOYMENT_SECURITY.md` — header-by-header rationale
- `docs/deploy-flow.md` — overall deploy pipeline
- `iac/cloudflare/dns.tf` — DNS records for subdomains (audit before
  submission)
