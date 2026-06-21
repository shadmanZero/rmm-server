/**
 * Drizzle Kit configuration — drives `pull` (introspect), `generate`, `migrate`,
 * `push`, and `studio`.
 *
 * The connection string lives only in the environment (`DATABASE_URL`), never in
 * source. `pull` writes the introspected schema under `src/db/schema/`; hand-authored
 * tables live alongside it and are versioned as SQL under `drizzle/`.
 */

import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set — copy .env.example to .env and fill it in.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl },
  // The target Postgres exposes a plain (non-TLS) port; the URL carries
  // `sslmode=disable`, and we mirror that here so the kit never negotiates TLS.
  casing: "snake_case",
  verbose: true,
  strict: true,
});
