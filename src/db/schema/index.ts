/**
 * Schema barrel — the single import surface for every table.
 *
 * `drizzle()` is handed this whole namespace (`import * as schema`) so the query
 * builder knows the full model; application code imports the named tables/types it
 * needs from here.
 */

export { users, type User, type NewUser } from "./users";
export {
  authSessions,
  type AuthSession,
  type NewAuthSession,
} from "./sessions";
