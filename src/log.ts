/** Minimal leveled logger with ISO timestamps — no dependency, structured enough. */

type Level = "info" | "warn" | "error";

function emit(level: Level, message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (message: string) => emit("info", message),
  warn: (message: string) => emit("warn", message),
  error: (message: string) => emit("error", message),
};
