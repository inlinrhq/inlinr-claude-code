import {
  copyFileSync,
  existsSync,
  mkdirSync,
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
