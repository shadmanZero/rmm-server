/**
 * Seed (or update) the dashboard admin operator.
 *
 *   npm run db:seed
 *
 * Idempotent: keyed on the admin username, re-running refreshes the name and
 * password from the environment rather than creating duplicates. Credentials come
 * only from `AUTH_ADMIN_*` env vars — nothing is hardcoded.
 */

import "dotenv/config";
import { db, sql } from "./client";
import { users } from "./schema";
import { config } from "../config";
import { hashPassword } from "../auth/password";
import { logger } from "../log";

async function main(): Promise<void> {
  const { name, username, password } = config.auth.admin;

  if (!username || !password) {
    throw new Error(
      "AUTH_ADMIN_USERNAME and AUTH_ADMIN_PASSWORD must be set to seed the admin user.",
    );
  }

  const passwordHash = await hashPassword(password);

  const [row] = await db
    .insert(users)
    .values({ username, name, passwordHash })
    .onConflictDoUpdate({
      target: users.username,
      set: { name, passwordHash, updatedAt: new Date() },
    })
    .returning({ id: users.id, username: users.username, name: users.name });

  logger.info(`seeded admin "${row.name}" (username: ${row.username}, id: ${row.id})`);
}

main()
  .then(() => sql.end())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    logger.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  });
