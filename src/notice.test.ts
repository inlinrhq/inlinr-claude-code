import { expect, test } from "bun:test";
import { sessionNotice } from "./notice";

const now = Date.parse("2026-10-13T23:00:00Z");

test("says nothing when connected and healthy", () => {
  expect(sessionNotice(true, null, now)).toBeNull();
  expect(
    sessionNotice(
      true,
      "2026-10-13T22:00:00Z ingest rejected a batch (HTTP 500)",
      now,
    ),
  ).toBeNull();
});

test("asks Claude to offer activation when not connected", () => {
  expect(sessionNotice(false, null, now)).toContain("inlinr:activate");
});

test("flags a recent 401 as a revoked device", () => {
  expect(
    sessionNotice(
      true,
      "2026-10-13T22:00:00Z ingest rejected a batch (HTTP 401)",
      now,
    ),
  ).toContain("refused");
});

test("ignores an old 401", () => {
  expect(
    sessionNotice(
      true,
      "2026-10-10T22:00:00Z ingest rejected a batch (HTTP 401)",
      now,
    ),
  ).toBeNull();
});

test("in a cloud session, offers the connection that also covers later sessions", () => {
  const notice = sessionNotice(false, null, now, 'node "/tmp/x.js"');
  expect(notice).toContain('node "/tmp/x.js" activate --cloud');
  expect(notice).toContain("Setup script");
  expect(notice).not.toContain("inlinr:activate");
});

test("in a connected cloud session, says nothing", () => {
  expect(sessionNotice(true, null, now, 'node "/tmp/x.js"')).toBeNull();
});
