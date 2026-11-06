import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configDir } from "../config";
import { codexHome, geminiHome } from "./sources";

/**
 * Running without Claude Code.
 *
 * The Claude Code plugin reads Codex and Gemini CLI sessions on every sync,
 * so someone who has it needs nothing more. Someone who only uses Codex or
 * Gemini CLI runs the same script from their assistant's own hook:
 *
 * - Codex runs the program in `notify` (`~/.codex/config.toml`) after each
 *   turn, with a JSON description of the turn as its last argument.
 * - Gemini CLI runs the commands under `hooks` in `~/.gemini/settings.json`,
 *   and waits for them: the hook hands the sync to a detached process and
 *   returns at once.
 *
 * The script is copied to `~/.inlinr/agents.js` first, so the hook does not
 * point into a download folder or a plugin cache that moves with each
 * release. The Claude Code plugin refreshes that copy when it is newer.
 */

export const standalonePath = () => join(configDir(), "agents.js");

/** The `VERSION` a bundle declares, or null. */
export function bundleVersion(source: string): string | null {
  return /VERSION = "(\d+\.\d+\.\d+)"/.exec(source)?.[1] ?? null;
}

/** Is version `a` older than `b`? Plain `x.y.z` only. */
export function older(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

/** Copy this script to `~/.inlinr/agents.js`. */
export function installStandalone(self: string): string {
  const target = standalonePath();
  mkdirSync(configDir(), { recursive: true });
  if (self !== target) copyFileSync(self, target);
  return target;
}

/**
 * Replace an older standalone copy with this build. Only an existing copy:
 * nothing is installed that `setup` did not ask for.
 */
export function refreshStandalone(self: string, version: string): void {
  const target = standalonePath();
  if (self === target || !existsSync(target)) return;
  const installed = bundleVersion(readFileSync(target, "utf8"));
  if (installed && !older(installed, version)) return;
  copyFileSync(self, target);
}

export type SetupResult = { ok: boolean; message: string };

/** Codex's `notify` line for this script. */
export function codexNotify(node: string, script: string): string {
  const argv = [node, script, "--from", "codex", "--detach"];
  return `notify = [${argv.map((a) => JSON.stringify(a)).join(", ")}]`;
}

/**
 * Add `notify` to Codex's config. A top-level key has to come before the
 * first table, so it goes on the first line. Codex takes a single `notify`
 * program: one that is already there is left alone.
 */
export function setupCodex(
  node: string,
  script: string,
  home = codexHome(),
): SetupResult {
  const path = join(home, "config.toml");
  let toml = "";
  try {
    toml = readFileSync(path, "utf8");
  } catch {
    // No config yet: this line starts it.
  }
  const line = codexNotify(node, script);
  const existing = /^\s*notify\s*=.*$/m.exec(toml);
  if (existing) {
    if (existing[0].includes("--from")) {
      writeFileSync(path, toml.replace(existing[0], line), "utf8");
      return { ok: true, message: `Updated notify in ${path}.` };
    }
    return {
      ok: false,
      message: `Codex already runs a program after each turn (notify in ${path}), and it takes only one. Run this from that program instead:\n\n     ${JSON.stringify(node)} ${JSON.stringify(script)} --from codex --detach`,
    };
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(path, `${line}\n${toml}`, "utf8");
  return { ok: true, message: `Added notify to ${path}.` };
}

type GeminiHook = {
  matcher?: string;
  hooks?: { name?: string; type?: string; command?: string }[];
};

const HOOK_NAME = "inlinr";

/** The hook groups Gemini CLI should run the sync from. */
export function geminiHooks(node: string, script: string): GeminiHook {
  return {
    hooks: [
      {
        name: HOOK_NAME,
        type: "command",
        // Quoted, not escaped: the shell reads it, and a Windows path keeps
        // its single backslashes.
        command: `"${node}" "${script}" --from gemini-cli --detach`,
      },
    ],
  };
}

/**
 * Add the hooks to Gemini CLI's settings: after each agent turn, and when a
 * session ends. A file it cannot parse (Gemini accepts comments) is left
 * alone, with what to add.
 */
export function setupGemini(
  node: string,
  script: string,
  home = geminiHome(),
): SetupResult {
  const path = join(home, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const hooks = {
        AfterAgent: [geminiHooks(node, script)],
        SessionEnd: [geminiHooks(node, script)],
      };
      return {
        ok: false,
        message: `Could not read ${path}. Add this under "hooks" yourself:\n\n${JSON.stringify(hooks, null, 2)}`,
      };
    }
  }
  const hooks =
    settings.hooks && typeof settings.hooks === "object"
      ? (settings.hooks as Record<string, GeminiHook[]>)
      : {};
  for (const event of ["AfterAgent", "SessionEnd"]) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    // An earlier setup's hook is replaced, not duplicated.
    const others = groups.filter(
      (g) => !g.hooks?.some((h) => h.name === HOOK_NAME),
    );
    hooks[event] = [...others, geminiHooks(node, script)];
  }
  settings.hooks = hooks;
  mkdirSync(home, { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { ok: true, message: `Added the hooks to ${path}.` };
}

/**
 * Claude Code itself.
 *
 * The plugin declares no hook: Anthropic's plugin directory refuses a plugin
 * whose hooks run a command on someone's machine without asking. So
 * `/inlinr:activate` asks, then `setup claude-code` writes the hooks into
 * the user's own `~/.claude/settings.json`, where they can see and remove
 * them. They run the standalone copy, like Codex's and Gemini CLI's.
 */

/** Marks our hooks in a settings file: the sync ignores the flag. */
const CLAUDE_MARK = "--from claude-code";

type ClaudeHook = {
  type?: string;
  command?: string;
  timeout?: number;
  async?: boolean;
};
type ClaudeGroup = { matcher?: string; hooks?: ClaudeHook[] };

/**
 * The events a sync runs on. The frequent ones are throttled: a sync is at
 * most every two minutes while the turn goes on, and in full when it ends.
 */
const CLAUDE_EVENTS: Record<string, boolean> = {
  SessionStart: false,
  UserPromptSubmit: true,
  PostToolUse: true,
  SubagentStop: true,
  PreCompact: false,
  Stop: false,
  SessionEnd: false,
};

/** The hook groups Claude Code should run the sync from, by event. */
export function claudeCodeHooks(
  node: string,
  script: string,
): Record<string, ClaudeGroup> {
  const base = `"${node}" "${script}" ${CLAUDE_MARK}`;
  return Object.fromEntries(
    Object.entries(CLAUDE_EVENTS).map(([event, throttled]) => [
      event,
      {
        hooks: [
          {
            type: "command",
            command: throttled ? `${base} --throttle 120` : base,
            timeout: 20,
            // A tracker never slows the turn it measures.
            async: true,
          },
        ],
      },
    ]),
  );
}

const ours = (h: ClaudeHook) => h.command?.includes(CLAUDE_MARK) ?? false;

/** The settings' hooks, with ours taken out; null when there were none. */
function withoutOurs(
  hooks: Record<string, ClaudeGroup[]>,
): Record<string, ClaudeGroup[]> | null {
  let found = false;
  const out: Record<string, ClaudeGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept: ClaudeGroup[] = [];
    for (const g of groups) {
      const list = Array.isArray(g.hooks) ? g.hooks : [];
      const rest = list.filter((h) => !ours(h));
      if (rest.length !== list.length) found = true;
      if (rest.length > 0 || list.length === 0)
        kept.push({ ...g, hooks: rest });
    }
    if (kept.length > 0) out[event] = kept;
  }
  return found ? out : null;
}

type Settings = { ok: true; value: Record<string, unknown> } | { ok: false };

function readSettings(path: string): Settings {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ok: true, value }
      : { ok: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: true, value: {} };
    return { ok: false };
  }
}

function hooksOf(settings: Record<string, unknown>) {
  return settings.hooks && typeof settings.hooks === "object"
    ? (settings.hooks as Record<string, ClaudeGroup[]>)
    : {};
}

/**
 * Add the hooks to `<claude home>/settings.json`, next to the user's own.
 * An earlier setup's hooks are replaced, not duplicated. A file that is not
 * plain JSON is left alone, with what to add.
 */
export function setupClaudeCode(
  node: string,
  script: string,
  home: string,
): SetupResult {
  const path = join(home, "settings.json");
  const wanted = claudeCodeHooks(node, script);
  const settings = readSettings(path);
  if (!settings.ok) {
    const block = Object.fromEntries(
      Object.entries(wanted).map(([e, g]) => [e, [g]]),
    );
    return {
      ok: false,
      message: `Could not read ${path}. Add this under "hooks" yourself:\n\n${JSON.stringify(block, null, 2)}`,
    };
  }
  const current = hooksOf(settings.value);
  const hooks = withoutOurs(current) ?? current;
  for (const [event, group] of Object.entries(wanted)) {
    hooks[event] = [
      ...(Array.isArray(hooks[event]) ? hooks[event] : []),
      group,
    ];
  }
  settings.value.hooks = hooks;
  mkdirSync(home, { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings.value, null, 2)}\n`, "utf8");
  return { ok: true, message: `Added inlinr's hooks to ${path}.` };
}

/** Take our hooks out of the settings. Null when there were none. */
export function removeClaudeCode(home: string): SetupResult | null {
  const path = join(home, "settings.json");
  const settings = readSettings(path);
  if (!settings.ok) return null;
  const hooks = withoutOurs(hooksOf(settings.value));
  if (!hooks) return null;
  if (Object.keys(hooks).length > 0) settings.value.hooks = hooks;
  else delete settings.value.hooks;
  writeFileSync(path, `${JSON.stringify(settings.value, null, 2)}\n`, "utf8");
  return { ok: true, message: `Removed inlinr's hooks from ${path}.` };
}

/** Does Claude Code run the sync from the user's settings? */
export function hasClaudeCodeHooks(home: string): boolean {
  const settings = readSettings(join(home, "settings.json"));
  return settings.ok && withoutOurs(hooksOf(settings.value)) !== null;
}

/**
 * The newest inlinr bundle Claude Code has installed as a plugin, from its
 * cache (`plugins/cache/<marketplace>/inlinr/<version>/`), or null.
 */
export function newestPluginBundle(
  home: string,
): { path: string; version: string } | null {
  const cache = join(home, "plugins", "cache");
  let best: { path: string; version: string } | null = null;
  for (const market of safeList(cache)) {
    const plugin = join(cache, market, "inlinr");
    for (const version of safeList(plugin)) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
      const path = join(plugin, version, "dist", "index.js");
      if (!existsSync(path)) continue;
      if (!best || older(best.version, version)) best = { path, version };
    }
  }
  return best;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Run from the settings' hook: the plugin updates in Claude Code's cache,
 * the hook runs the copy in `~/.inlinr`. Take the cache's build when it is
 * newer, so an update reaches the hook without running activate again.
 */
export function refreshFromPlugin(
  self: string,
  version: string,
  home: string,
): void {
  if (self !== standalonePath()) return;
  const newest = newestPluginBundle(home);
  if (!newest || !older(version, newest.version)) return;
  copyFileSync(newest.path, self);
}
