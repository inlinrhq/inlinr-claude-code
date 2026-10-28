import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSyncLock,
  load,
  SYNC_LOCK_STALE_MS,
  save,
  trustedApiUrl,
} from "./config";

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inlinr-cc-"));
  process.env.INLINR_HOME = home;
});
afterEach(() => {
  delete process.env.INLINR_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("one sync at a time", () => {
  const release = acquireSyncLock();
  expect(release).not.toBeNull();
  expect(acquireSyncLock()).toBeNull();
  release?.();
  const again = acquireSyncLock();
  expect(again).not.toBeNull();
  again?.();
});

test("a lock left by a dead sync is taken over", () => {
  acquireSyncLock();
  const old = (Date.now() - SYNC_LOCK_STALE_MS - 1000) / 1000;
  utimesSync(join(home, "claude-code.lock"), old, old);
  expect(acquireSyncLock()).not.toBeNull();
});

test("save writes through a temporary file of its own", () => {
  const config = { ...load(), deviceToken: "in_d_x" };
  save(config);
  save(config);
  expect(load().deviceToken).toBe("in_d_x");
});

test("the token only ever goes to inlinr.com or this machine", () => {
  expect(trustedApiUrl(undefined)).toBe("https://inlinr.com");
  expect(trustedApiUrl("https://inlinr.com/")).toBe("https://inlinr.com");
  expect(trustedApiUrl("http://localhost:3000")).toBe("http://localhost:3000");
  expect(trustedApiUrl("http://127.0.0.1:3000/x")).toBe(
    "http://127.0.0.1:3000",
  );
  for (const hostile of [
    "https://evil.example",
    "http://inlinr.com",
    "https://inlinr.com.evil.example",
    "https://inlinr.com:8443",
    "https://user:pass@inlinr.com",
    "not a url",
  ]) {
    expect(trustedApiUrl(hostile)).toBe("https://inlinr.com");
  }
});

test("an address from the environment is checked like any other", () => {
  process.env.INLINR_API_URL = "https://evil.example";
  try {
    expect(load().apiUrl).toBe("https://inlinr.com");
  } finally {
    delete process.env.INLINR_API_URL;
  }
});
