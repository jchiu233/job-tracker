import { DatabaseSync } from "node:sqlite";

export const STATUSES = ["wishlist", "applied", "interview", "offer", "rejected"] as const;
export type Status = (typeof STATUSES)[number];

/** Statuses where a follow-up reminder still makes sense. */
const ACTIVE_STATUSES: Status[] = ["wishlist", "applied", "interview"];

export interface Application {
  id: number;
  company: string;
  role: string;
  url: string | null;
  location: string | null;
  status: Status;
  notes: string | null;
  appliedDate: string | null; // YYYY-MM-DD
  followUpDate: string | null; // YYYY-MM-DD
  createdAt: string;
  updatedAt: string;
}

/** Fields a client may set. Everything is optional here; validate.ts enforces what is required. */
export interface ApplicationInput {
  company?: string;
  role?: string;
  url?: string | null;
  location?: string | null;
  status?: Status;
  notes?: string | null;
  appliedDate?: string | null;
  followUpDate?: string | null;
}

export interface ListFilter {
  status?: Status;
  q?: string;
}

export interface Stats {
  total: number;
  byStatus: Record<Status, number>;
}

// Maps the API's camelCase field names to column names. Only these can ever reach SQL,
// so building the UPDATE statement dynamically from this map is safe from injection.
const COLUMNS: Record<keyof ApplicationInput, string> = {
  company: "company",
  role: "role",
  url: "url",
  location: "location",
  status: "status",
  notes: "notes",
  appliedDate: "applied_date",
  followUpDate: "follow_up_date",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS applications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company        TEXT NOT NULL,
  role           TEXT NOT NULL,
  url            TEXT,
  location       TEXT,
  status         TEXT NOT NULL DEFAULT 'wishlist'
                 CHECK (status IN ('wishlist','applied','interview','offer','rejected')),
  notes          TEXT,
  applied_date   TEXT,
  follow_up_date TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_follow_up ON applications(follow_up_date);
`;

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

function toApplication(row: Row): Application {
  return {
    id: row.id as number,
    company: row.company as string,
    role: row.role as string,
    url: row.url as string | null,
    location: row.location as string | null,
    status: row.status as Status,
    notes: row.notes as string | null,
    appliedDate: row.applied_date as string | null,
    followUpDate: row.follow_up_date as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Escape LIKE wildcards so a search for "100%" matches the literal text. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export class ApplicationStore {
  private db: DatabaseSync;
  private now: () => Date;

  /** @param path a file path, or ":memory:" for a throwaway database (used in tests) */
  constructor(path = ":memory:", now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  list(filter: ListFilter = {}): Application[] {
    const where: string[] = [];
    const params: SqlValue[] = [];

    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.q) {
      const pattern = likePattern(filter.q);
      where.push(
        "(company LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')",
      );
      params.push(pattern, pattern, pattern);
    }

    const sql =
      "SELECT * FROM applications" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY updated_at DESC, id DESC";

    return this.db
      .prepare(sql)
      .all(...params)
      .map((r) => toApplication(r as Row));
  }

  get(id: number): Application | undefined {
    const row = this.db.prepare("SELECT * FROM applications WHERE id = ?").get(id);
    return row ? toApplication(row as Row) : undefined;
  }

  create(input: ApplicationInput): Application {
    const data = { ...input };
    // Moving straight into "applied" without a date? Default to today.
    if (data.status === "applied" && data.appliedDate == null) {
      data.appliedDate = this.today();
    }

    const keys = Object.keys(data).filter(
      (k): k is keyof ApplicationInput => k in COLUMNS && data[k as keyof ApplicationInput] !== undefined,
    );
    const cols = keys.map((k) => COLUMNS[k]);
    const values = keys.map((k) => data[k] as SqlValue);

    const result = this.db
      .prepare(
        `INSERT INTO applications (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      )
      .run(...values);

    return this.get(Number(result.lastInsertRowid))!;
  }

  update(id: number, patch: ApplicationInput): Application | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const data = { ...patch };
    // Auto-fill the applied date the first time an application moves to "applied".
    if (
      data.status === "applied" &&
      existing.appliedDate == null &&
      data.appliedDate === undefined
    ) {
      data.appliedDate = this.today();
    }

    const keys = Object.keys(data).filter(
      (k): k is keyof ApplicationInput => k in COLUMNS && data[k as keyof ApplicationInput] !== undefined,
    );
    if (keys.length === 0) return existing;

    const assignments = keys.map((k) => `${COLUMNS[k]} = ?`);
    const values = keys.map((k) => data[k] as SqlValue);

    this.db
      .prepare(
        `UPDATE applications
         SET ${assignments.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
      )
      .run(...values, id);

    return this.get(id);
  }

  delete(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM applications WHERE id = ?").run(id).changes) > 0;
  }

  stats(): Stats {
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
    let total = 0;
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM applications GROUP BY status")
      .all() as Row[];
    for (const r of rows) {
      byStatus[r.status as Status] = Number(r.n);
      total += Number(r.n);
    }
    return { total, byStatus };
  }

  /** Applications whose follow-up date is on or before `today` and that are still in play. */
  dueFollowUps(today: string): Application[] {
    const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT * FROM applications
         WHERE follow_up_date IS NOT NULL AND follow_up_date <= ?
           AND status IN (${placeholders})
         ORDER BY follow_up_date ASC, id ASC`,
      )
      .all(today, ...ACTIVE_STATUSES)
      .map((r) => toApplication(r as Row));
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }
}
