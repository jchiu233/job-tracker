# Job Tracker

A kanban-style job application tracker. Drag applications across **Wishlist → Applied → Interview → Offer → Rejected**, keep notes and posting links, and get a banner when a follow-up is due.

Built with TypeScript on Node, a REST API, and SQLite. The backend has **no runtime dependencies**: it uses Node's built-in `http`, `node:sqlite`, and `node:test`.

## Features

- Add, edit, delete, and search applications (company, role, location, URL, notes, dates)
- Drag-and-drop board that persists status changes through the API
- Follow-up reminders: applications past their follow-up date are surfaced in a banner and flagged on the card
- CSV export (honors the same filters as search) that guards against spreadsheet formula injection
- Applied date is filled in automatically the first time an application moves to "Applied"
- Input validation with clear error messages, security headers, and a request size limit
- Light and dark mode, keyboard accessible cards

## Getting started

Requires **Node 22.13 or newer**.

```bash
npm install
npm start          # http://127.0.0.1:3000
```

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm start`         | Run the app                                   |
| `npm run dev`       | Run with auto-restart on file changes         |
| `npm test`          | Run the test suite                            |
| `npm run typecheck` | Strict TypeScript check                       |

Configuration is by environment variable: `PORT` (default 3000), `HOST` (default `127.0.0.1`), and `DB_PATH` (default `data/tracker.db`).

## API

| Method   | Path                      | Description                                                      |
| -------- | ------------------------- | ---------------------------------------------------------------- |
| `GET`    | `/api/applications`       | List. Optional `?status=applied` and `?q=search text`            |
| `POST`   | `/api/applications`       | Create. `company` and `role` are required                        |
| `GET`    | `/api/applications/:id`   | Fetch one                                                        |
| `PATCH`  | `/api/applications/:id`   | Partial update. Send `null` or `""` to clear an optional field   |
| `DELETE` | `/api/applications/:id`   | Delete                                                           |
| `GET`    | `/api/applications/export.csv` | Download as CSV. Same `status` and `q` filters as the list  |
| `GET`    | `/api/stats`              | Counts per status                                                |
| `GET`    | `/api/reminders?today=YYYY-MM-DD` | Active applications whose follow-up date has arrived     |

Errors return JSON like `{ "error": "Validation failed", "details": ["company is required"] }` with a suitable status code (400, 404, 405, 413).

```bash
curl -X POST localhost:3000/api/applications \
  -H 'Content-Type: application/json' \
  -d '{"company":"EQ Bank","role":"Software Engineer Intern","status":"applied","followUpDate":"2026-12-05"}'
```

## Project layout

```
src/
  db.ts        SQLite schema and the ApplicationStore (all SQL lives here)
  validate.ts  Request validation and normalization
  server.ts    HTTP routing, JSON parsing, static files, error handling
  index.ts     Entry point: config, startup, graceful shutdown
public/        Vanilla JS frontend (no build step)
tests/         API tests using node:test against a real in-memory database
```

## Design decisions

- **Layers are separate.** Routing (`server.ts`), validation (`validate.ts`), and persistence (`db.ts`) don't know about each other's internals, so each is testable and replaceable. Swapping SQLite for Postgres would only touch `db.ts`.
- **SQL injection:** every query is parameterized. The one dynamically built statement (`UPDATE`) takes its column names from a fixed allow-list, never from the request.
- **XSS:** the frontend only inserts user text with `textContent`, and a Content-Security-Policy blocks inline scripts as a second layer. The tests and a browser check confirm `<img onerror=...>` is displayed as text.
- **Path traversal:** static files are resolved and checked to stay inside `public/`.
- **Time zones:** "due today" is computed from the browser's local date, passed to the API, so reminders don't flip a day early or late for the user.
- **LIKE wildcards are escaped,** so searching for `100%` matches that text instead of everything.
- **No auth, on purpose.** It's a single-user local tool, so it binds to `127.0.0.1` by default. See "Ideas" below before exposing it to a network.

## Tests

`npm test` runs 20 tests covering creation, validation, partial updates, the auto-filled applied date, search and filters, reminders, deletion, CSV export, 405/413 handling, security headers, and path traversal.

## Ideas to extend it

These are good next steps, and each one gives you something concrete to talk about in an interview:

1. **Authentication** (sessions or JWT) plus a `user_id` column, so it can be hosted for multiple people
2. **Email reminders** for due follow-ups using a scheduled job
3. **Status history** table, to chart how long applications spend in each stage
4. **Swap SQLite for Postgres** and run both with Docker Compose
5. **Rewrite the frontend in Angular**, since the API is already separate
6. **Import** from CSV (export is already built)
7. **Deploy it** (Fly.io, Render, Railway) with a persistent volume

## License

MIT
