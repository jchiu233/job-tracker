import type { Application } from "./db.js";

const COLUMNS: { header: string; value: (a: Application) => string | number | null }[] = [
  { header: "Company", value: (a) => a.company },
  { header: "Role", value: (a) => a.role },
  { header: "Status", value: (a) => a.status },
  { header: "Location", value: (a) => a.location },
  { header: "Applied", value: (a) => a.appliedDate },
  { header: "Follow up", value: (a) => a.followUpDate },
  { header: "URL", value: (a) => a.url },
  { header: "Notes", value: (a) => a.notes },
];

/**
 * Format one CSV cell.
 * - Values that start with = + - @ (or tab/CR) are prefixed with an apostrophe. Otherwise a
 *   company named "=HYPERLINK(...)" would run as a formula when opened in Excel or Sheets
 *   ("CSV injection").
 * - Values containing commas, quotes, or newlines are quoted, with inner quotes doubled.
 */
export function csvCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(applications: Application[]): string {
  const lines = [COLUMNS.map((c) => c.header).join(",")];
  for (const app of applications) {
    lines.push(COLUMNS.map((c) => csvCell(c.value(app))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
