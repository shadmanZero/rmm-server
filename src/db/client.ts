/**
 * The shared Drizzle database handle.
 *
 * One postgres.js connection pool per process, wrapped by Drizzle. The connection
 * string comes only from `DATABASE_URL` (never hardcoded). The target database is
 * reached over a plain port (`sslmode=disable` in the URL); postgres.js does not
 * negotiate TLS unless asked, so the default is exactly right here.
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set — copy .env.example to .env and fill it in.");
}

/** Raw postgres.js client — exported so scripts can close it and exit cleanly. */
export const sql = postgres(databaseUrl, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 15,
  // The control plane has no use for server NOTICE chatter on stderr.
  onnotice: () => {},
});

export const db = drizzle(sql, { schema, casing: "snake_case" });
