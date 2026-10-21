import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isServersOrNetworks,
  reportError,
  reportsEnabled,
  scrubHome,
} from "./report";

describe("reportsEnabled", () => {
  it("is on by default", () => {
    expect(reportsEnabled({}, null)).toBe(true);
    expect(reportsEnabled({}, "[behavior]\ndeps_sync = true\n")).toBe(true);
  });

  it("follows the CLI's switch and Claude Code's own", () => {
    expect(reportsEnabled({}, "[behavior]\nerror_reports = false\n")).toBe(
      false,
    );
    expect(reportsEnabled({ INLINR_ERROR_REPORTS: "0" }, null)).toBe(false);
    expect(reportsEnabled({ DISABLE_ERROR_REPORTING: "1" }, null)).toBe(false);
    expect(
      reportsEnabled({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, null),
    ).toBe(false);
  });
});

describe("isServersOrNetworks", () => {
  it("leaves out an HTTP answer and a dead network", () => {
    const refused = Object.assign(new Error("ingest rejected a batch"), {
      status: 400,
    });
    expect(isServersOrNetworks(refused)).toBe(true);
    expect(isServersOrNetworks(new TypeError("fetch failed"))).toBe(true);
    expect(isServersOrNetworks(new Error("Unexpected token in JSON"))).toBe(
      false,
    );
  });
});

describe("scrubHome", () => {
  it("replaces the home folder", () => {
    expect(scrubHome("at /home/ana/.claude/x.js:1", "/home/ana")).toBe(
      "at ~/.claude/x.js:1",
    );
  });
});

describe("reportError", () => {
  it("sends once a day", async () => {
    const sent: string[] = [];
    let now = 1_800_000_000_000;
    const opts = {
      apiUrl: "https://inlinr.test",
      version: "0.3.1",
      enabled: true,
      statePath: join(mkdtempSync(join(tmpdir(), "inlinr-")), "sent.json"),
      send: async (url: string, body: string) => {
        expect(url).toBe("https://inlinr.test/api/v1/plugin-errors");
        sent.push(body);
      },
      now: () => now,
    };
    const err = new Error(
      "Cannot read properties of undefined (reading 'usage')",
    );
    await reportError("sync", err, opts);
    await reportError("sync", err, opts);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({
      source: "claude-code",
      version: "claude-code-inlinr/0.3.1",
      context: "sync",
    });

    await reportError("sync", err, { ...opts, enabled: false });
    now += 25 * 60 * 60 * 1000;
    await reportError("sync", err, opts);
    expect(sent).toHaveLength(2);
  });
});
