import { ReactNode, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { ArrowLeft, ChevronRight, FlaskConical, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LabBreadcrumb {
  label: string;
  to?: string;
}

interface LabLayoutProps {
  /**
   * Breadcrumbs rendered inside the header bar. The implicit `Lab` root
   * crumb is always prepended; pass everything below it. Pass an empty
   * array on the lab landing page itself.
   */
  breadcrumbs?: LabBreadcrumb[];
  /** Browser tab title — defaults to "Lab · MotionMax". */
  title?: string;
  /** Page heading shown above the content frame. */
  heading: string;
  /** Optional subhead shown under the heading. */
  description?: string;
  children: ReactNode;
  /**
   * Optional right-side content for the heading row (CTAs, filters,
   * etc.). Hidden under 640px to keep the heading legible on phones.
   */
  actions?: ReactNode;
}

/**
 * Shared chrome for every page under `/lab/*`.
 *
 * Matches the dark surface treatment used in `src/pages/Admin.tsx` so
 * the lab pages feel like a sibling environment to the admin panel,
 * but uses brand aqua / gold tokens instead of admin's hard-coded
 * color literals — so a future theme change at the design-token level
 * propagates cleanly.
 *
 * Mobile rules: at <768px the breadcrumb collapses behind a hamburger
 * toggle; at <640px the optional `actions` slot hides. Header stays
 * sticky so navigation is always reachable.
 */
export function LabLayout({
  breadcrumbs = [],
  title,
  heading,
  description,
  actions,
  children,
}: LabLayoutProps) {
  const [crumbsOpen, setCrumbsOpen] = useState(false);
  const fullTitle = title ?? `${heading} · Lab · MotionMax`;

  return (
    <div className="min-h-screen flex flex-col bg-[#0A0D0F] text-[#ECEAE4]">
      <Helmet>
        <title>{fullTitle}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#10151A]/80 backdrop-blur-md">
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              to="/lab"
              className="flex items-center gap-2 shrink-0 text-[#ECEAE4] hover:text-[#11C4D0] transition-colors"
            >
              <FlaskConical className="h-4 w-4 text-[#11C4D0]" />
              <span className="text-sm font-medium tracking-tight">Lab</span>
            </Link>

            {/* Desktop breadcrumb */}
            {breadcrumbs.length > 0 && (
              <nav
                aria-label="Breadcrumb"
                className="hidden md:flex items-center gap-1.5 text-[13px] text-[#8A9198] min-w-0"
              >
                {breadcrumbs.map((crumb, i) => {
                  const isLast = i === breadcrumbs.length - 1;
                  return (
                    <div key={`${crumb.label}-${i}`} className="flex items-center gap-1.5 min-w-0">
                      <ChevronRight className="h-3.5 w-3.5 text-[#5A6268] shrink-0" />
                      {crumb.to && !isLast ? (
                        <Link
                          to={crumb.to}
                          className="truncate hover:text-[#ECEAE4] transition-colors"
                        >
                          {crumb.label}
                        </Link>
                      ) : (
                        <span
                          className={cn(
                            "truncate",
                            isLast ? "text-[#ECEAE4]" : "text-[#8A9198]",
                          )}
                          aria-current={isLast ? "page" : undefined}
                        >
                          {crumb.label}
                        </span>
                      )}
                    </div>
                  );
                })}
              </nav>
            )}

            {/* Mobile breadcrumb toggle */}
            {breadcrumbs.length > 0 && (
              <button
                type="button"
                onClick={() => setCrumbsOpen(o => !o)}
                aria-expanded={crumbsOpen}
                aria-label="Toggle breadcrumb"
                className="md:hidden inline-flex items-center justify-center rounded-md p-1.5 text-[#8A9198] hover:text-[#ECEAE4] hover:bg-white/5 transition-colors"
              >
                {crumbsOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
              </button>
            )}
          </div>

          <Link
            to="/app"
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] text-[#8A9198] hover:text-[#E4C875] hover:bg-white/5 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Back to app</span>
            <span className="sm:hidden">App</span>
          </Link>
        </div>

        {/* Mobile breadcrumb tray */}
        {crumbsOpen && breadcrumbs.length > 0 && (
          <nav
            aria-label="Breadcrumb"
            className="md:hidden border-t border-white/8 bg-[#10151A] px-4 py-3 space-y-2"
          >
            {breadcrumbs.map((crumb, i) => {
              const isLast = i === breadcrumbs.length - 1;
              const inner = (
                <span
                  className={cn(
                    "text-[13px]",
                    isLast ? "text-[#ECEAE4]" : "text-[#8A9198]",
                  )}
                >
                  {crumb.label}
                </span>
              );
              return (
                <div key={`${crumb.label}-mobile-${i}`} className="flex items-center gap-2">
                  <ChevronRight className="h-3.5 w-3.5 text-[#5A6268] shrink-0" />
                  {crumb.to && !isLast ? (
                    <Link to={crumb.to} onClick={() => setCrumbsOpen(false)}>
                      {inner}
                    </Link>
                  ) : (
                    inner
                  )}
                </div>
              );
            })}
          </nav>
        )}
      </header>

      {/* Heading row + content */}
      <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8 md:px-8">
        <div className="mx-auto w-full max-w-6xl">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-6 mb-6 sm:mb-8">
            <div className="min-w-0">
              <h1 className="font-serif text-2xl sm:text-3xl text-[#ECEAE4] truncate">
                {heading}
              </h1>
              {description && (
                <p className="mt-2 text-[13px] sm:text-sm text-[#8A9198] max-w-2xl">
                  {description}
                </p>
              )}
            </div>
            {actions && (
              <div className="hidden sm:flex items-center gap-2 shrink-0">
                {actions}
              </div>
            )}
          </div>

          <div>{children}</div>
        </div>
      </main>
    </div>
  );
}

export default LabLayout;
