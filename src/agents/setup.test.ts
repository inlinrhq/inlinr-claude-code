import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleVersion, older, setupCodex, setupGemini } from "./setup";

const dir = () => mkdtempSync(join(tmpdir(), "inlinr-setup-"));

describe("setupCodex", () => {
  test("puts notify before the first table", () => {
    const home = dir();
    writeFileSync(join(home, "config.toml"), '[profiles.x]\nmodel = "o"\n');
    expect(setupCodex("/bin/node", "/h/.inlinr/agents.js", home).ok).toBe(true);
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    expect(toml.split("\n")[0]).toBe(
      'notify = ["/bin/node", "/h/.inlinr/agents.js", "--from", "codex", "--detach"]',
    );
    expect(toml).toContain("[profiles.x]");
  });

  test("leaves someone else's notify alone", () => {
    const home = dir();
    writeFileSync(join(home, "config.toml"), 'notify = ["say", "done"]\n');
    const result = setupCodex("/bin/node", "/s.js", home);
    expect(result.ok).toBe(false);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(
      'notify = ["say", "done"]\n',
    );
  });

  test("replaces its own notify on a second run", () => {
    const home = dir();
    setupCodex("/bin/node", "/old.js", home);
    setupCodex("/bin/node", "/new.js", home);
    const toml = readFileSync(join(home, "config.toml"), "utf8");
    expect(toml.match(/notify/g)).toHaveLength(1);
    expect(toml).toContain("/new.js");
  });
});

describe("setupGemini", () => {
  test("adds the hooks next to the user's own, once", () => {
    const home = dir();
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({
        theme: "dark",
        hooks: { AfterAgent: [{ hooks: [{ type: "command", command: "x" }] }] },
      }),
    );
    setupGemini("/bin/node", "/s.js", home);
    setupGemini("/bin/node", "/s.js", home);
    const settings = JSON.parse(
      readFileSync(join(home, "settings.json"), "utf8"),
    );
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.AfterAgent).toHaveLength(2);
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(settings.hooks.SessionEnd[0].hooks[0].command).toBe(
      '"/bin/node" "/s.js" --from gemini-cli --detach',
    );
  });

  test("leaves a file it cannot parse alone", () => {
    const home = dir();
    writeFileSync(join(home, "settings.json"), "{ // comment\n}");
    expect(setupGemini("/bin/node", "/s.js", home).ok).toBe(false);
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(
      "{ // comment\n}",
    );
  });
});

describe("versions", () => {
  test("reads a bundle's version and compares", () => {
    expect(bundleVersion('var VERSION = "0.6.0";')).toBe("0.6.0");
    expect(older("0.5.9", "0.6.0")).toBe(true);
    expect(older("0.6.0", "0.6.0")).toBe(false);
    expect(older("1.0.0", "0.9.9")).toBe(false);
  });
});
