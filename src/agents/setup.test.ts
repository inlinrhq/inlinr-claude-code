import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundleVersion,
  hasClaudeCodeHooks,
  newestPluginBundle,
  older,
  removeClaudeCode,
  setupClaudeCode,
  setupCodex,
  setupGemini,
} from "./setup";

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

describe("setupClaudeCode", () => {
  const read = (home: string) =>
    JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));

  test("adds seven async hooks next to the user's own, once", () => {
    const home = dir();
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({
        model: "opus",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
        },
      }),
    );
    expect(setupClaudeCode("/bin/node", "/old.js", home).ok).toBe(true);
    expect(setupClaudeCode("/bin/node", "/s.js", home).ok).toBe(true);
    const settings = read(home);
    expect(settings.model).toBe("opus");
    expect(Object.keys(settings.hooks).sort()).toEqual(
      [
        "PostToolUse",
        "PreCompact",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "SubagentStop",
        "UserPromptSubmit",
      ].sort(),
    );
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("say done");
    expect(settings.hooks.Stop[1].hooks[0]).toEqual({
      type: "command",
      command: '"/bin/node" "/s.js" --from claude-code',
      timeout: 20,
      async: true,
    });
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe(
      '"/bin/node" "/s.js" --from claude-code --throttle 120',
    );
    expect(JSON.stringify(settings)).not.toContain("/old.js");
    expect(hasClaudeCodeHooks(home)).toBe(true);
  });

  test("starts a settings file that does not exist", () => {
    const home = join(dir(), "nested");
    expect(setupClaudeCode("/bin/node", "/s.js", home).ok).toBe(true);
    expect(read(home).hooks.SessionStart).toHaveLength(1);
  });

  test("leaves a file it cannot parse alone", () => {
    const home = dir();
    writeFileSync(join(home, "settings.json"), "{ // comment\n}");
    expect(setupClaudeCode("/bin/node", "/s.js", home).ok).toBe(false);
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(
      "{ // comment\n}",
    );
  });

  test("remove takes out only its own hooks", () => {
    const home = dir();
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
        },
      }),
    );
    setupClaudeCode("/bin/node", "/s.js", home);
    expect(removeClaudeCode(home)?.ok).toBe(true);
    expect(read(home)).toEqual({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
    });
    expect(removeClaudeCode(home)).toBeNull();
    expect(hasClaudeCodeHooks(home)).toBe(false);
  });

  test("remove drops the hooks key it emptied", () => {
    const home = dir();
    setupClaudeCode("/bin/node", "/s.js", home);
    removeClaudeCode(home);
    expect(read(home)).toEqual({});
  });
});

describe("newestPluginBundle", () => {
  test("picks the highest version of inlinr across marketplaces", () => {
    const home = dir();
    const put = (market: string, name: string, version: string) => {
      const d = join(home, "plugins", "cache", market, name, version, "dist");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "index.js"), `const VERSION = "${version}";`);
    };
    put("inlinr", "inlinr", "0.9.0");
    put("inlinr", "inlinr", "0.10.1");
    put("official", "inlinr", "0.9.5");
    put("official", "inlinr-cloud", "9.9.9");
    expect(newestPluginBundle(home)?.version).toBe("0.10.1");
    expect(newestPluginBundle(dir())).toBeNull();
  });
});
