import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSyncLock,
  load,
  machineToken,
  readMachineToken,
  SYNC_LOCK_STALE_MS,
  save,
  saveMachineToken,
  tokenSource,
  trustedApiUrl,
  withMachineToken,
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

const TOKEN = "in_d_abcdefghijklmnopqrstuvwxyz012345";

test("the machine's token is read from the [auth] table only", () => {
  expect(
    readMachineToken(`[auth]\n  device_token = "${TOKEN}"\n\n[behavior]\n`),
  ).toBe(TOKEN);
  expect(readMachineToken(`[auth]\ndevice_token = '${TOKEN}'\n`)).toBe(TOKEN);
  expect(readMachineToken(`[other]\ndevice_token = "${TOKEN}"\n`)).toBe("");
  expect(readMachineToken(`[auth]\n  device_token = ""\n`)).toBe("");
  // Anything that is not an inlinr token is not one.
  expect(readMachineToken(`[auth]\ndevice_token = "hello"\n`)).toBe("");
});

test("saving the machine's token keeps the rest of config.toml", () => {
  const cli = `[auth]\n  device_token = ""\n\n[behavior]\n  heartbeat_rate_limit_seconds = 120\n  error_reports = false\n`;
  const saved = withMachineToken(cli, TOKEN);
  expect(saved).toBe(
    cli.replace('device_token = ""', `device_token = "${TOKEN}"`),
  );
  expect(withMachineToken(saved, "")).toBe(cli);

  // No [auth] table yet, or no file at all.
  expect(withMachineToken("[behavior]\n  deps_sync = true\n", TOKEN)).toBe(
    `[behavior]\n  deps_sync = true\n\n[auth]\n  device_token = "${TOKEN}"\n`,
  );
  expect(readMachineToken(withMachineToken("", TOKEN))).toBe(TOKEN);
  // A table without the key gets it.
  expect(
    readMachineToken(withMachineToken("[auth]\n[behavior]\n", TOKEN)),
  ).toBe(TOKEN);
});

test("only an inlinr token is written into config.toml", () => {
  expect(() =>
    withMachineToken("", 'x"\n[behavior]\nerror_reports = false'),
  ).toThrow();
});

test("the token: this plugin's own, then the machine's, then the environment", () => {
  const saved = process.env.INLINR_TOKEN;
  delete process.env.INLINR_TOKEN;
  const config = load();
  expect(tokenSource(config)).toBeNull();
  process.env.INLINR_TOKEN = "in_d_from_the_environment_0000";
  expect(tokenSource(config)?.from).toBe("env");
  saveMachineToken(TOKEN);
  expect(tokenSource(config)).toEqual({ token: TOKEN, from: "machine" });
  expect(
    tokenSource({ ...config, deviceToken: "in_d_older_release_token_00" })
      ?.from,
  ).toBe("plugin");
  if (saved === undefined) delete process.env.INLINR_TOKEN;
  else process.env.INLINR_TOKEN = saved;
  saveMachineToken("");
  expect(machineToken()).toBe("");
});
