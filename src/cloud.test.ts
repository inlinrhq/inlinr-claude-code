import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudSession, companionInstalled } from "./commands/cloud";

const SID = "7F340819-9c47-5753-86be-5427af8f0e22";

describe("cloudSession", () => {
  test("is the session id in a cloud session", () => {
    expect(
      cloudSession({ CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_SESSION_ID: SID }),
    ).toBe(SID.toLowerCase());
  });

  test("is null on a laptop, or without a valid id", () => {
    expect(cloudSession({ CLAUDE_CODE_SESSION_ID: SID })).toBeNull();
    expect(
      cloudSession({ CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_SESSION_ID: "x" }),
    ).toBeNull();
    expect(cloudSession({ CLAUDE_CODE_REMOTE: "true" })).toBeNull();
  });
});

describe("companionInstalled", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "inlinr-claude-"));

  test("is false with no plugin at all", () => {
    expect(companionInstalled(dir())).toBe(false);
  });

  test("finds it installed from a marketplace", () => {
    const d = dir();
    mkdirSync(join(d, "plugins"));
    writeFileSync(
      join(d, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "inlinr-cloud@inlinr": [{}] } }),
    );
    expect(companionInstalled(d)).toBe(true);
  });

  test("finds it synced from the account, by its manifest's name", () => {
    const d = dir();
    const p = join(
      d,
      "plugins",
      "synced",
      "bucket",
      "a028f8c7",
      ".claude-plugin",
    );
    mkdirSync(p, { recursive: true });
    writeFileSync(
      join(p, "plugin.json"),
      JSON.stringify({ name: "inlinr-cloud" }),
    );
    expect(companionInstalled(d)).toBe(true);
  });

  test("ignores the main plugin", () => {
    const d = dir();
    mkdirSync(join(d, "plugins"));
    writeFileSync(
      join(d, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "inlinr@inlinr": [{}] } }),
    );
    expect(companionInstalled(d)).toBe(false);
  });
});
