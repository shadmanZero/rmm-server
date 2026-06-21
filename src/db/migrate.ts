/**
 * Apply pending SQL migrations from `drizzle/` to the database.
 *
 * Uses Drizzle's runtime migrator (no `drizzle-kit` needed), so it runs inside the
 * lean production image too. Idempotent: already-applied migrations are skipped via
 * the `drizzle.__drizzle_migrations` bookkeeping table. Intended to run once on
 * deploy, before the server starts serving.
 */

import "dotenv/config";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./client";
import { logger } from "../log";

async function main(): Promise<void> {
  logger.info("applying database migrations…");
  await migrate(db, { migrationsFolder: "drizzle" });
  logger.info("database schema is up to date");
}

main()
  .then(() => sql.end())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    logger.error(`migration failed: ${err instanceof Error ? err.message : String(err)}`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  });
