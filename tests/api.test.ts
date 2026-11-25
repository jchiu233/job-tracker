import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { ApplicationStore } from "../src/db.js";
import { createApp } from "../src/server.js";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));

let server: Server;
let store: ApplicationStore;
let base: string;

// Fixed clock so "applied today" behavior is deterministic.
const FIXED_NOW = new Date("2026-11-25T12:00:00Z");

before(async () => {
  store = new ApplicationStore(":memory:", () => FIXED_NOW);
  server = createApp(store, { publicDir });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  store.close();
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

describe("creating and reading applications", () => {
  it("creates an application with defaults and returns it", async () => {
    const { status, json } = await api("POST", "/api/applications", {
      company: "  EQ Bank  ",
      role: "Software Engineer Intern",
    });
    assert.equal(status, 201);
    assert.equal(json.company, "EQ Bank"); // trimmed
    assert.equal(json.status, "wishlist");
    assert.equal(json.appliedDate, null);
    assert.ok(Number.isInteger(json.id));

    const fetched = await api("GET", `/api/applications/${json.id}`);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.json, json);
  });

  it("returns 404 for a missing application", async () => {
    const { status } = await api("GET", "/api/applications/999999");
    assert.equal(status, 404);
  });
});

describe("validation", () => {
  it("rejects a missing company and role", async () => {
    const { status, json } = await api("POST", "/api/applications", {});
    assert.equal(status, 400);
    assert.deepEqual(json.details, ["company is required", "role is required"]);
  });

  it("rejects bad status, date, and url", async () => {
    const { status, json } = await api("POST", "/api/applications", {
      company: "X",
      role: "Y",
      status: "ghosted",
      followUpDate: "2026-02-30",
      url: "javascript:alert(1)",
    });
    assert.equal(status, 400);
    assert.equal(json.details.length, 3);
  });

  it("rejects invalid JSON and non-object bodies", async () => {
    const res = await fetch(base + "/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    const arr = await api("POST", "/api/applications", [1, 2]);
    assert.equal(arr.status, 400);
  });

  it("rejects oversized bodies with 413", async () => {
    const { status } = await api("POST", "/api/applications", {
      company: "X",
      role: "Y",
      notes: "a".repeat(200_000),
    });
    assert.equal(status, 413);
  });
});

describe("updating", () => {
  it("sets the applied date the first time status becomes applied", async () => {
    const created = await api("POST", "/api/applications", { company: "Shopify", role: "Intern" });
    const moved = await api("PATCH", `/api/applications/${created.json.id}`, { status: "applied" });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.status, "applied");
    assert.equal(moved.json.appliedDate, "2026-11-25");
  });

  it("does not overwrite an existing applied date", async () => {
    const created = await api("POST", "/api/applications", {
      company: "RBC",
      role: "Intern",
      appliedDate: "2026-10-01",
    });
    const moved = await api("PATCH", `/api/applications/${created.json.id}`, { status: "applied" });
    assert.equal(moved.json.appliedDate, "2026-10-01");
  });

  it("clears optional fields with null or empty string", async () => {
    const created = await api("POST", "/api/applications", {
      company: "TD",
      role: "Intern",
      notes: "referral from Sam",
    });
    const cleared = await api("PATCH", `/api/applications/${created.json.id}`, { notes: "" });
    assert.equal(cleared.json.notes, null);
  });

  it("returns 404 when updating a missing application", async () => {
    const { status } = await api("PATCH", "/api/applications/999999", { status: "offer" });
    assert.equal(status, 404);
  });
});

describe("listing, search, and stats", () => {
  it("filters by status and searches text, treating % literally", async () => {
    await api("POST", "/api/applications", {
      company: "Acme 100% Remote",
      role: "Dev",
      status: "interview",
    });
    await api("POST", "/api/applications", { company: "Acmeville", role: "Dev", status: "offer" });

    const interviews = await api("GET", "/api/applications?status=interview");
    assert.ok(interviews.json.every((a: { status: string }) => a.status === "interview"));
    assert.ok(interviews.json.length >= 1);

    const literal = await api("GET", "/api/applications?q=" + encodeURIComponent("100%"));
    assert.equal(literal.json.length, 1);
    assert.equal(literal.json[0].company, "Acme 100% Remote");

    const bad = await api("GET", "/api/applications?status=nope");
    assert.equal(bad.status, 400);
  });

  it("reports counts by status", async () => {
    const { json } = await api("GET", "/api/stats");
    const sum = Object.values(json.byStatus as Record<string, number>).reduce((a, b) => a + b, 0);
    assert.equal(json.total, sum);
    assert.ok(json.total >= 5);
  });
});

describe("follow-up reminders", () => {
  it("returns only active applications due on or before today", async () => {
    const due = await api("POST", "/api/applications", {
      company: "DueCo",
      role: "Dev",
      status: "applied",
      followUpDate: "2026-12-01",
    });
    const later = await api("POST", "/api/applications", {
      company: "LaterCo",
      role: "Dev",
      status: "applied",
      followUpDate: "2026-12-20",
    });
    const rejected = await api("POST", "/api/applications", {
      company: "RejectedCo",
      role: "Dev",
      status: "rejected",
      followUpDate: "2026-11-01",
    });

    const { status, json } = await api("GET", "/api/reminders?today=2026-12-02");
    assert.equal(status, 200);
    const ids = json.map((a: { id: number }) => a.id);
    assert.ok(ids.includes(due.json.id));
    assert.ok(!ids.includes(later.json.id));
    assert.ok(!ids.includes(rejected.json.id));

    const bad = await api("GET", "/api/reminders?today=tomorrow");
    assert.equal(bad.status, 400);
  });
});

describe("deleting", () => {
  it("deletes an application and then 404s", async () => {
    const created = await api("POST", "/api/applications", { company: "Gone", role: "Dev" });
    const del = await api("DELETE", `/api/applications/${created.json.id}`);
    assert.equal(del.status, 204);
    const again = await api("DELETE", `/api/applications/${created.json.id}`);
    assert.equal(again.status, 404);
  });

  it("rejects unsupported methods with 405", async () => {
    const { status, headers } = await api("PUT", "/api/applications/1", {});
    assert.equal(status, 405);
    assert.match(headers.get("allow") ?? "", /PATCH/);
  });
});

describe("CSV export", () => {
  it("exports applications as an attachment with a header row", async () => {
    const res = await fetch(base + "/api/applications/export.csv");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
    const text = await res.text();
    assert.ok(text.startsWith("Company,Role,Status,Location,Applied,Follow up,URL,Notes\r\n"));
  });

  it("quotes special characters and neutralizes spreadsheet formulas", async () => {
    await api("POST", "/api/applications", {
      company: '=HYPERLINK("http://evil.example")',
      role: 'Dev, "Senior"',
      notes: "line one\nline two",
    });
    const text = await (await fetch(base + "/api/applications/export.csv?q=HYPERLINK")).text();
    const row = text.split("\r\n")[1] ?? "";
    assert.ok(row.startsWith(`"'=HYPERLINK(""http://evil.example"")",`), row);
    assert.ok(row.includes('"Dev, ""Senior"""'));
    assert.ok(row.includes('"line one\nline two"'));
  });

  it("respects filters and rejects bad ones", async () => {
    const text = await (await fetch(base + "/api/applications/export.csv?status=offer")).text();
    const dataRows = text.trim().split("\r\n").slice(1);
    assert.ok(dataRows.length >= 1);
    assert.ok(dataRows.every((r) => r.split(",")[2] === "offer"));
    const bad = await fetch(base + "/api/applications/export.csv?status=nope");
    assert.equal(bad.status, 400);
  });
});

describe("static files", () => {
  it("serves the frontend with security headers", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  });

  it("blocks path traversal", async () => {
    // fetch() would normalize ../ away, so send the raw request path ourselves.
    const status = await new Promise<number>((resolveStatus, reject) => {
      const { port } = server.address() as AddressInfo;
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/..%2f..%2fpackage.json", method: "GET" },
        (res) => {
          res.resume();
          resolveStatus(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 404);
  });
});
