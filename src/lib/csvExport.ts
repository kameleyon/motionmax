// Shared CSV / JSON export utility for admin tables. Handles the
// boilerplate (Blob assembly, escape, anchor click, revoke) so each
// admin table just declares which rows + columns to export.
//
// Used by AdminLogs, AdminSubscribers, AdminApiCalls (and any future
// admin table that needs offline export for incident review).

export type ExportColumn<Row> = {
  key: string;
  label: string;
  // Optional accessor — use when the column maps to a derived value
  // rather than a flat property on the row (e.g. nested fields, formatters).
  accessor?: (row: Row) => unknown;
};

/** RFC-4180 cell escape: wrap in quotes, double internal quotes, stringify objects. */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const stringValue = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${stringValue.replace(/"/g, '""')}"`;
}

/** Trigger a browser download for a Blob. Cleans up the object URL afterward. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** ISO timestamp safe for filenames (colon and dot replaced). */
export function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Export an array of rows to a CSV file and trigger download.
 * Returns the row count exported (caller usually surfaces this in a toast).
 */
export function exportRowsAsCsv<Row>(
  rows: Row[],
  columns: ExportColumn<Row>[],
  filenamePrefix: string,
): number {
  const header = columns.map((c) => escapeCell(c.label)).join(",");
  const body = rows
    .map((row) =>
      columns
        .map((col) => {
          const raw = col.accessor ? col.accessor(row) : (row as unknown as Record<string, unknown>)[col.key];
          return escapeCell(raw);
        })
        .join(","),
    )
    .join("\n");
  const blob = new Blob([header + "\n" + body], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, `${filenamePrefix}-${timestampSlug()}.csv`);
  return rows.length;
}

/** Export rows as JSON. Identical shape to CSV exporter for callsite symmetry. */
export function exportRowsAsJson<Row>(rows: Row[], filenamePrefix: string): number {
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
  triggerDownload(blob, `${filenamePrefix}-${timestampSlug()}.json`);
  return rows.length;
}
