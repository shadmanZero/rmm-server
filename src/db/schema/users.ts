/**
 * `users` — dashboard operators who can sign in to the control plane.
 *
 * Passwords are never stored in the clear: `passwordHash` holds a self-describing
 * scrypt digest (see {@link ../../auth/password}). Usernames are stored lowercased
 * and unique so logins are case-insensitive.
 */

import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
