/**
 * Unit tests for the log store's origin/identity tagging — the data model behind the
 * dashboard's server-vs-agent differentiation and per-PC filtering.
 *
 * Run with: `npm test` (node's built-in runner via the tsx loader).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ingest, logger, normalizeLevel, snapshot } from "./log";

test("ingest tags agent origin and carries the stable deviceId", () => {
  ingest({ level: "warn", source: "Reception PC", deviceId: "dev-123", message: "hello" });
  const last = snapshot().at(-1);
  assert.equal(last?.kind, "agent");
  assert.equal(last?.deviceId, "dev-123");
  assert.equal(last?.source, "Reception PC");
  assert.equal(last?.level, "warn");
  assert.equal(last?.message, "hello");
});

test("ingest falls back to an 'agent' label and coerces an unknown level", () => {
  ingest({ level: "bogus", source: "", message: "x" });
  const last = snapshot().at(-1);
  assert.equal(last?.kind, "agent");
  assert.equal(last?.source, "agent");
  assert.equal(last?.level, "info");
  assert.equal(last?.deviceId, undefined);
});

test("server logs are tagged kind=server with no deviceId", () => {
  logger.info("a server line");
  const last = snapshot().at(-1);
  assert.equal(last?.kind, "server");
  assert.equal(last?.source, "server");
  assert.equal(last?.deviceId, undefined);
});

test("normalizeLevel keeps known levels and coerces the rest to info", () => {
  assert.equal(normalizeLevel("trace"), "trace");
  assert.equal(normalizeLevel("error"), "error");
  assert.equal(normalizeLevel("nope"), "info");
  assert.equal(normalizeLevel(42), "info");
  assert.equal(normalizeLevel(undefined), "info");
});
