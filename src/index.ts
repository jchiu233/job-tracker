import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApplicationStore } from "./db.js";
import { createApp } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
// Bound to localhost by default: there is no login, so don't expose it to the network.
const host = process.env.HOST ?? "127.0.0.1";
const dbPath = resolve(process.env.DB_PATH ?? resolve(here, "../data/tracker.db"));

mkdirSync(dirname(dbPath), { recursive: true });

const store = new ApplicationStore(dbPath);
const server = createApp(store, { publicDir: resolve(here, "../public") });

server.listen(port, host, () => {
  console.log(`Job Tracker running at http://${host}:${port}  (database: ${dbPath})`);
});

function shutdown(): void {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
