import { STATUSES, type ApplicationInput, type Status } from "./db.js";

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const MAX_LENGTH = {
  company: 200,
  role: 200,
  url: 2000,
  location: 200,
  notes: 5000,
} as const;

/** True only for real calendar dates in YYYY-MM-DD form (rejects 2026-02-30). */
export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate and normalize a request body.
 * - On create, company and role are required.
 * - On patch, only the fields that are present are checked.
 * - Optional text fields accept null or "" to mean "clear this".
 */
function parse(body: Record<string, unknown>, isCreate: boolean): Result<ApplicationInput> {
  const errors: string[] = [];
  const out: ApplicationInput = {};

  for (const field of ["company", "role"] as const) {
    const raw = body[field];
    if (raw === undefined) {
      if (isCreate) errors.push(`${field} is required`);
      continue;
    }
    if (typeof raw !== "string" || raw.trim() === "") {
      errors.push(`${field} must be a non-empty string`);
    } else if (raw.trim().length > MAX_LENGTH[field]) {
      errors.push(`${field} must be at most ${MAX_LENGTH[field]} characters`);
    } else {
      out[field] = raw.trim();
    }
  }

  for (const field of ["url", "location", "notes"] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
      out[field] = null;
    } else if (typeof raw !== "string") {
      errors.push(`${field} must be a string or null`);
    } else if (raw.trim().length > MAX_LENGTH[field]) {
      errors.push(`${field} must be at most ${MAX_LENGTH[field]} characters`);
    } else if (field === "url" && !isHttpUrl(raw.trim())) {
      errors.push("url must be a valid http or https URL");
    } else {
      out[field] = raw.trim();
    }
  }

  for (const field of ["appliedDate", "followUpDate"] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (raw === null || raw === "") {
      out[field] = null;
    } else if (!isDate(raw)) {
      errors.push(`${field} must be a valid date in YYYY-MM-DD format`);
    } else {
      out[field] = raw;
    }
  }

  if (body.status !== undefined) {
    if (isStatus(body.status)) out.status = body.status;
    else errors.push(`status must be one of: ${STATUSES.join(", ")}`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

export const parseCreate = (body: Record<string, unknown>) => parse(body, true);
export const parsePatch = (body: Record<string, unknown>) => parse(body, false);
