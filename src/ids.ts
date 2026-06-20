/**
 * Opaque id / token minting.
 *
 * Tokens are cryptographically random and prefixed for readability in logs. The
 * device token is the only secret the agent holds after enrollment; session tokens
 * are single-use pairing credentials for the relay.
 */

import { randomBytes } from "crypto";

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

/** Long-lived per-device credential (Bearer on the control channel). */
export const newDeviceToken = (): string => `dk_${hex(24)}`;

/** Short, human-scannable session identifier. */
export const newSessionId = (): string => `s_${hex(8)}`;

/** Single-use credential presented by both relay roles for one session. */
export const newSessionToken = (): string => `st_${hex(24)}`;

/** Informational per-tenant id. */
export const newTenantId = (): string => `org_${hex(6)}`;
