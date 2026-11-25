import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { toCsv } from "./csv.js";
import { STATUSES, type ApplicationStore, type ListFilter } from "./db.js";
import { isDate, isStatus, parseCreate, parsePatch } from "./validate.js";

const MAX_BODY_BYTES = 100_000;

class HttpError extends Error {
  status: number;
  details: string[] | undefined;
  headers: Record<string, string> | undefined;

  constructor(
    status: number,
    message: string,
    options: { details?: string[]; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.status = status;
    this.details = options.details;
    this.headers = options.headers;
  }
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(payload);
}

/** Read and parse a JSON object body, enforcing a size limit without killing the connection. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true; // keep draining the request, but stop storing it
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) return reject(new HttpError(413, "Request body too large"));
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reject(new HttpError(400, "Request body must be valid JSON"));
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return reject(new HttpError(400, "Request body must be a JSON object"));
      }
      resolvePromise(parsed as Record<string, unknown>);
    });
  });
}

async function handleApi(
  store: ApplicationStore,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const method = req.method ?? "GET";
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (path === "/api/stats") {
    if (method !== "GET") throw notAllowed("GET");
    return sendJson(res, 200, store.stats());
  }

  if (path === "/api/reminders") {
    if (method !== "GET") throw notAllowed("GET");
    // The browser passes its own local date so "due today" respects the user's time zone.
    const today = url.searchParams.get("today") ?? new Date().toISOString().slice(0, 10);
    if (!isDate(today)) throw new HttpError(400, "today must be a valid date in YYYY-MM-DD format");
    return sendJson(res, 200, store.dueFollowUps(today));
  }

  if (path === "/api/applications/export.csv") {
    if (method !== "GET") throw notAllowed("GET");
    const csv = toCsv(store.list(parseListFilter(url)));
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="job-applications.csv"',
      "Content-Length": Buffer.byteLength(csv),
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
    });
    return void res.end(csv);
  }

  if (path === "/api/applications") {
    if (method === "GET") {
      return sendJson(res, 200, store.list(parseListFilter(url)));
    }
    if (method === "POST") {
      const parsed = parseCreate(await readJsonBody(req));
      if (!parsed.ok) throw new HttpError(400, "Validation failed", { details: parsed.errors });
      return sendJson(res, 201, store.create(parsed.value));
    }
    throw notAllowed("GET, POST");
  }

  const match = path.match(/^\/api\/applications\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);

    if (method === "GET") {
      const app = store.get(id);
      if (!app) throw new HttpError(404, "Application not found");
      return sendJson(res, 200, app);
    }
    if (method === "PATCH") {
      const parsed = parsePatch(await readJsonBody(req));
      if (!parsed.ok) throw new HttpError(400, "Validation failed", { details: parsed.errors });
      const updated = store.update(id, parsed.value);
      if (!updated) throw new HttpError(404, "Application not found");
      return sendJson(res, 200, updated);
    }
    if (method === "DELETE") {
      if (!store.delete(id)) throw new HttpError(404, "Application not found");
      res.writeHead(204, { ...SECURITY_HEADERS });
      return void res.end();
    }
    throw notAllowed("GET, PATCH, DELETE");
  }

  throw new HttpError(404, "Not found");
}

/** Read and validate the ?status= and ?q= filters shared by the list and export endpoints. */
function parseListFilter(url: URL): ListFilter {
  const status = url.searchParams.get("status") ?? undefined;
  const q = url.searchParams.get("q")?.trim() || undefined;
  if (status !== undefined && !isStatus(status)) {
    throw new HttpError(400, `status must be one of: ${STATUSES.join(", ")}`);
  }
  if (q !== undefined && q.length > 100) {
    throw new HttpError(400, "q must be at most 100 characters");
  }
  return { status, q };
}

function notAllowed(allow: string): HttpError {
  return new HttpError(405, "Method not allowed", { headers: { Allow: allow } });
}

async function serveStatic(publicDir: string, pathname: string, res: ServerResponse): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Bad request");
  }
  if (decoded.includes("\0")) throw new HttpError(400, "Bad request");

  const root = resolve(publicDir);
  const file = resolve(root, "." + (decoded === "/" ? "/index.html" : decoded));
  // Path traversal guard: the resolved file must stay inside the public directory.
  if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, "Not found");

  const type = MIME_TYPES[extname(file)];
  if (!type) throw new HttpError(404, "Not found");

  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    throw new HttpError(404, "Not found");
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

export function createApp(store: ApplicationStore, options: { publicDir: string }): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(store, req, res, url);
      } else if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(options.publicDir, url.pathname, res);
      } else {
        throw notAllowed("GET, HEAD");
      }
    } catch (err) {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) {
        const body: { error: string; details?: string[] } = { error: err.message };
        if (err.details) body.details = err.details;
        return sendJson(res, err.status, body, err.headers);
      }
      console.error(err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });
}
