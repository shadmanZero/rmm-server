/**
 * Leveled logger + an in-memory log store the dashboard's `/logs` page tails live.
 *
 * Every server log line still prints to the console, but it is also pushed into a
 * bounded ring buffer and fanned out to any live subscribers (the `/admin/logs`
 * WebSocket). Agent traces forwarded over the control channel are merged into the
 * same stream via {@link ingest}, so the page shows the whole pipeline — server and
 * endpoint — in one place.
 */

export type LogLevel = "trace" | "info" | "warn" | "error";

/** One structured log line. `source` is `"server"` or a device name/id for agents. */
export interface LogEntry {
  /** Unix epoch milliseconds. */
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
}

/** Newest-N lines kept for replay when a viewer connects. */
const BUFFER_LIMIT = 1000;

const buffer: LogEntry[] = [];
const subscribers = new Set<(entry: LogEntry) => void>();

const LEVELS: readonly LogLevel[] = ["trace", "info", "warn", "error"];

/** Coerce an untrusted level string to a known level (defaults to `info`). */
export function normalizeLevel(value: unknown): LogLevel {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value)
    ? (value as LogLevel)
    : "info";
}

/** Push an entry into the ring buffer and notify subscribers (never throws). */
function record(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) buffer.shift();
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {
      // A broken subscriber must never break logging or other subscribers.
    }
  }
}

/** Print a server log line to the console and record it for the live tail. */
function emit(level: LogLevel, message: string): void {
  const entry: LogEntry = { ts: Date.now(), level, source: "server", message };
  const line = `${new Date(entry.ts).toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  record(entry);
}

/**
 * Merge an externally-sourced log line (e.g. an agent trace forwarded over the
 * control channel) into the live stream. Not echoed to the server console — it
 * already happened on the endpoint — only buffered and broadcast.
 */
export function ingest(input: { level: unknown; source: string; message: string }): void {
  record({
    ts: Date.now(),
    level: normalizeLevel(input.level),
    source: input.source || "agent",
    message: input.message,
  });
}

/** A snapshot of the buffered lines (oldest first) for replay on connect. */
export function snapshot(): readonly LogEntry[] {
  return buffer.slice();
}

/** Subscribe to new entries; returns an unsubscribe function. */
export function subscribe(fn: (entry: LogEntry) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export const logger = {
  info: (message: string) => emit("info", message),
  warn: (message: string) => emit("warn", message),
  error: (message: string) => emit("error", message),
};
