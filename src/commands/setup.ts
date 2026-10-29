import { resolve } from "node:path";
import { installStandalone, setupCodex, setupGemini } from "../agents/setup";

/** The path of this script. */
export const self = () => resolve(process.argv[1] ?? "");

/**
 * `setup codex` / `setup gemini-cli`: run the sync from that assistant's own
 * hook, for a machine without Claude Code. See agents/setup.ts.
 */
export function setup(tool: string | undefined): number {
  if (tool !== "codex" && tool !== "gemini-cli") {
    console.error("  Usage: setup codex | setup gemini-cli");
    return 2;
  }
  const script = installStandalone(self());
  const result =
    tool === "codex"
      ? setupCodex(process.execPath, script)
      : setupGemini(process.execPath, script);
  console.log("");
  console.log(`  ${result.message}`);
  if (result.ok) {
    console.log(
      `  ${tool === "codex" ? "Codex" : "Gemini CLI"} now sends its sessions to inlinr after each turn.`,
    );
  }
  console.log("");
  return result.ok ? 0 : 1;
}
