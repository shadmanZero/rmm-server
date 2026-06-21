/**
 * `auth_sessions` — server-side login sessions for dashboard operators.
 *
 * Named with the `auth_` prefix to keep them distinct from the *remote-desktop*
 * sessions in {@link ../../registry}, which are ephemeral and live only in memory.
 * The primary key is the opaque, high-entropy session token handed to the browser in
 * an httpOnly cookie; a row's existence (and unexpired `expiresAt`) is what makes a
 * request authenticated. Deleting the parent user cascades their sessions away.
 */

import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users";

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("auth_sessions_user_id_idx").on(table.userId)],
);

export type AuthSession = typeof authSessions.$inferSelect;
export type NewAuthSession = typeof authSessions.$inferInsert;
