import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configDir,
  load,
  machineToken,
  save,
  saveMachineToken,
  tokenSource,
  tokenTag,
} from "../config";
import { activate } from "./activate";
import { deactivate } from "./deactivate";
import { sync } from "./sync";

const A = "in_d_machine_connection_aaaaaaaaaaaa";
const B = "in_d_new_connection_bbbbbbbbbbbbbbbbbb";
const OWN = "in_d_older_release_own_token_cccccccc";

const ok =
  (body: unknown = {}) =>
  () =>
    Response.json(body);

let home = "";
let envToken: string | undefined;
let realHome: string | undefined;
let calls: string[] = [];
let answers: Record<string, () => Response> = {};
const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inlinr-conn-"));
  process.env.INLINR_HOME = home;
  // No session file of this machine is read (Gemini CLI's folder has no
  // override; its beats, if any, go to the stub below).
  realHome = process.env.HOME;
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = home;
  process.env.CODEX_HOME = home;
  envToken = process.env.INLINR_TOKEN;
  delete process.env.INLINR_TOKEN;
  calls = [];
  answers = { "/api/v1/heartbeats": ok({ accepted: 0 }) };
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const path = new URL(String(url)).pathname;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push(`${path} ${auth.replace("Bearer ", "")}`.trim());
    const answer = answers[path];
    return answer ? answer() : new Response("{}", { status: 404 });
  }) as typeof fetch;
  console.log = () => {};
  console.error = () => {};
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  delete process.env.INLINR_HOME;
  process.env.HOME = realHome;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  if (envToken !== undefined) process.env.INLINR_TOKEN = envToken;
  rmSync(home, { recursive: true, force: true });
});

const deviceFlow = (token: string) => {
  answers["/api/auth/device"] = ok({
    device_code: "d",
    user_code: "U",
    verification_uri: "http://localhost/activate",
    verification_uri_complete: "http://localhost/activate?code=U",
    interval: 0,
    expires_in: 30,
  });
  answers["/api/auth/device/token"] = ok({ access_token: token });
  answers["/api/auth/device/revoke"] = ok();
};

test("a machine deactivated by an older release stays off", () => {
  writeFileSync(
    join(home, "claude-code.json"),
    JSON.stringify({ deviceToken: "", lastParsedAt: null, files: {} }),
  );
  saveMachineToken(A);
  const config = load();
  expect(config.paused).toBe(true);
  expect(tokenSource(config)).toBeNull();
});

test("no file at all is not paused: the machine's connection is used", () => {
  saveMachineToken(A);
  expect(tokenSource(load())).toEqual({ token: A, from: "machine" });
});

test("pausing keeps the machine's connection for the other plugins", async () => {
  saveMachineToken(A);
  await sync(load(), 0);
  expect(await deactivate(load(), "pause")).toBe(0);
  expect(machineToken()).toBe(A);
  expect(load().paused).toBe(true);
  expect(calls).not.toContain(`/api/auth/device/revoke ${A}`);
});

test("without a choice, deactivate changes nothing", async () => {
  saveMachineToken(A);
  await deactivate(load(), null);
  expect(machineToken()).toBe(A);
  expect(load().paused).toBe(false);
  expect(calls).toEqual([]);
});

test("disconnecting the machine revokes and clears the shared token", async () => {
  saveMachineToken(A);
  answers["/api/auth/device/revoke"] = ok();
  await deactivate(load(), "machine");
  expect(calls).toContain(`/api/auth/device/revoke ${A}`);
  expect(machineToken()).toBe("");
  expect(tokenSource(load())).toBeNull();
});

test("activating a connected machine keeps its account and resumes", async () => {
  saveMachineToken(A);
  save({ ...load(), paused: true });
  answers["/api/v1/me/today"] = ok({ seconds: 0 });
  expect(await activate(load())).toBe(0);
  expect(calls).toEqual([`/api/v1/me/today ${A}`]);
  const config = load();
  expect(config.paused).toBe(false);
  expect(config.tokenTag).toBe(tokenTag(A));
  expect(machineToken()).toBe(A);
});

test("offline, activating a connected machine changes nothing", async () => {
  saveMachineToken(A);
  answers["/api/v1/me/today"] = () => {
    throw new Error("offline");
  };
  expect(await activate(load())).toBe(1);
  expect(machineToken()).toBe(A);
});

test("a revoked connection is replaced, and the old device revoked", async () => {
  saveMachineToken(A);
  answers["/api/v1/me/today"] = () => new Response("{}", { status: 401 });
  deviceFlow(B);
  expect(await activate(load())).toBe(0);
  expect(machineToken()).toBe(B);
  expect(calls).toContain(`/api/auth/device/revoke ${A}`);
}, 10000);

test("--replace switches the account and revokes both older tokens", async () => {
  saveMachineToken(A);
  save(
    { ...load(), deviceToken: OWN, lastParsedAt: "2026-10-01T00:00:00Z" },
    "set",
  );
  deviceFlow(B);
  expect(await activate(load(), { replace: true })).toBe(0);
  expect(machineToken()).toBe(B);
  expect(load().deviceToken).toBe("");
  expect(calls).toContain(`/api/auth/device/revoke ${A}`);
  expect(calls).toContain(`/api/auth/device/revoke ${OWN}`);
  expect(calls).not.toContain(`/api/auth/device/revoke ${B}`);
}, 10000);

test("an older release's own token moves to config.toml, positions kept", async () => {
  save(
    {
      ...load(),
      deviceToken: OWN,
      lastParsedAt: "2026-10-01T00:00:00.000Z",
      tokenTag: tokenTag(OWN),
      paused: false,
    },
    "set",
  );
  await sync(load(), 0);
  expect(machineToken()).toBe(OWN);
  const config = load();
  expect(config.deviceToken).toBe("");
  expect(config.lastParsedAt).toBe("2026-10-01T00:00:00.000Z");
});

test("two different connections are both kept", async () => {
  saveMachineToken(A);
  save(
    { ...load(), deviceToken: OWN, lastParsedAt: "2026-10-01T00:00:00.000Z" },
    "set",
  );
  await sync(load(), 0);
  expect(machineToken()).toBe(A);
  expect(load().deviceToken).toBe(OWN);
});

test("a sync does not bring back a token cleared meanwhile", () => {
  save(
    { ...load(), deviceToken: OWN, lastParsedAt: "2026-10-01T00:00:00.000Z" },
    "set",
  );
  const loaded = load();
  // `inlinr signout` clears it while the sync runs.
  save({ ...load(), deviceToken: "" }, "set");
  save({ ...loaded, lastSyncAt: new Date().toISOString() });
  expect(load().deviceToken).toBe("");
});

test("INLINR_HOME moves the folder in tests only", () => {
  expect(configDir()).toBe(home);
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    expect(configDir()).not.toBe(home);
  } finally {
    process.env.NODE_ENV = env;
  }
});
