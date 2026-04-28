import { ReactNode } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { ChevronRight, FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";
import AppShell from "@/components/dashboard/AppShell";

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
  const fullTitle = title ?? `${heading} · Lab · MotionMax`;
  const breadcrumbLabel = breadcrumbs.length > 0
    ? `Lab · ${breadcrumbs[breadcrumbs.length - 1].label}`
    : "Lab";

  return (
    <AppShell breadcrumb={breadcrumbLabel}>
      <Helmet>
        <title>{fullTitle}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="px-4 py-6 sm:px-6 sm:py-8 md:px-8">
        <div className="mx-auto w-full max-w-6xl">
          {/* Lab breadcrumb strip */}
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-1.5 text-[13px] text-[#8A9198] mb-5"
          >
            <Link
              to="/lab"
              className="inline-flex items-center gap-1.5 text-[#ECEAE4] hover:text-[#11C4D0] transition-colors"
            >
              <FlaskConical className="h-3.5 w-3.5 text-[#11C4D0]" />
              <span className="font-medium">Lab</span>
            </Link>
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

          {/* Heading row */}
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
      </div>
    </AppShell>
  );
}

export default LabLayout;
