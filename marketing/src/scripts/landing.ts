/**
 * Landing page interactivity — mobile menu toggle + Watch Demo modal.
 *
 * IMPORTANT: This file MUST be imported from index.astro via a non-inline
 * <script> with a `src` attribute (i.e. NOT `<script is:inline>` and NOT
 * an inline `<script>{...}</script>`). The site CSP at
 *
 *   script-src 'self' https://js.stripe.com https://www.googletagmanager.com
 *
 * (see vercel.json) has no 'unsafe-inline', no nonce, and no hash — so any
 * inline script is blocked, including Astro's default hoisted module scripts
 * when they're small enough to be inlined. Importing this file forces Astro
 * to emit a separate hashed asset under /_astro/*.js, which is same-origin
 * and therefore allowed by the `'self'` source.
 *
 * If this file ever gets so trivial that Astro decides to inline it, just
 * add a re-export from another module to keep it externalized — or set
 * vite.build.assetsInlineLimit on the Astro side.
 */

function initLanding(): void {
  // Mobile menu
  const menuBtn = document.getElementById("menu-btn");
  const mobileMenu = document.getElementById("mobile-menu");
  const iconMenu = document.getElementById("icon-menu");
  const iconX = document.getElementById("icon-x");

  if (menuBtn && mobileMenu) {
    menuBtn.addEventListener("click", () => {
      const open = mobileMenu.classList.toggle("hidden") === false;
      menuBtn.setAttribute("aria-expanded", String(open));
      iconMenu?.classList.toggle("hidden", open);
      iconX?.classList.toggle("hidden", !open);
    });
    mobileMenu.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", () => {
        mobileMenu.classList.add("hidden");
        menuBtn.setAttribute("aria-expanded", "false");
        iconMenu?.classList.remove("hidden");
        iconX?.classList.add("hidden");
      });
    });
  }

  // Demo modal
  const demoBtn = document.getElementById("demo-btn");
  const demoModal = document.getElementById("demo-modal");
  const demoBackdrop = document.getElementById("demo-backdrop");
  const demoClose = document.getElementById("demo-close");
  const demoIframe = document.getElementById("demo-iframe") as HTMLIFrameElement | null;

  function openDemo(): void {
    if (!demoModal || !demoIframe) return;
    const src = demoIframe.dataset.src;
    if (src) demoIframe.src = src;
    demoModal.classList.remove("hidden");
    demoModal.classList.add("flex");
    document.body.style.overflow = "hidden";
  }
  function closeDemo(): void {
    if (!demoModal || !demoIframe) return;
    demoModal.classList.add("hidden");
    demoModal.classList.remove("flex");
    demoIframe.src = "";
    document.body.style.overflow = "";
  }

  demoBtn?.addEventListener("click", openDemo);
  demoClose?.addEventListener("click", closeDemo);
  demoBackdrop?.addEventListener("click", closeDemo);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDemo();
  });
}

// Module scripts are already deferred (executed after the parser sees
// </html>), so by the time this runs the DOM is fully parsed. But guard
// anyway in case an upstream change ever switches the loading strategy.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initLanding);
} else {
  initLanding();
}
