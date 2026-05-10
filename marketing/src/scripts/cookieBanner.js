/**
 * CookieBanner controller — DOM wiring for CookieBanner.astro.
 *
 * B-NEW-10 / TONGUE-10. Imported as an external module (no inline JS,
 * no inline event handlers — see CookieBanner.astro and the CSP note in
 * landing.ts for why). All buttons live in the static markup; this file
 * attaches listeners on DOMContentLoaded and toggles state via
 * cookieConsent.js.
 *
 * Footer integration: a `data-cookie-action="reopen"` element anywhere
 * on the page (Footer "Cookie preferences" link) will revoke consent
 * and re-show the banner. We listen via a single delegated click
 * handler so individual pages don't need to wire anything.
 *
 * Cross-tab sync: a `motionmax:consent-changed` CustomEvent dispatched
 * by cookieConsent.js (on accept/reject/save/revoke) is what drives the
 * banner's visibility — we never touch storage directly here.
 */

import {
  getConsent,
  hasAnswered,
  onConsentChange,
  revokeConsent,
  setConsent,
} from "./cookieConsent.js";
import { initMarketingAnalytics } from "./marketingAnalytics.js";

function el(id) {
  return document.getElementById(id);
}

function setBannerVisible(visible) {
  const banner = el("cookie-banner");
  if (!banner) return;
  if (visible) {
    banner.removeAttribute("hidden");
  } else {
    banner.setAttribute("hidden", "");
  }
}

function setSwitchState(button, on) {
  if (!button) return;
  if (on) {
    button.classList.add("is-on");
    button.setAttribute("aria-checked", "true");
  } else {
    button.classList.remove("is-on");
    button.setAttribute("aria-checked", "false");
  }
}

function readSwitchState(button) {
  if (!button) return false;
  return button.getAttribute("aria-checked") === "true";
}

function setDetailsOpen(open) {
  const details = el("cookie-banner-details");
  const customize = el("cookie-banner-customize");
  const save = el("cookie-banner-save");
  if (details) {
    if (open) details.removeAttribute("hidden");
    else details.setAttribute("hidden", "");
  }
  // The "Customize" inline trigger is hidden once the details panel is
  // expanded — its job is done; "Save preferences" takes its place in
  // the action row.
  if (customize) {
    customize.style.display = open ? "none" : "";
  }
  if (save) {
    if (open) save.removeAttribute("hidden");
    else save.setAttribute("hidden", "");
  }
}

function syncSwitchesFromRecord() {
  const record = getConsent();
  const fn = el("cc-functional");
  const an = el("cc-analytics");
  const mk = el("cc-marketing");
  if (!record) {
    setSwitchState(fn, false);
    setSwitchState(an, false);
    setSwitchState(mk, false);
    return;
  }
  setSwitchState(fn, record.categories.functional);
  setSwitchState(an, record.categories.analytics);
  setSwitchState(mk, record.categories.marketing);
}

function persist(cats) {
  setConsent(cats);
  setBannerVisible(false);
  setDetailsOpen(false);
}

function handleAcceptAll() {
  persist({ functional: true, analytics: true, marketing: true });
}
function handleRejectAll() {
  persist({ functional: false, analytics: false, marketing: false });
}
function handleSavePreferences() {
  const fn = readSwitchState(el("cc-functional"));
  const an = readSwitchState(el("cc-analytics"));
  const mk = readSwitchState(el("cc-marketing"));
  persist({ functional: fn, analytics: an, marketing: mk });
}

function attachToggle(id) {
  const btn = el(id);
  if (!btn) return;
  if (btn.hasAttribute("disabled")) return;
  btn.addEventListener("click", () => {
    setSwitchState(btn, !readSwitchState(btn));
  });
}

function init() {
  // Kick the analytics loader FIRST so users who already consented (e.g.
  // arrived from app.motionmax.io with a shared cookie) see GA fire on
  // first paint without waiting for a banner re-confirm.
  initMarketingAnalytics();

  attachToggle("cc-functional");
  attachToggle("cc-analytics");
  attachToggle("cc-marketing");

  el("cookie-banner-accept")?.addEventListener("click", handleAcceptAll);
  el("cookie-banner-reject")?.addEventListener("click", handleRejectAll);
  el("cookie-banner-close")?.addEventListener("click", handleRejectAll);
  el("cookie-banner-save")?.addEventListener("click", handleSavePreferences);
  el("cookie-banner-customize")?.addEventListener("click", () => setDetailsOpen(true));

  // Esc collapses the details panel (matches React app behaviour). Esc
  // does NOT close the banner without a choice — that would otherwise
  // be treated as silent consent.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const details = el("cookie-banner-details");
    if (details && !details.hasAttribute("hidden")) {
      e.preventDefault();
      setDetailsOpen(false);
    }
  });

  // Footer "Cookie preferences" delegated handler. Any element with
  // data-cookie-action="reopen" on the page wipes consent and re-shows
  // the banner. Pre-existing footer markup just needs the attribute.
  document.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const trigger = target.closest('[data-cookie-action="reopen"]');
    if (!trigger) return;
    e.preventDefault();
    revokeConsent();
    // revokeConsent() dispatches the event listened to below; the
    // banner will re-show via that path.
  });

  // Re-render whenever consent changes (banner save, footer revoke,
  // cross-tab events). null detail = revocation.
  onConsentChange((record) => {
    if (record === null) {
      syncSwitchesFromRecord();
      setDetailsOpen(false);
      setBannerVisible(true);
    } else {
      setBannerVisible(false);
    }
  });

  // First-paint visibility decision.
  if (hasAnswered()) {
    setBannerVisible(false);
  } else {
    syncSwitchesFromRecord();
    setBannerVisible(true);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
