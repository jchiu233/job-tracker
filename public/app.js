// Frontend for the job tracker. Plain ES modules, no build step.
// Security note: all user-provided text is inserted with textContent (never innerHTML),
// so a company name like "<img onerror=...>" is displayed as text instead of executed.

const COLUMNS = [
  { key: "wishlist", label: "Wishlist" },
  { key: "applied", label: "Applied" },
  { key: "interview", label: "Interview" },
  { key: "offer", label: "Offer" },
  { key: "rejected", label: "Rejected" },
];

const $ = (selector) => document.querySelector(selector);
const board = $("#board");
const dialog = $("#dialog");
const form = $("#form");
const searchInput = $("#search");

let applications = [];

// ---------- helpers ----------

/** Create an element: el("div", { class: "x", onclick: fn }, "text", childElement) */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || res.statusText);
    error.details = data.details || [];
    throw error;
  }
  return data;
}

// ---------- loading and rendering ----------

async function load() {
  const q = searchInput.value.trim();
  const query = q ? `?q=${encodeURIComponent(q)}` : "";
  const [apps, stats, due] = await Promise.all([
    api(`/api/applications${query}`),
    api("/api/stats"),
    api(`/api/reminders?today=${todayLocal()}`),
  ]);
  applications = apps;
  renderSummary(stats);
  renderReminders(due);
  renderBoard();
}

function renderSummary(stats) {
  const { total, byStatus } = stats;
  $("#summary").textContent =
    total === 0
      ? "No applications yet"
      : `${total} application${total === 1 ? "" : "s"} · ${byStatus.interview} interviewing · ${byStatus.offer} offer${byStatus.offer === 1 ? "" : "s"}`;
}

function renderReminders(due) {
  const section = $("#reminders");
  const list = $("#reminders-list");
  list.replaceChildren();
  section.hidden = due.length === 0;
  if (due.length === 0) return;

  $("#reminders-title").textContent = `${due.length} follow-up${due.length === 1 ? "" : "s"} due`;
  for (const app of due) {
    list.append(
      el(
        "li",
        {},
        el(
          "button",
          { type: "button", class: "link", onclick: () => openDialog(app) },
          `${app.company} — ${app.role}`,
        ),
        el("span", { class: "muted" }, ` (due ${formatDate(app.followUpDate)})`),
      ),
    );
  }
}

function renderBoard() {
  board.replaceChildren();
  const today = todayLocal();

  for (const column of COLUMNS) {
    const items = applications.filter((a) => a.status === column.key);
    const list = el("div", { class: "column-list", "data-status": column.key });

    if (items.length === 0) list.append(el("p", { class: "empty muted" }, "Drop a card here"));
    for (const app of items) list.append(renderCard(app, today));

    // Drag-and-drop: the column is the drop target, the card is the drag source.
    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      list.classList.add("drag-over");
    });
    list.addEventListener("dragleave", () => list.classList.remove("drag-over"));
    list.addEventListener("drop", async (e) => {
      e.preventDefault();
      list.classList.remove("drag-over");
      const id = Number(e.dataTransfer.getData("text/plain"));
      const app = applications.find((a) => a.id === id);
      if (!app || app.status === column.key) return;
      try {
        await api(`/api/applications/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: column.key }),
        });
        await load();
      } catch (err) {
        alert(err.message);
      }
    });

    board.append(
      el(
        "section",
        { class: `column status-${column.key}`, "aria-label": column.label },
        el("h2", {}, column.label, el("span", { class: "count" }, items.length)),
        list,
      ),
    );
  }
}

function renderCard(app, today) {
  const overdue = app.followUpDate && app.followUpDate < today;
  const dueToday = app.followUpDate === today;
  const active = app.status !== "offer" && app.status !== "rejected";

  const card = el(
    "article",
    {
      class: "card",
      draggable: "true",
      tabindex: "0",
      role: "button",
      "aria-label": `${app.company}, ${app.role}. Press Enter to edit.`,
      onclick: () => openDialog(app),
      onkeydown: (e) => {
        if (e.key === "Enter") openDialog(app);
      },
      ondragstart: (e) => {
        e.dataTransfer.setData("text/plain", String(app.id));
        e.dataTransfer.effectAllowed = "move";
        card.classList.add("dragging");
      },
      ondragend: () => card.classList.remove("dragging"),
    },
    el("h3", {}, app.company),
    el("p", { class: "role" }, app.role),
    app.location && el("p", { class: "muted small" }, app.location),
    app.followUpDate &&
      active &&
      el(
        "span",
        { class: `chip${overdue ? " overdue" : dueToday ? " today" : ""}` },
        overdue ? "Overdue · " : dueToday ? "Today · " : "Follow up · ",
        formatDate(app.followUpDate),
      ),
  );
  return card;
}

// ---------- add / edit dialog ----------

const statusSelect = $("#status-select");
for (const c of COLUMNS) statusSelect.append(el("option", { value: c.key }, c.label));

let editingId = null;

function openDialog(app = null) {
  editingId = app ? app.id : null;
  form.reset();
  $("#form-errors").replaceChildren();
  $("#dialog-title").textContent = app ? "Edit application" : "Add application";
  $("#delete").hidden = !app;

  const values = app ?? { status: "wishlist" };
  for (const field of ["company", "role", "status", "location", "appliedDate", "followUpDate", "url", "notes"]) {
    form.elements[field].value = values[field] ?? "";
  }
  dialog.showModal();
  form.elements.company.focus();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  const errors = $("#form-errors");
  errors.replaceChildren();

  try {
    if (editingId) {
      await api(`/api/applications/${editingId}`, { method: "PATCH", body: JSON.stringify(body) });
    } else {
      await api("/api/applications", { method: "POST", body: JSON.stringify(body) });
    }
    dialog.close();
    await load();
  } catch (err) {
    const messages = err.details?.length ? err.details : [err.message];
    for (const m of messages) errors.append(el("li", {}, m));
  }
});

$("#cancel").addEventListener("click", () => dialog.close());
$("#add").addEventListener("click", () => openDialog());

$("#delete").addEventListener("click", async () => {
  if (!editingId || !confirm("Delete this application? This cannot be undone.")) return;
  try {
    await api(`/api/applications/${editingId}`, { method: "DELETE" });
    dialog.close();
    await load();
  } catch (err) {
    alert(err.message);
  }
});

// Close the dialog when clicking the dimmed backdrop.
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});

// ---------- search (debounced so we don't query on every keystroke) ----------

let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => load().catch(console.error), 200);
});

load().catch((err) => {
  board.replaceChildren(el("p", { class: "errors" }, `Could not load applications: ${err.message}`));
});
