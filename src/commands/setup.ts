import { resolve } from "node:path";
import {
  installStandalone,
  removeClaudeCode,
  setupClaudeCode,
  setupCodex,
  setupGemini,
} from "../agents/setup";
import { claudeDir } from "./cloud";

/** The path of this script. */
export const self = () => resolve(process.argv[1] ?? "");

const NAMES = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
} as const;

/**
 * `setup claude-code` / `setup codex` / `setup gemini-cli`: run the sync
 * from that assistant's own hook. See agents/setup.ts. `setup claude-code
 * --remove` takes Claude Code's hooks out again.
 */
export function setup(tool: string | undefined, remove = false): number {
  if (tool !== "claude-code" && tool !== "codex" && tool !== "gemini-cli") {
    console.error(
      "  Usage: setup claude-code | setup codex | setup gemini-cli",
    );
    return 2;
  }
  if (remove) {
    if (tool !== "claude-code") {
      console.error("  --remove is for setup claude-code only.");
      return 2;
    }
    const removed = removeClaudeCode(claudeDir());
    console.log("");
    console.log(
      `  ${removed?.message ?? "No inlinr hook in Claude Code's settings."}`,
    );
    console.log("");
    return 0;
  }
  const script = installStandalone(self());
  const result =
    tool === "claude-code"
      ? setupClaudeCode(process.execPath, script, claudeDir())
      : tool === "codex"
        ? setupCodex(process.execPath, script)
        : setupGemini(process.execPath, script);
  console.log("");
  console.log(`  ${result.message}`);
  if (result.ok) {
    console.log(
      tool === "claude-code"
        ? "  Every Claude Code session on this machine now sends its time to inlinr, from the next one on."
        : `  ${NAMES[tool]} now sends its sessions to inlinr after each turn.`,
    );
  }
  console.log("");
  return result.ok ? 0 : 1;
}
